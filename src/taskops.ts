/**
 * Job history, task edits, find-tasks and run-tasks-once.
 *
 * Job history: P5's `Job names` lists only scheduled jobs, but `Job <id> <method>`
 * answers for every job still in the job database (exit 100 = no such id). So the
 * history is enumerated by walking job ids downward from the newest known id, in
 * blocks (one nsdchat Tcl foreach per 100 ids), until a run of consecutive
 * misses ends the walk.
 */

import type { ArchiwareConfig } from "./config.js";
import {
  nsdchat,
  nsdchatCalls,
  P5Error,
  parseTclList,
  type CallResult,
} from "./transport.js";
import { deletePlan, kbToHuman, mutate, wouldRunSteps } from "./operations.js";

const out = (r: CallResult | undefined): string | null => {
  if (!r || r.rc !== 0) return null;
  const t = r.out.trim();
  return t === "" || t === "<empty>" ? null : t;
};

const NAME_RE = /^[A-Za-z0-9_.:-]+$/;
function checkName(kind: string, v: string) {
  if (!NAME_RE.test(v)) throw new P5Error(`invalid ${kind} "${v}"`);
}

// ---------------------------------------------------------------------------
// job_history
// ---------------------------------------------------------------------------

export interface JobHistoryOptions {
  plan?: string;
  status?: string;
  /** YYYY-MM-DD or YYYY-MM-DDTHH:MM (server-local time, as printed in the protocol) */
  since?: string;
  limit?: number;
  /** stop after this many consecutive unknown ids (once a job has been seen) */
  maxMisses?: number;
  /** never look at more ids than this */
  maxScan?: number;
}

const MONTHS: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

/** "Client time: 09-Nov-2026 03:00:05." in the protocol -> "2026-11-09 03:00" (server-local, no zone). */
export function protocolStart(protocol: string | null): string | null {
  const m = protocol?.match(/Client time:\s*(\d{1,2})-(\w{3})-(\d{4}) (\d{2}):(\d{2})/);
  if (!m || !MONTHS[m[2]]) return null;
  return `${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, "0")} ${m[4]}:${m[5]}`;
}

/** First "... save of: ..." line of a protocol, else its first non-empty line. */
export function protocolSource(protocol: string | null): string | null {
  if (!protocol) return null;
  const lines = protocol.split("\n").map((l) => l.trim());
  return lines.find((l) => /\bsave of:/i.test(l)) ?? lines.find((l) => l !== "") ?? null;
}

function normSince(since: string): string {
  const m = since.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
  if (!m) throw new P5Error(`invalid since "${since}", expected YYYY-MM-DD or YYYY-MM-DDTHH:MM`);
  return `${m[1]} ${m[2] ?? "00:00"}`;
}

const ID_BATCH = 100;

/**
 * One nsdchat call walks a whole block of job ids: nsdchat -c evaluates its words as a Tcl
 * script, so a foreach over the ids reads status/describe/... of each id in one process
 * (a miss is an error, caught). Scheduled jobs and jobs of other plans (a finished job's describe is the plan name, a scheduled one's "<plan> - '<client>'") are reported without
 * the protocol (the expensive read). Returns one Tcl list element per id.
 */
export function jobScanScript(ids: number[], planPrefix: string, includeScheduled: boolean): string {
  const pfx = /^[^{}\\\n\r]*$/.test(planPrefix) ? planPrefix : "";
  return [
    `set r {}; set pfx {${pfx}}; set sch ${includeScheduled ? 1 : 0}`,
    `foreach i {${ids.join(" ")}} {`,
    `if {[catch {Job $i status} s] || $s eq ""} {lappend r [list $i MISS]; continue}`,
    `if {[catch {Job $i describe} d]} {set d ""}`,
    `if {($s eq "scheduled" && !$sch) || ($pfx ne "" && $d ne $pfx && [string first "$pfx - " $d] != 0)} {lappend r [list $i $s $d]; continue}`,
    `set rec [list $i $s $d]`,
    `foreach m {completion resourcename totalkbytes totalfiles runat} {if {[catch {Job $i $m} v]} {set v ""}; lappend rec $v}`,
    `if {[catch {Job $i protocol} p]} {set p ""}; lappend rec [string range $p 0 1500]`,
    `lappend r $rec}`,
    `set r`,
  ].join("\n");
}

export async function jobHistory(cfg: ArchiwareConfig, opts: JobHistoryOptions = {}) {
  const limit = opts.limit ?? 50;
  const maxMisses = opts.maxMisses ?? 60;
  const maxScan = opts.maxScan ?? 5000;
  const since = opts.since ? normSince(opts.since) : null;
  const wantStatus = opts.status?.toLowerCase();

  // Known ids and plan resolution in one round trip.
  const head: string[][] = [["Job", "names"], ["Job", "running"], ["Job", "pending"], ["BackupPlan", "names"]];
  const first = await nsdchatCalls(cfg, head);
  const known = [0, 1, 2].flatMap((i) => parseTclList(out(first[i]))).map(Number).filter(Number.isFinite);
  const planIds = parseTclList(out(first[3]));
  let planDescribe: string | null = null;
  if (opts.plan) {
    const rs = await nsdchatCalls(cfg, planIds.map((p) => ["BackupPlan", p, "describe"]));
    const want = opts.plan.toLowerCase();
    const idx = planIds.findIndex((p, i) => p === opts.plan || out(rs[i])?.toLowerCase() === want);
    if (idx < 0) throw new P5Error(`no backup plan with id or name "${opts.plan}"`);
    planDescribe = out(rs[idx]);
  }
  const prefix = planDescribe ?? "";

  let id = (known.length ? Math.max(...known) : 0) + 20;
  const rows: Record<string, unknown>[] = [];
  let scanned = 0;
  let misses = 0;
  let seenAny = false;
  let calls = 0;
  let stop = false;

  while (!stop && id > 0 && scanned < maxScan && rows.length < limit) {
    const ids: number[] = [];
    for (let i = 0; i < ID_BATCH && id - i > 0; i++) ids.push(id - i);
    id -= ids.length;
    scanned += ids.length;
    calls++;
    const raw = out((await nsdchatCalls(cfg, [[jobScanScript(ids, prefix, wantStatus === "scheduled")]], Math.max(cfg.timeoutMs, 120_000)))[0]);
    let olderThanSince = 0;
    let withStart = 0;
    for (const rec of parseTclList(raw).map((e) => parseTclList(e))) {
      const [jid, status, describe, completion, task, kbs, filesS, runatS, protocol] = rec.map((v) => (v === "<empty>" ? "" : v));
      if (status === "MISS" || status === undefined) {
        if (seenAny && ++misses >= maxMisses) stop = true;
        continue;
      }
      seenAny = true;
      misses = 0;
      if (status === "scheduled" && wantStatus !== "scheduled") continue;
      if (prefix && describe !== prefix && !describe?.startsWith(`${prefix} - `)) continue;
      const kb = Number(kbs ?? 0);
      const runat = Number(runatS ?? 0);
      const start = protocolStart(protocol ?? null) ?? (runat > 0 ? new Date(runat * 1000).toISOString().slice(0, 16).replace("T", " ") : null);
      if (start) withStart++;
      if (since && start && start < since) {
        olderThanSince++;
        continue;
      }
      if (wantStatus && status.toLowerCase() !== wantStatus && (completion ?? "").toLowerCase() !== wantStatus) continue;
      rows.push({
        id: jid,
        plan: describe || null,
        task: task || null,
        status,
        completion: completion || null,
        start,
        size: kbToHuman(kb),
        size_kb: kb,
        files: Number(filesS ?? 0),
        source: protocolSource(protocol || null),
      });
    }
    if (since && withStart > 0 && olderThanSince === withStart) stop = true; // ids fall with time
  }
  return { jobs: rows.slice(0, limit), scannedIds: scanned, roundTrips: calls + 2 };
}

// ---------------------------------------------------------------------------
// find_tasks
// ---------------------------------------------------------------------------

export async function findTasks(cfg: ArchiwareConfig, substring: string) {
  if (!substring) throw new P5Error("substring must not be empty");
  const needle = substring.toLowerCase();
  const names = await nsdchatCalls(cfg, [["BackupPlan", "names"]]);
  const planIds = parseTclList(out(names[0]));
  const pr = await nsdchatCalls(cfg, planIds.flatMap((p) => [["BackupPlan", p, "describe"], ["BackupPlan", p, "enabled"], ["BackupPlan", p, "tasknames"]]));
  const plans = planIds.map((id, i) => ({ id, describe: out(pr[i * 3]), enabled: out(pr[i * 3 + 1]) === "1", tasks: parseTclList(out(pr[i * 3 + 2])) }));
  const flat = plans.flatMap((p) => p.tasks.map((t) => ({ p, t })));
  const tr = await nsdchatCalls(cfg, flat.flatMap(({ t }) => [["BackupTask", t, "dirlist"], ["BackupTask", t, "enabled"]]));
  const rows: Record<string, unknown>[] = [];
  flat.forEach(({ p, t }, i) => {
    const dirs = parseTclList(out(tr[i * 2]));
    const matched = dirs.filter((d) => d.toLowerCase().includes(needle));
    if (matched.length === 0) return;
    rows.push({ plan: p.id, describe: p.describe, plan_enabled: p.enabled, task: t, task_enabled: out(tr[i * 2 + 1]) === "1", directories: dirs.join(" ") });
  });
  return { substring, matches: rows };
}

// ---------------------------------------------------------------------------
// task enable / disable / set directories
// ---------------------------------------------------------------------------

async function readTask(cfg: ArchiwareConfig, task: string) {
  const r = await nsdchatCalls(cfg, [["BackupTask", task, "enabled"], ["BackupTask", task, "dirlist"]]);
  if (r[0].rc !== 0) throw new P5Error(`no such backup task: ${task}`);
  return { enabled: out(r[0]) === "1", dirs: parseTclList(out(r[1])) };
}

export async function taskSetEnabled(cfg: ArchiwareConfig, task: string, enabled: boolean, confirm: boolean) {
  checkName("task", task);
  const verb = enabled ? "enable" : "disable";
  if (!confirm) {
    return wouldRunSteps(cfg, [["BackupTask", task, "enabled"], ["BackupTask", task, verb], ["BackupTask", task, "enabled"]], `${enabled ? "Enables" : "Disables"} backup task ${task} and reads the flag back.`);
  }
  const before = await readTask(cfg, task);
  await nsdchat(cfg, ["BackupTask", task, verb]);
  const after = await readTask(cfg, task);
  if (after.enabled !== enabled) throw new P5Error(`task ${task}: enabled=${after.enabled ? 1 : 0} after ${verb}`);
  return { confirmationRequired: false as const, task, before: { enabled: before.enabled ? 1 : 0 }, after: { enabled: after.enabled ? 1 : 0 } };
}

/**
 * Replace the directory list of a task. P5's `dirlist` setter takes the paths as
 * its arguments; the result is read back and compared. If P5 did not store exactly
 * the requested list (it folds several arguments into ONE element on some
 * versions), the previous value is restored and an error is raised.
 */
export async function taskSetDirectories(cfg: ArchiwareConfig, task: string, dirs: string[], confirm: boolean) {
  checkName("task", task);
  if (dirs.length === 0) throw new P5Error("give at least one directory");
  for (const d of dirs) if (!d.startsWith("/") || /[{}\n\r]/.test(d)) throw new P5Error(`invalid directory "${d}" (absolute path without braces/newlines required)`);
  if (!confirm) {
    return wouldRunSteps(
      cfg,
      [["BackupTask", task, "dirlist"], ["BackupTask", task, "dirlist", ...dirs], ["BackupTask", task, "dirlist"]],
      `Replaces the directories of backup task ${task}; the list is read back and the old value restored if P5 stored something else.`,
    );
  }
  const before = await readTask(cfg, task);
  await nsdchat(cfg, ["BackupTask", task, "dirlist", ...dirs]);
  const after = await readTask(cfg, task);
  const same = after.dirs.length === dirs.length && after.dirs.every((d, i) => d === dirs[i]);
  if (!same) {
    await nsdchat(cfg, ["BackupTask", task, "dirlist", ...before.dirs]);
    const restored = await readTask(cfg, task);
    throw new P5Error(
      `P5 stored ${JSON.stringify(after.dirs)} instead of ${JSON.stringify(dirs)}; previous value restored (${JSON.stringify(restored.dirs)}). Use one directory per task.`,
    );
  }
  return { confirmationRequired: false as const, task, before: { directories: before.dirs }, after: { directories: after.dirs } };
}

// ---------------------------------------------------------------------------
// run_tasks_once
// ---------------------------------------------------------------------------

export const ONCE_PREFIX = "mcp-once-";

/**
 * P5 has no BackupPlan/BackupTask method that submits a chosen subset of tasks,
 * so the tasks are copied into a temporary plan (same client, directories, filter)
 * with one event into the requested pool, and that plan is started. The temporary
 * plan is NOT removed automatically (the job needs it while it runs): delete it
 * with run_tasks_once_cleanup <plan> once the job has finished.
 */
export async function runTasksOnce(
  cfg: ArchiwareConfig,
  planId: string,
  tasks: string[],
  pool: string | undefined,
  level: "full" | "incr",
  confirm: boolean,
) {
  checkName("plan", planId);
  if (tasks.length === 0) throw new P5Error("give at least one task");
  tasks.forEach((t) => checkName("task", t));
  const lvl = level === "full" ? "1" : "0";
  const tmp = `${ONCE_PREFIX}${new Date().toISOString().slice(0, 19).replace(/\D/g, "")}`;

  const sr = await nsdchatCalls(cfg, [["BackupPlan", planId, "describe"], ["BackupPlan", planId, "tasknames"], ["BackupPlan", planId, "eventnames"]]);
  if (sr[0].rc !== 0) throw new P5Error(`no such backup plan: ${planId}`);
  const own = new Set(parseTclList(out(sr[1])));
  const foreign = tasks.filter((t) => !own.has(t));
  if (foreign.length) throw new P5Error(`task(s) ${foreign.join(", ")} not in plan ${planId} (tasks: ${[...own].join(", ")})`);
  let usePool = pool;
  if (!usePool) {
    const ev = parseTclList(out(sr[2]))[0];
    usePool = ev ? (out((await nsdchatCalls(cfg, [["CalendarEvent", ev, "pool"]]))[0]) ?? undefined) : undefined;
    if (!usePool) throw new P5Error("no pool given and the plan has no event to take one from; pass pool");
  }
  const reads = await nsdchatCalls(cfg, tasks.flatMap((t) => [["BackupTask", t, "client"], ["BackupTask", t, "dirlist"], ["BackupTask", t, "filter"], ["BackupTask", t, "crossmounts"]]));
  const src = tasks.map((t, i) => ({ t, client: out(reads[i * 4]) ?? "localhost", dirs: parseTclList(out(reads[i * 4 + 1])), filter: out(reads[i * 4 + 2]), cross: out(reads[i * 4 + 3]) === "1" }));

  const steps: string[][] = [["BackupPlan", "create", tmp]];
  for (const s of src) {
    steps.push(["BackupPlan", "<temp plan>", "addtask"]);
    steps.push(["BackupTask", "<new task>", "client", s.client], ["BackupTask", "<new task>", "dirlist", ...s.dirs], ["BackupTask", "<new task>", "enable"]);
    if (s.filter && s.filter !== "none") steps.push(["BackupTask", "<new task>", "filter", s.filter]);
  }
  steps.push(["BackupPlan", "<temp plan>", "newevent", usePool], ["CalendarEvent", "<new event>", "level", lvl], ["BackupPlan", "<temp plan>", "startnow"]);
  const note = `Backs up task(s) ${tasks.join(", ")} of plan ${planId} ONCE (${level}, pool ${usePool}) via a temporary plan "${tmp}" holding copies of those tasks. The temporary plan stays until you run run_tasks_once_cleanup on it after the job finished.`;
  if (!confirm) return wouldRunSteps(cfg, steps, note);

  const plan = (await nsdchat(cfg, ["BackupPlan", "create", tmp])).trim();
  if (!plan) throw new P5Error("BackupPlan create returned no plan id");
  try {
    for (const s of src) {
      const task = (await nsdchat(cfg, ["BackupPlan", plan, "addtask"])).trim();
      if (!task) throw new P5Error(`addtask on ${plan} returned no task`);
      await nsdchat(cfg, ["BackupTask", task, "client", s.client]);
      await nsdchat(cfg, ["BackupTask", task, "dirlist", ...s.dirs]);
      await nsdchat(cfg, ["BackupTask", task, "enable"]);
      if (s.filter && s.filter !== "none") await nsdchat(cfg, ["BackupTask", task, "filter", s.filter]);
      const back = await readTask(cfg, task);
      if (!back.enabled || back.dirs.join("\n") !== s.dirs.join("\n")) throw new P5Error(`copy of task ${s.t} is not identical (enabled=${back.enabled}, dirs=${JSON.stringify(back.dirs)})`);
    }
    const before = new Set(parseTclList(out((await nsdchatCalls(cfg, [["BackupPlan", plan, "eventnames"]]))[0])));
    await nsdchat(cfg, ["BackupPlan", plan, "newevent", usePool]);
    const created = parseTclList(out((await nsdchatCalls(cfg, [["BackupPlan", plan, "eventnames"]]))[0])).filter((e) => !before.has(e));
    if (created.length !== 1) throw new P5Error(`expected one new event on ${plan}, found ${created.length}`);
    await nsdchat(cfg, ["CalendarEvent", created[0], "level", lvl]);
    const jobs = (await nsdchat(cfg, ["BackupPlan", plan, "startnow"])).trim();
    return {
      confirmationRequired: false as const,
      tempPlan: plan,
      tempPlanName: tmp,
      jobs: jobs || null,
      tasks,
      pool: usePool,
      level,
      cleanup: `run_tasks_once_cleanup ${plan} (after the job has finished)`,
    };
  } catch (e) {
    await deletePlan(cfg, plan, true).catch(() => undefined);
    throw e;
  }
}

/** Delete a temporary run-once plan (only plans named mcp-once-*, only when no job of it is active). */
export async function runTasksOnceCleanup(cfg: ArchiwareConfig, planId: string, confirm: boolean) {
  checkName("plan", planId);
  const d = (await nsdchatCalls(cfg, [["BackupPlan", planId, "describe"]]))[0];
  const name = out(d);
  if (d.rc !== 0 || !name) throw new P5Error(`no such backup plan: ${planId}`);
  if (!name.startsWith(ONCE_PREFIX)) throw new P5Error(`refusing: plan ${planId} ("${name}") is not a temporary ${ONCE_PREFIX}* plan`);
  if (!confirm) return mutate(cfg, ["BackupPlan", planId, "delete"], false, `Deletes the temporary run-once plan ${planId} ("${name}") if none of its jobs is running or pending.`);
  const act = await nsdchatCalls(cfg, [["Job", "running"], ["Job", "pending"]]);
  const ids = [...parseTclList(out(act[0])), ...parseTclList(out(act[1]))];
  if (ids.length) {
    const ds = await nsdchatCalls(cfg, ids.map((i) => ["Job", i, "describe"]));
    const busy = ids.filter((_, i) => out(ds[i])?.startsWith(`${name} - `));
    if (busy.length) throw new P5Error(`plan ${planId} still has active job(s): ${busy.join(", ")}`);
  }
  return deletePlan(cfg, planId, true);
}

