/**
 * P5 operations: read-only queries and confirmed mutations, plus helpers.
 *
 * P5 concepts (as explained to the operator):
 *  - pool:   a named collection of labeled tapes/disks that jobs write into.
 *  - volume: one piece of media (tape, disk container) labeled for a pool.
 *  - plan:   a backup configuration grouping tasks (what to back up) and
 *            events (when, into which pool).
 *  - event:  one schedule entry of a plan: frequency + pool + backup level.
 *  - job:    one execution of a plan/task, tracked by an id with a report.
 *
 * Each operation runs its nsdchat queries in ONE batched interactive session
 * (P5's sshd drops connections when hammered), so operations are sequential
 * awaits of chatBatch calls.
 */

import type { ArchiwareConfig } from "./config.js";
import {
  buildRemoteCommand,
  describeRemote,
  p5Exec,
  shellQuote,
  chatBatch,
  hostCommand,
  jobLogBlock,
  mtxStatus,
  nsdchat,
  P5Error,
  parseTclList,
  rawBatch,
  type ChatRequest,
  type ChatResult,
  nsdchatLong,
} from "./transport.js";

const JOB_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** P5 reports sizes in kbytes. */
export function kbToHuman(kb: number): string {
  if (!Number.isFinite(kb) || kb <= 0) return "0 B";
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = kb;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** Posix seconds -> ISO date string. 0 means "not set". */
export function posixToIso(seconds: string | null): string | null {
  if (!seconds) return null;
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

/** Time zone of this machine (override with TZ). */
export const localTz = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Posix seconds -> "YYYY-MM-DD HH:MM" in the local time zone. */
export function posixToLocal(seconds: string | null, tz = localTz()): string | null {
  const iso = posixToIso(seconds);
  if (!iso) return null;
  return new Intl.DateTimeFormat("sv-SE", { timeZone: tz, dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
}

/** Parse a Tcl list result into elements; null -> []. */
function names(v: ChatResult): string[] {
  if (Array.isArray(v)) return v;
  return typeof v === "string" ? parseTclList(v) : [];
}
/** Result as string or null. */
function str(v: ChatResult): string | null {
  return typeof v === "string" ? v : null;
}

async function batch(cfg: ArchiwareConfig, requests: ChatRequest[], timeoutMs = cfg.timeoutMs): Promise<ChatResult[]> {
  return chatBatch(cfg, requests, timeoutMs);
}

export interface VolumeInfo {
  id: string;
  label: string | null;
  barcode: string | null;
  mediatype: string | null;
  location: string | null;
  mode: string | null;
  state: string | null;
  usage: string | null;
  pool: string | null;
  usedsize_kb: number;
  totalsize_kb: number;
  usedsize_human: string;
  totalsize_human: string;
  dateexpires: string | null;
}

function volumeInfoFrom(id: string, pool: string | null, r: ChatResult[]): VolumeInfo {
  const total = Number(str(r[7]) ?? 0);
  const used = Number(str(r[8]) ?? 0);
  return {
    id,
    label: str(r[0]),
    barcode: str(r[1]),
    mediatype: str(r[2]),
    location: str(r[3]),
    mode: str(r[4]),
    state: str(r[5]),
    usage: str(r[6]),
    pool,
    usedsize_kb: used,
    totalsize_kb: total,
    usedsize_human: kbToHuman(used),
    totalsize_human: total > 0 ? kbToHuman(total) : "unknown",
    dateexpires: posixToIso(str(r[9])),
  };
}

const volumeAttrs = (id: string): ChatRequest[] => [
  { args: ["Volume", id, "label"] },
  { args: ["Volume", id, "barcode"] },
  { args: ["Volume", id, "mediatype"] },
  { args: ["Volume", id, "location"] },
  { args: ["Volume", id, "mode"] },
  { args: ["Volume", id, "state"] },
  { args: ["Volume", id, "usage"] },
  { args: ["Volume", id, "totalsize"] },
  { args: ["Volume", id, "usedsize"] },
  { args: ["Volume", id, "dateexpires"] },
];

/** Parse `sudo -n mtx -f <dev> status` output. */
export interface MtxSlot {
  slot: number;
  barcode: string | null;
  full: boolean;
  importExport: boolean;
}
export interface MtxDrive {
  drive: number;
  full: boolean;
  loadedFromSlot: number | null;
  barcode: string | null;
}
export interface MtxStatus {
  drives: number;
  slots: number;
  importExport: number;
  driveStates: MtxDrive[];
  slotStates: MtxSlot[];
}

export function parseMtx(status: string): MtxStatus {
  const result: MtxStatus = { drives: 0, slots: 0, importExport: 0, driveStates: [], slotStates: [] };
  const header = status.match(/Storage Changer .*?:(\d+) Drives,\s*(\d+) Slots\s*\(\s*(\d+) Import\/Export\s*\)/);
  if (header) {
    result.drives = Number(header[1]);
    result.slots = Number(header[2]);
    result.importExport = Number(header[3]);
  }
  for (const line of status.split("\n")) {
    const dte = line.match(/Data Transfer Element (\d+):(Full \(Storage Element (\d+) Loaded\):VolumeTag = (\S+)|Empty)/);
    if (dte) {
      result.driveStates.push({
        drive: Number(dte[1]),
        full: dte[2]?.startsWith("Full") ?? false,
        loadedFromSlot: dte[3] ? Number(dte[3]) : null,
        barcode: dte[4] ?? null,
      });
      continue;
    }
    const se = line.match(/Storage Element (\d+)( IMPORT\/EXPORT)?:\s*(Full|Empty)\s*(:VolumeTag\s*=\s*(\S+))?/);
    if (se) {
      result.slotStates.push({
        slot: Number(se[1]),
        barcode: se[5] ?? null,
        full: se[3] === "Full",
        importExport: Boolean(se[2]),
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Read-only operations
// ---------------------------------------------------------------------------

export async function status(cfg: ArchiwareConfig) {
  // One batch: header, then per pool 5 attrs, then per job 3 attrs.
  const first = await batch(cfg, [
    { args: ["srvinfo", "lexxvers"] },
    { args: ["Device", "names"], names: true },
    { args: ["Jukebox", "names"], names: true },
    { args: ["Pool", "names"], names: true },
    { args: ["Job", "running"], names: true },
    { args: ["Job", "pending"], names: true },
  ]);
  const version = str(first[0]);
  const devices = names(first[1]);
  const jukeboxes = names(first[2]);
  const poolNames = names(first[3]);
  const jobIds = [...new Set([...names(first[4]), ...names(first[5])])];

  const rest = await batch(cfg, [
    ...poolNames.flatMap((name) => [
      { args: ["Pool", name, "usage"] },
      { args: ["Pool", name, "mediatype"] },
      { args: ["Pool", name, "totalsize"] },
      { args: ["Pool", name, "usedsize"] },
    ]),
    ...jobIds.flatMap((id) => [
      { args: ["Job", id, "status"] },
      { args: ["Job", id, "label"] },
      { args: ["Job", id, "resourcename"] },
    ]),
  ]);
  const pools = poolNames.map((name, i) => {
    const total = Number(str(rest[i * 4 + 2]) ?? 0);
    const used = Number(str(rest[i * 4 + 3]) ?? 0);
    return {
      name,
      usage: str(rest[i * 4]),
      mediatype: str(rest[i * 4 + 1]),
      usedsize_kb: used,
      totalsize_kb: total,
      usedsize_human: kbToHuman(used),
      totalsize_human: total > 0 ? kbToHuman(total) : "unlimited/unknown",
      usedPercent: total > 0 ? Math.round((used / total) * 100) : null,
    };
  });
  const jobs = jobIds.map((id, i) => ({
    id,
    status: str(rest[poolNames.length * 4 + i * 3]),
    label: str(rest[poolNames.length * 4 + i * 3 + 1]),
    resource: str(rest[poolNames.length * 4 + i * 3 + 2]),
  }));

  return { server: { version }, devices, jukeboxes, pools, jobs };
}

/** Barcode (upper-case) -> volume info, for slot matching. */
export function indexVolumesByBarcode(vols: VolumeInfo[]): Map<string, VolumeInfo> {
  const m = new Map<string, VolumeInfo>();
  for (const v of vols) if (v.barcode) m.set(v.barcode.toUpperCase(), v);
  return m;
}

export async function slots(cfg: ArchiwareConfig) {
  const jbRes = await batch(cfg, [
    { args: ["Jukebox", "names"], names: true },
    { args: ["Pool", "names"], names: true },
  ]);
  const jukeboxes = names(jbRes[0]);
  const poolNames = names(jbRes[1]);
  const jb = jukeboxes[0] ?? cfg.changer;

  const mtx = parseMtx(await mtxStatus(cfg));

  const slotcount = Number(str((await batch(cfg, [{ args: ["Jukebox", jb, "slotcount"] }]))[0]) ?? 0);

  // Match on barcode, not on P5's location string: volumes whose location is
  // "<jukebox> : Drive N::Slot M" (loaded or previously loaded) are still known.
  const allVolumes = await volumes(cfg);
  const infoByBarcode = indexVolumesByBarcode(allVolumes);

  const rows = mtx.slotStates.map((s) => {
    const info = s.barcode ? infoByBarcode.get(s.barcode.toUpperCase()) : undefined;
    const known = Boolean(info);
    const loaded = mtx.driveStates.some((d) => d.full && d.loadedFromSlot === s.slot);
    return {
      slot: s.slot,
      barcode: s.barcode,
      full: s.full,
      importExport: s.importExport,
      loadedInDrive: loaded,
      p5Volume: info?.id ?? null,
      label: info?.label ?? null,
      pool: info?.pool ?? null,
      mode: info?.mode ?? null,
      state: info?.state ?? null,
      unknownToP5: !known,
    };
  });
  const drives = mtx.driveStates.map((d) => ({
    drive: d.drive,
    full: d.full,
    loadedFromSlot: d.loadedFromSlot,
    barcode: d.barcode,
  }));
  return { jukebox: jb, slotcount, drives, slots: rows };
}

export async function volumes(cfg: ArchiwareConfig) {
  const first = await batch(cfg, [
    { args: ["Volume", "names"], names: true },
    { args: ["Pool", "names"], names: true },
  ]);
  const ids = names(first[0]);
  const poolNames = names(first[1]);
  const poolVolRes = poolNames.length
    ? await batch(cfg, poolNames.map((p) => ({ args: ["Pool", p, "volumes"], names: true })))
    : [];
  const poolByVolume = new Map<string, string>();
  poolNames.forEach((p, i) => {
    for (const v of names(poolVolRes[i])) poolByVolume.set(v, p);
  });
  const volRes = ids.length ? await batch(cfg, ids.flatMap((id) => volumeAttrs(id))) : [];
  return ids.map((id, i) => volumeInfoFrom(id, poolByVolume.get(id) ?? null, volRes.slice(i * 10, i * 10 + 10)));
}

export async function pools(cfg: ArchiwareConfig) {
  const poolNames = names((await batch(cfg, [{ args: ["Pool", "names"], names: true }]))[0]);
  if (poolNames.length === 0) return [];
  const res = await batch(
    cfg,
    poolNames.flatMap((name) => [
      { args: ["Pool", name, "mediatype"] },
      { args: ["Pool", name, "usage"] },
      { args: ["Pool", name, "volumes"], names: true },
      { args: ["Pool", name, "totalsize"] },
      { args: ["Pool", name, "usedsize"] },
    ]),
  );
  return poolNames.map((name, i) => {
    const total = Number(str(res[i * 5 + 3]) ?? 0);
    const used = Number(str(res[i * 5 + 4]) ?? 0);
    return {
      name,
      mediatype: str(res[i * 5]),
      usage: str(res[i * 5 + 1]),
      volumes: names(res[i * 5 + 2]),
      usedsize_kb: used,
      totalsize_kb: total,
      usedsize_human: kbToHuman(used),
      totalsize_human: total > 0 ? kbToHuman(total) : "unlimited/unknown",
      usedPercent: total > 0 ? Math.round((used / total) * 100) : null,
    };
  });
}

async function planSummary(cfg: ArchiwareConfig, id: string) {
  const r = await batch(cfg, [
    { args: ["BackupPlan", id, "describe"] },
    { args: ["BackupPlan", id, "enabled"] },
    { args: ["BackupPlan", id, "eventnames"], names: true },
    { args: ["BackupPlan", id, "tasknames"], names: true },
  ]);
  return { id, describe: str(r[0]), enabled: str(r[1]) === "1", eventnames: names(r[2]), tasknames: names(r[3]) };
}

export async function plans(cfg: ArchiwareConfig) {
  const first = await batch(cfg, [
    { args: ["BackupPlan", "names"], names: true },
    { args: ["ArchivePlan", "names"], names: true },
  ]);
  const backup = names(first[0]);
  const archive = names(first[1]);
  const backupPlans: Record<string, unknown>[] = [];
  for (const id of backup) backupPlans.push(await planSummary(cfg, id));
  const archivePlans: Record<string, unknown>[] = [];
  for (const id of archive) {
    const r = await batch(cfg, [
      { args: ["ArchivePlan", id, "describe"] },
      { args: ["ArchivePlan", id, "enabled"] },
    ]);
    archivePlans.push({ id, describe: str(r[0]), enabled: str(r[1]) === "1" });
  }
  return { backupPlans, archivePlans };
}

export async function plan(cfg: ArchiwareConfig, id: string) {
  const summary = await planSummary(cfg, id);
  const evReq: ChatRequest[] = summary.eventnames.flatMap((name) => [
    { args: ["CalendarEvent", name, "pool"] },
    { args: ["CalendarEvent", name, "level"] },
    { args: ["CalendarEvent", name, "frequency"] },
    { args: ["CalendarEvent", name, "exception"] },
    { args: ["CalendarEvent", name, "firstrun"] },
    { args: ["CalendarEvent", name, "duration"] },
  ]);
  const evRes = evReq.length ? await batch(cfg, evReq) : [];
  const events = summary.eventnames.map((name, i) => ({
    name,
    pool: str(evRes[i * 6]),
    level: str(evRes[i * 6 + 1]), // 1 = full, 0 = incremental, -1 = synthetic
    frequency: str(evRes[i * 6 + 2]),
    exception: str(evRes[i * 6 + 3]),
    firstrun: posixToIso(str(evRes[i * 6 + 4])),
    firstrun_local: posixToLocal(str(evRes[i * 6 + 4])),
    duration_hours: str(evRes[i * 6 + 5]),
  }));

  const tkReq: ChatRequest[] = summary.tasknames.flatMap((name) => [
    { args: ["BackupTask", name, "client"] },
    { args: ["BackupTask", name, "dirlist"] },
    { args: ["BackupTask", name, "enabled"] },
    { args: ["BackupTask", name, "crossmounts"] },
    { args: ["BackupTask", name, "prescript"] },
    { args: ["BackupTask", name, "postscript"] },
  ]);
  const tkRes = tkReq.length ? await batch(cfg, tkReq) : [];
  const tasks = summary.tasknames.map((name, i) => ({
    name,
    client: str(tkRes[i * 6]),
    directories: splitDirlist(str(tkRes[i * 6 + 1])),
    enabled: str(tkRes[i * 6 + 2]) === "1",
    crossmounts: str(tkRes[i * 6 + 3]) === "1",
    prescript: str(tkRes[i * 6 + 4]),
    postscript: str(tkRes[i * 6 + 5]),
  }));

  const opt = await batch(cfg, [
    { args: ["BackupPlan", id, "retention"] },
    { args: ["BackupPlan", id, "loglevel"] },
    { args: ["BackupPlan", id, "stophours"] },
    { args: ["BackupPlan", id, "progressive"] },
    { args: ["BackupPlan", id, "canceltime"] },
    { args: ["BackupPlan", id, "startnewvol"] },
  ]);
  return {
    ...summary,
    retention_days: str(opt[0]),
    loglevel: str(opt[1]),
    stophours: str(opt[2]),
    progressive: str(opt[3]) === "1",
    canceltime_hours: str(opt[4]),
    startnewvol: str(opt[5]) === "1",
    events,
    tasks,
  };
}

/** Dirlist is a Tcl list; elements with spaces are brace-quoted. */
export function splitDirlist(dirlist: string | null): string[] {
  return parseTclList(dirlist);
}

export async function jobs(cfg: ArchiwareConfig, all = false) {
  const first = await batch(cfg, [
    { args: ["Job", "running"], names: true },
    { args: ["Job", "pending"], names: true },
    { args: ["Job", "names"], names: true },
  ], JOB_TIMEOUT_MS);
  const running = names(first[0]);
  const pending = names(first[1]);
  const scheduled = names(first[2]);
  let ids: string[];
  if (all) {
    const completed = names((await batch(cfg, [{ args: ["Job", "completed", "7"], names: true }], JOB_TIMEOUT_MS))[0]);
    ids = [...new Set([...scheduled, ...completed])];
  } else {
    ids = [...new Set([...running, ...pending, ...scheduled])];
  }
  // Reports are multi-line: one batch per job, report fetched separately.
  const rows: Record<string, unknown>[] = [];
  for (const id of ids) {
    const s = await batch(cfg, [
      { args: ["Job", id, "label"] },
      { args: ["Job", id, "status"] },
      { args: ["Job", id, "completion"] },
    ], JOB_TIMEOUT_MS);
    const report = str((await rawBatch(cfg, [["Job", id, "report"]], JOB_TIMEOUT_MS))[0]);
    rows.push({
      id,
      label: str(s[0]),
      status: str(s[1]),
      completion: str(s[2]),
      report_last_lines: report ? report.split("\n").slice(-10).join("\n") : null,
    });
  }
  return rows;
}

export async function job(cfg: ArchiwareConfig, id: string) {
  const r = await batch(cfg, [
    { args: ["Job", id, "label"] },
    { args: ["Job", id, "status"] },
    { args: ["Job", id, "completion"] },
    { args: ["Job", id, "describe"] },
    { args: ["Job", id, "resourcegroup"] },
    { args: ["Job", id, "resourcename"] },
    { args: ["Job", id, "runat"] },
    { args: ["Job", id, "totalkbytes"] },
    { args: ["Job", id, "totalfiles"] },
  ], JOB_TIMEOUT_MS);
  // report and protocol are multi-line: fetched as raw results.
  const r2 = await rawBatch(cfg, [["Job", id, "report"], ["Job", id, "protocol"]], JOB_TIMEOUT_MS);
  const logBlock = r2[0] ? null : await jobLogBlock(cfg, id, cfg.logPath);
  const totalkbytes = str(r[7]);
  const totalfiles = str(r[8]);
  return {
    id,
    label: str(r[0]),
    status: str(r[1]),
    completion: str(r[2]),
    describe: str(r[3]),
    resourcegroup: str(r[4]),
    resourcename: str(r[5]),
    runat: posixToIso(str(r[6])),
    totalkbytes: totalkbytes ? Number(totalkbytes) : null,
    totalkbytes_human: totalkbytes ? kbToHuman(Number(totalkbytes)) : null,
    totalfiles: totalfiles ? Number(totalfiles) : null,
    report: r2[0] ?? logBlock,
    protocol: r2[1] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Mutating operations (all require confirm; dryrun is safe)
// ---------------------------------------------------------------------------

export interface WouldRun {
  wouldRun: string;
  note: string;
}

function describeCmd(cfg: ArchiwareConfig, args: string[]): string {
  return describeRemote(cfg, buildRemoteCommand(cfg, args));
}

/** Mutating call: without confirm only report the command that WOULD run. */
export async function mutate(cfg: ArchiwareConfig, args: string[], confirm: boolean, note: string) {
  if (!confirm) {
    const would: WouldRun = { wouldRun: describeCmd(cfg, args), note };
    return { confirmationRequired: true as const, ...would };
  }
  const result = await nsdchat(cfg, args);
  return { confirmationRequired: false as const, result: result === "" ? null : result };
}

/** Multi-step mutation: without confirm, list every call that WOULD run (<...> = value from an earlier step). */
export function wouldRunSteps(cfg: ArchiwareConfig, steps: string[][], note: string) {
  return { confirmationRequired: true as const, wouldRun: steps.map((a) => describeCmd(cfg, a)), note };
}

export const dryrunPlan = (cfg: ArchiwareConfig, id: string) =>
  nsdchat(cfg, ["BackupPlan", id, "dryrun"]).then((result) => ({ plan: id, jobs: result === "" ? null : result }));

export const startPlan = (cfg: ArchiwareConfig, id: string, confirm: boolean) =>
  mutate(cfg, ["BackupPlan", id, "startnow"], confirm, "Starts a backup job for this plan now.");

export const enablePlan = (cfg: ArchiwareConfig, id: string, confirm: boolean) =>
  mutate(cfg, ["BackupPlan", id, "enable"], confirm, "Enables the plan (scheduler will run its events).");

export const disablePlan = (cfg: ArchiwareConfig, id: string, confirm: boolean) =>
  mutate(cfg, ["BackupPlan", id, "disable"], confirm, "Disables the plan (no scheduled runs until re-enabled).");

export const stopJob = (cfg: ArchiwareConfig, id: string, confirm: boolean) =>
  mutate(cfg, ["Job", id, "stop"], confirm, "Stops a scheduled (not running) job; running jobs must be canceled via nsdchat passthrough.");

export const setCleaning = (cfg: ArchiwareConfig, device: string, value: string, confirm: boolean) => {
  if (value !== "0" && value !== "1") throw new P5Error("cleaning value must be 0 or 1");
  return mutate(cfg, ["Device", device, "cleaning", value], confirm, `Sets the cleaning flag of device ${device} to ${value} (P5 avoids drives flagged 1 when picking a drive).`);
};

/** nsdchat call sequences (task = "<new task>" placeholder or real id). */
export function addFolderCalls(task: string, path: string, filter?: string): string[][] {
  const calls = [
    ["BackupTask", task, "client", "localhost"],
    ["BackupTask", task, "dirlist", path],
    ["BackupTask", task, "enable"],
  ];
  if (filter) calls.push(["BackupTask", task, "filter", filter]);
  return calls;
}

/** New P5 tasks are created DISABLED: enable and verify, else throw. */
async function addOneFolder(cfg: ArchiwareConfig, planId: string, path: string, filter?: string): Promise<string> {
  const task = (await nsdchat(cfg, ["BackupPlan", planId, "addtask"])).trim();
  if (!task) throw new P5Error(`BackupPlan ${planId} addtask returned no task name`);
  for (const c of addFolderCalls(task, path, filter)) await nsdchat(cfg, c);
  const en = (await nsdchat(cfg, ["BackupTask", task, "enabled"])).trim();
  if (en !== "1") throw new P5Error(`task ${task} of plan ${planId} is not enabled after enable (enabled=${en})`);
  return task;
}

/**
 * "Add folder to plan": setting several dirlist entries in one call wraps them
 * into ONE list element, so each folder is its own task:
 * addtask -> client localhost -> dirlist <single path> -> enable (verified).
 */
export async function addPlanFolder(cfg: ArchiwareConfig, planId: string, path: string, confirm: boolean) {
  const note = `Adds a new enabled task to plan ${planId} backing up the single folder ${path} on client localhost.`;
  if (!confirm) {
    return wouldRunSteps(cfg, [["BackupPlan", planId, "addtask"], ...addFolderCalls("<new task>", path), ["BackupTask", "<new task>", "enabled"]], note);
  }
  const task = await addOneFolder(cfg, planId, path);
  return { confirmationRequired: false as const, plan: planId, task, path, enabled: true };
}

/** Several folders; each path checked with `test -d` inside the container first. Per-path task id or error. */
export async function addPlanFolders(cfg: ArchiwareConfig, planId: string, paths: string[], filter: string | undefined, confirm: boolean) {
  const note = `Adds one enabled task per folder to plan ${planId} (client localhost${filter ? `, filter ${filter}` : ""}); each path must exist in the container.`;
  if (!confirm) {
    return wouldRunSteps(
      cfg,
      paths.flatMap((p) => [p5Exec(cfg, ["test", "-d", p]), ["BackupPlan", planId, "addtask"], ...addFolderCalls("<new task>", p, filter), ["BackupTask", "<new task>", "enabled"]]),
      note,
    );
  }
  const results: { path: string; task?: string; error?: string }[] = [];
  for (const path of paths) {
    try {
      const r = await hostCommand(cfg, p5Exec(cfg, ["test", "-d", path]));
      if (r.rc !== 0) throw new P5Error(`not a directory on the P5 server: ${path}`);
      results.push({ path, task: await addOneFolder(cfg, planId, path, filter) });
    } catch (e) {
      results.push({ path, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { confirmationRequired: false as const, plan: planId, results };
}

export function createPlanCalls(name: string, retentionDays?: number): string[][] {
  const c = [["BackupPlan", "create", name]];
  if (retentionDays !== undefined) c.push(["BackupPlan", "<new plan>", "retention", String(retentionDays)]);
  return c;
}

function checkDays(days: number) {
  if (!Number.isInteger(days) || days < 0) throw new P5Error("retention days must be a non-negative integer");
}

export async function createPlan(cfg: ArchiwareConfig, name: string, retentionDays: number | undefined, confirm: boolean) {
  if (retentionDays !== undefined) checkDays(retentionDays);
  if (!confirm) return wouldRunSteps(cfg, createPlanCalls(name, retentionDays), `Creates backup plan ${name}.`);
  const id = (await nsdchat(cfg, ["BackupPlan", "create", name])).trim();
  if (!id) throw new P5Error(`BackupPlan create ${name} returned no plan id`);
  if (retentionDays !== undefined) await nsdchat(cfg, ["BackupPlan", id, "retention", String(retentionDays)]);
  return { confirmationRequired: false as const, plan: id, name, retentionDays: retentionDays ?? null };
}

export const setPlanRetention = (cfg: ArchiwareConfig, plan: string, days: number, confirm: boolean) => {
  checkDays(days);
  return mutate(cfg, ["BackupPlan", plan, "retention", String(days)], confirm, `Sets retention of plan ${plan} to ${days} days.`);
};

/** P5 answers a successful plan delete with exit 100 (object gone); verify via the plan list instead. */
export async function deletePlan(cfg: ArchiwareConfig, plan: string, confirm: boolean) {
  if (!confirm) return mutate(cfg, ["BackupPlan", plan, "delete"], false, `Deletes backup plan ${plan}.`);
  try {
    await nsdchat(cfg, ["BackupPlan", plan, "delete"]);
  } catch (e) {
    if (!(e instanceof P5Error) || !/exit 100\b/.test(e.message)) throw e;
  }
  const remaining = parseTclList(await nsdchat(cfg, ["BackupPlan", "names"]));
  if (remaining.includes(plan)) throw new P5Error(`plan ${plan} still exists after delete`);
  return { confirmationRequired: false as const, plan, deleted: true };
}

export const volumeEnable = (cfg: ArchiwareConfig, volume: string, enabled: boolean, confirm: boolean) =>
  mutate(cfg, ["Volume", volume, enabled ? "enable" : "disable"], confirm, `${enabled ? "Enables" : "Disables"} volume ${volume}.`);

/** Offset (ms) of `tz` from UTC at the UTC instant `utcMs`. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(utcMs))
      .map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** ISO local time ("2026-11-07T02:00" or "2026-11-07 02:00") in tz -> posix seconds. */
export function isoLocalToPosix(iso: string, tz = localTz()): number {
  const m = iso.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw new P5Error(`invalid local time "${iso}", expected YYYY-MM-DDTHH:MM`);
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  let utc = naive - tzOffsetMs(naive, tz);
  utc = naive - tzOffsetMs(utc, tz);
  return Math.round(utc / 1000);
}

/**
 * Create one calendar event on a plan. `newevent` returns a garbage internal
 * name, so the eventnames are read before and after and the new one is the diff.
 */
export async function planEvent(
  cfg: ArchiwareConfig,
  planId: string,
  pool: string,
  level: string,
  frequency: string[],
  firstrunIso: string,
  confirm: boolean,
  exception: string[] = [],
) {
  const firstrun = String(isoLocalToPosix(firstrunIso));
  const note = `Adds an event to plan ${planId}: pool ${pool}, level ${level}, frequency "${frequency.join(" ")}"${exception.length ? `, exception "${exception.join(" ")}"` : ""}, first run ${firstrunIso} (the local time zone = ${firstrun}).`;
  const ev = "<new event>";
  const steps: string[][] = [
    ["BackupPlan", planId, "newevent", pool],
    ["CalendarEvent", ev, "level", level],
    ["CalendarEvent", ev, "frequency", ...frequency],
    ...(exception.length ? [["CalendarEvent", ev, "exception", ...exception]] : []),
    ["CalendarEvent", ev, "firstrun", firstrun],
  ];
  if (!confirm) return wouldRunSteps(cfg, steps, note);
  const before = new Set(names((await batch(cfg, [{ args: ["BackupPlan", planId, "eventnames"], names: true }]))[0]));
  await nsdchat(cfg, ["BackupPlan", planId, "newevent", pool]);
  const after = names((await batch(cfg, [{ args: ["BackupPlan", planId, "eventnames"], names: true }]))[0]);
  const created = after.filter((e) => !before.has(e));
  if (created.length !== 1) throw new P5Error(`expected exactly one new event on plan ${planId}, found ${created.length}: ${created.join(", ")}`);
  const name = created[0];
  for (const s of steps.slice(1)) await nsdchat(cfg, [s[0], name, ...s.slice(2)]);
  return { confirmationRequired: false as const, plan: planId, event: name };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Label tapes. With `drive`, all OTHER tape drives get cleaning=1 for the
 * duration of the label job (P5 avoids drives flagged for cleaning), so the
 * tape goes into the chosen drive; previous flags are restored in finally.
 * P5 exposes no jukebox->drive mapping, so "other drives" are all Device names
 * except the chosen drive, the jukeboxes, and disk devices (`drive_*`).
 */
export async function labelTapes(
  cfg: ArchiwareConfig,
  jukebox: string,
  pool: string,
  slotIds: string[],
  confirm: boolean,
  drive?: string,
) {
  const labelArgs = ["Jukebox", jukebox, "label", pool, ...slotIds];
  const note = `DESTRUCTIVE: writes a new P5 label for pool "${pool}" onto the EMPTY tapes in slots ${slotIds.join(", ")} (already written tapes are skipped).${drive ? ` Temporarily sets cleaning=1 on all drives except ${drive}, restored afterwards.` : ""}`;
  if (!confirm) {
    if (!drive) return mutate(cfg, labelArgs, false, note);
    return wouldRunSteps(
      cfg,
      [
        ["Device", "<each other drive>", "cleaning", "1"],
        labelArgs,
        ["Job", "<job>", "status"],
        ["Device", "<each other drive>", "cleaning", "<previous>"],
      ],
      note,
    );
  }
  if (!drive) {
    const id = await nsdchat(cfg, labelArgs);
    return { confirmationRequired: false as const, result: id || null };
  }
  const [devs, jbs] = await batch(cfg, [
    { args: ["Device", "names"], names: true },
    { args: ["Jukebox", "names"], names: true },
  ]).then((r) => [names(r[0]), names(r[1])]);
  if (!devs.includes(drive)) throw new P5Error(`unknown drive ${drive}; devices: ${devs.join(", ")}`);
  const others = devs.filter((d) => d !== drive && !jbs.includes(d) && !d.startsWith("drive_"));
  const prev = await batch(cfg, others.map((d) => ({ args: ["Device", d, "cleaning"] })));
  const previous = new Map(others.map((d, i) => [d, str(prev[i]) ?? "0"]));
  let jobId = "";
  let finalStatus: string | null = null;
  try {
    for (const d of others) await nsdchat(cfg, ["Device", d, "cleaning", "1"]);
    jobId = (await nsdchat(cfg, labelArgs)).trim();
    for (let i = 0; jobId && i < 360; i++) {
      await sleep(10_000);
      finalStatus = str((await batch(cfg, [{ args: ["Job", jobId, "status"] }], JOB_TIMEOUT_MS))[0]);
      if (finalStatus !== "running" && finalStatus !== "scheduled") break;
    }
  } finally {
    for (const [d, v] of previous) await nsdchat(cfg, ["Device", d, "cleaning", v]).catch(() => undefined);
  }
  const report = jobId ? (await rawBatch(cfg, [["Job", jobId, "report"]], JOB_TIMEOUT_MS))[0] ?? (await jobLogBlock(cfg, jobId, cfg.logPath)) : null;
  return { confirmationRequired: false as const, job: jobId || null, status: finalStatus, drive, restoredCleaning: Object.fromEntries(previous), report };
}

export const inventory = (cfg: ArchiwareConfig, jukebox: string, barcode: boolean, confirm: boolean) =>
  mutate(cfg, ["Jukebox", jukebox, "inventory", ...(barcode ? ["-barcode"] : [])], confirm, "Schedules a library inventory job (barcode scan updates P5's volume database).");

// ---------------------------------------------------------------------------
// Raw passthrough escape hatch
// ---------------------------------------------------------------------------

const READ_ONLY_METHODS = new Set([
  "names",
  "describe",
  "enabled",
  "disabled",
  "status",
  "label",
  "report",
  "protocol",
  "usage",
  "mode",
  "state",
  "location",
  "mediatype",
  "totalsize",
  "usedsize",
  "maxsize",
  "usecount",
  "usedtime",
  "usetime",
  "barcode",
  "copyof",
  "dateexpires",
  "dateused",
  "isonline",
  "jobs",
  "slotcount",
  "volumes",
  "cleaning",
  "completed",
  "pending",
  "running",
  "failed",
  "warning",
  "completion",
  "resourcegroup",
  "resourcename",
  "runat",
  "totalkbytes",
  "totalfiles",
  "xmlticket",
  "geterror",
  "srvinfo",
  "buildstamp",
  "address",
  "home",
  "hostid",
  "hostname",
  "lexxvers",
  "platform",
  "port",
  "server",
  "uptime",
  "version",
  "resources",
  "free",
  "pool",
  "level",
  "firstrun",
  "frequency",
  "exception",
  "duration",
  "eventnames",
  "tasknames",
  "client",
  "dirlist",
  "crossmounts",
  "prescript",
  "postscript",
  "retention",
  "loglevel",
  "stophours",
  "progressive",
  "canceltime",
  "startnewvol",
  "incrlevel",
  "autostart",
  "database",
  "deletefiles",
  "deleteall",
  "drivecount",
  "filter",
  "hardWrErCnt",
  "softWrErCnt",
  "hardRdErCnt",
  "softRdErCnt",
]);

export function isReadOnlyNsdchatArgs(args: string[]): boolean {
  // "<Resource> [name] <method> ..." — method is the last bare word before args
  // that matches a known read-only method; conservatively: any token being a
  // read-only method counts only if it is the method position (index 1 or 2).
  const idx = args[0] === "srvinfo" || args[0] === "geterror" || args[1] === "names" ? 1 : 2;
  const method = args[idx] ?? args[1];
  // A value after the method means a setter (e.g. Device sg6 cleaning 1).
  const takesValue = args.length > idx + 1 && !["completed", "report", "protocol", "volumes"].includes(method ?? "");
  return Boolean(method && READ_ONLY_METHODS.has(method) && !takesValue);
}

export const nsdchatRaw = (cfg: ArchiwareConfig, args: string[], confirm: boolean) => {
  if (isReadOnlyNsdchatArgs(args)) {
    return nsdchat(cfg, args).then((result) => ({ result: result === "" ? null : result }));
  }
  return mutate(cfg, args, confirm, "Raw nsdchat command; not classified as read-only.");
};

// ---------------------------------------------------------------------------
// Backup restore (relocated, never in place)
// ---------------------------------------------------------------------------

/** Run a command inside the P5 container (needed for files nsdchat writes there). */
async function containerExec(cfg: ArchiwareConfig, argv: string[]): Promise<string> {
  const r = await hostCommand(cfg, p5Exec(cfg, argv), 60_000);
  if (r.rc !== 0) throw new P5Error(`container command failed (exit ${r.rc}): ${argv.join(" ")}`, r.stderr);
  return r.stdout;
}

export interface RestoreEntry {
  path: string;
  size: number;
  volumes: string[];
}

/**
 * List what a backup volume (or the volumes of a backup job) holds.
 * Uses `Volume <id> inventory` / `Job <id> inventory` (tab-separated path, handle, size, volumes).
 * Backup entries have no CLI handle, so the volume is the unit RestoreSelection can address.
 */
export async function restoreLookup(cfg: ArchiwareConfig, source: { volume?: string; job?: string }) {
  const { volume, job } = source;
  if ((volume ? 1 : 0) + (job ? 1 : 0) !== 1) throw new P5Error("give exactly one of volume or job");
  const id = (volume ?? job)!;
  if (!/^\d+$/.test(id)) throw new P5Error("volume/job must be a numeric id");
  const file = `/tmp/archiware-mcp-inv-${process.pid}-${Date.now()}.txt`;
  const kind = volume ? "Volume" : "Job";
  await nsdchatLong(cfg, [kind, id, "inventory", file, "handle", "size", "volumes"]);
  let raw: string;
  try {
    raw = await containerExec(cfg, ["cat", file]);
  } finally {
    await containerExec(cfg, ["rm", "-f", file]).catch(() => undefined);
  }
  const entries: RestoreEntry[] = raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const [path, , size, vols] = l.split("\t");
      return { path, size: Number(size) || 0, volumes: (vols ?? "").split(/\s+/).filter(Boolean) };
    });
  const volumes = volume ? [volume] : [...new Set(entries.flatMap((e) => e.volumes))];
  return { source: kind.toLowerCase(), id, volumes, entryCount: entries.length, entries };
}

const isUnder = (p: string, root: string) => p === root || p.startsWith(root.replace(/\/+$/, "") + "/");

/**
 * Restore a backed-up folder to an ALTERNATE directory; originals are never touched.
 * RestoreSelection can only take a whole backup volume (addfromvolume) for backup indexes
 * (addentry/findentry need archive handles), so the restore is refused unless every
 * entry on the volume lies at or above `path` (ancestor directories only) or below it.
 * Returns the restore job id.
 */
export async function restore(cfg: ArchiwareConfig, volume: string, path: string, target: string, confirm: boolean) {
  const norm = (p: string) => p.replace(/\/+$/, "") || "/";
  path = norm(path);
  target = norm(target);
  if (!path.startsWith("/") || !target.startsWith("/")) throw new P5Error("path and target must be absolute");
  if (target === "/" || isUnder(target, path) || isUnder(path, target)) {
    throw new P5Error("target must be a separate directory, not the original path, inside it, or a parent of it");
  }
  const lookup = await restoreLookup(cfg, { volume });
  const foreign = lookup.entries.filter((e) => !isUnder(e.path, path) && !isUnder(path, e.path));
  if (!lookup.entries.some((e) => isUnder(e.path, path))) {
    throw new P5Error(`volume ${volume} holds nothing under ${path}`);
  }
  if (foreign.length > 0) {
    throw new P5Error(
      `volume ${volume} also holds ${foreign.length} entries outside ${path} (e.g. ${foreign[0].path}); selecting a path within a backup volume is not possible via the CLI, refusing to restore the whole volume`,
    );
  }
  const note = `Restores everything on backup volume ${volume} (all under ${path}) into ${target}; originals are not touched.`;
  const steps = [
    ["RestoreSelection", "create", "localhost", target],
    ["RestoreSelection", "<selection>", "addfromvolume", volume],
    ["RestoreSelection", "<selection>", "describe", `restore ${path} to ${target}`],
    ["RestoreSelection", "<selection>", "submit"],
  ];
  if (!confirm) return { ...wouldRunSteps(cfg, steps, note), mkdir: describeRemote(cfg, p5Exec(cfg, ["mkdir", "-p", target]).map(shellQuote).join(" ")) };
  await containerExec(cfg, ["mkdir", "-p", target]);
  const sel = (await nsdchat(cfg, steps[0])).trim();
  if (!sel) throw new P5Error("RestoreSelection create returned no name");
  try {
    const added = (await nsdchat(cfg, ["RestoreSelection", sel, "addfromvolume", volume])).trim();
    if (added !== volume) throw new P5Error(`addfromvolume did not accept volume ${volume}`);
    await nsdchat(cfg, ["RestoreSelection", sel, "describe", `restore ${path} to ${target}`]);
    const job = (await nsdchat(cfg, ["RestoreSelection", sel, "submit"])).trim();
    if (!job) throw new P5Error("RestoreSelection submit returned no job id");
    return { confirmationRequired: false as const, job, volume, path, target, entries: lookup.entryCount };
  } catch (e) {
    await nsdchat(cfg, ["RestoreSelection", sel, "destroy"]).catch(() => undefined);
    throw e;
  }
}
