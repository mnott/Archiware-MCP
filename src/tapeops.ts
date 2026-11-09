/**
 * Host-side tape operations: bypass P5 and drive the library directly with
 * mtx/mt on the host. They exist because P5's CLI cannot erase or clean, and
 * P5 only labels empty tapes.
 *
 * Drive selection is by tape generation: the barcode suffix (...L6 -> LTO-6,
 * ...L9 -> LTO-9) picks the drive from the config `drives` mapping. An LTO-9
 * drive cannot load an L6 tape ("incompatible volume qualifier"), so a
 * mismatch is refused instead of attempted.
 *
 * Every operation that loads a tape unloads it again in a finally block: a
 * failure must never leave a tape sitting in a drive.
 */

import type { ArchiwareConfig, DriveConfig } from "./config.js";
import { chatNames, hostCommand, mtxStatus, nsdchat, parseTclList, P5Error, rawBatch, shellQuote, describeRemote, p5Exec } from "./transport.js";
import { parseMtx, volumes as p5Volumes, type MtxStatus, type VolumeInfo } from "./operations.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** LTO generation from a barcode suffix: "...L6" -> "L6", "...L9" -> "L9". */
export function genFromBarcode(barcode: string | null): string | null {
  if (!barcode) return null;
  const m = barcode.toUpperCase().match(/L([4-9])$/);
  return m ? `L${m[1]}` : null;
}

/** mtx element -> configured drive. */
function driveByElement(cfg: ArchiwareConfig, element: number): DriveConfig {
  const d = cfg.drives.find((x) => x.element === element);
  if (!d) throw new P5Error(`no drive configured for mtx element ${element}; drives: ${cfg.drives.map((x) => `${x.element}=${x.nst}`).join(", ") || "none"}`);
  return d;
}

/** Resolve a P5 device name (sg6) or generation (L6/L9) to a configured drive. */
export function driveByP5OrGen(cfg: ArchiwareConfig, p5OrGen: string): DriveConfig {
  const key = p5OrGen.trim();
  const d = cfg.drives.find((x) => x.p5 === key || x.gen.toUpperCase() === key.toUpperCase());
  if (!d) throw new P5Error(`unknown drive "${key}"; configured: ${cfg.drives.map((x) => `${x.gen}=${x.p5}=${x.nst}`).join(", ") || "none"}`);
  return d;
}

/** The drive matching a tape generation, if one is configured. */
function driveByGen(cfg: ArchiwareConfig, gen: string): DriveConfig | undefined {
  return cfg.drives.find((x) => x.gen.toUpperCase() === gen.toUpperCase());
}

/** Commands for one load/unload cycle, for dry-run output. */
function cycleCommands(cfg: ArchiwareConfig, d: DriveConfig, slot: number, extra: string[][] = []): string[] {
  const cmds: string[][] = [
    ["sudo", "-n", "mtx", "-f", cfg.changer, "load", String(slot), String(d.element)],
    ["sudo", "-n", "mt", "-f", d.nst, "status"],
    ...extra,
    ["sudo", "-n", "mt", "-f", d.nst, "rewind"],
    ["sudo", "-n", "mtx", "-f", cfg.changer, "unload", String(slot), String(d.element)],
  ];
  return cmds.map((a) => describeRemote(cfg, a.map(shellQuote).join(" ")));
}

/**
 * Refuse to use a drive that is loaded, unless forced. Checks only the drives
 * the operation needs (by element), so the other generation's drive may be busy
 * with a P5 job without blocking this operation.
 */
export function busyDrives(mtx: MtxStatus, needed: DriveConfig[], allowSlot: number | null = null) {
  const elements = new Set(needed.map((d) => d.element));
  return mtx.driveStates.filter((d) => elements.has(d.drive) && d.full && d.loadedFromSlot !== allowSlot);
}

export interface P5JobInfo {
  id: string;
  status: string | null;
  report?: string | null;
}

const MOUNT_WAIT_RE = /Mounting|Wait for drive|Writable volumes required/i;

/** Ids of P5 jobs that are running/pending or whose report shows they wait for / mount a drive. */
export function jobBlockers(jobs: P5JobInfo[]): string[] {
  return jobs
    .filter((j) => /^(running|pending)$/i.test((j.status ?? "").trim()) || MOUNT_WAIT_RE.test(j.report ?? ""))
    .map((j) => j.id);
}

/** Running and pending P5 jobs with status and report (fails closed: errors propagate). */
async function activeJobs(cfg: ArchiwareConfig): Promise<P5JobInfo[]> {
  const ids = [...new Set([...(await chatNames(cfg, ["Job", "running"])), ...(await chatNames(cfg, ["Job", "pending"]))])];
  if (ids.length === 0) return [];
  const res = await rawBatch(cfg, ids.flatMap((id) => [["Job", id, "status"], ["Job", id, "report"]]));
  return ids.map((id, i) => ({ id, status: res[2 * i], report: res[2 * i + 1] }));
}

/**
 * Refuse when a drive the operation needs is loaded, or when any P5 job is
 * running/pending (it could mount a tape of the required generation at any
 * moment), unless forced. The other generation's loaded drive does not block.
 */
export async function guardBusy(
  cfg: ArchiwareConfig,
  mtx: MtxStatus,
  needed: DriveConfig[],
  force: boolean,
  allowSlot: number | null = null,
  jobsLookup: (cfg: ArchiwareConfig) => Promise<P5JobInfo[]> = activeJobs,
): Promise<void> {
  if (force) return;
  const loaded = busyDrives(mtx, needed, allowSlot);
  if (loaded.length > 0) {
    throw new P5Error(
      `required drive(s) ${loaded.map((d) => `${d.drive} (slot ${d.loadedFromSlot ?? "?"}${d.barcode ? `, ${d.barcode}` : ""})`).join(", ")} currently loaded — P5 or another process may be using them; pass force/--force to override`,
    );
  }
  const blockers = jobBlockers(await jobsLookup(cfg));
  if (blockers.length > 0) {
    throw new P5Error(
      `P5 job(s) ${blockers.join(", ")} running or pending and may mount a drive (${needed.map((d) => d.gen).join(", ")}); wait for them to finish or pass force/--force to override`,
    );
  }
}

/** Error text if the cartridge in drive `element` is not `expected`, else null. */
export function barcodeMismatch(mtx: MtxStatus, element: number, expected: string | null): string | null {
  const ds = mtx.driveStates.find((x) => x.drive === element);
  if (!ds?.full) return `drive element ${element} is empty after load (expected ${expected ?? "?"})`;
  if (!expected) return `expected barcode unknown; refusing to continue with ${ds.barcode ?? "?"} in drive element ${element}`;
  if ((ds.barcode ?? "").toUpperCase() !== expected.toUpperCase()) {
    return `drive element ${element} holds ${ds.barcode ?? "?"}, expected ${expected}`;
  }
  return null;
}

/** Load slot -> drive element, then poll `mt status` until the tape is ready. */
async function loadAndWait(cfg: ArchiwareConfig, d: DriveConfig, slot: number, maxMs: number, expectedBarcode: string | null): Promise<void> {
  const load = await hostCommand(cfg, ["sudo", "-n", "mtx", "-f", cfg.changer, "load", String(slot), String(d.element)]);
  if (load.rc !== 0) throw new P5Error(`mtx load ${slot} ${d.element} failed (exit ${load.rc}): ${load.stderr || load.stdout.trim()}`);
  const deadline = Date.now() + maxMs;
  let last = "";
  while (Date.now() < deadline) {
    const st = await hostCommand(cfg, ["sudo", "-n", "mt", "-f", d.nst, "status"], 30_000);
    if (st.rc === 0) {
      const after = parseMtx(await mtxStatus(cfg));
      const bad = barcodeMismatch(after, d.element, expectedBarcode);
      if (bad) {
        // Wrong cartridge: unload it from wherever it came from and abort before any write/erase.
        const from = after.driveStates.find((x) => x.drive === d.element)?.loadedFromSlot ?? slot;
        const un = await rewindUnload(cfg, d, from);
        throw new P5Error(`barcode check failed: ${bad}; aborted${un ? `; ${un}` : "; tape unloaded"}`);
      }
      return;
    }
    last = st.stderr || st.stdout.trim();
    await sleep(5_000);
  }
  throw new P5Error(`drive ${d.nst} not ready 120 s after loading slot ${slot}: ${last}`);
}

/** Rewind and unload the drive back to slot; errors are reported, not thrown (finally path). */
async function rewindUnload(cfg: ArchiwareConfig, d: DriveConfig, slot: number): Promise<string | null> {
  const rw = await hostCommand(cfg, ["sudo", "-n", "mt", "-f", d.nst, "rewind"], 120_000);
  const un = await hostCommand(cfg, ["sudo", "-n", "mtx", "-f", cfg.changer, "unload", String(slot), String(d.element)]);
  if (un.rc === 0) return rw.rc === 0 ? null : `rewind failed (exit ${rw.rc}): ${rw.stderr || rw.stdout.trim()}`;
  return `unload ${slot} ${d.element} failed (exit ${un.rc}): ${un.stderr || un.stdout.trim()} — tape may still be in drive ${d.nst}`;
}

/** mt status parsed for file/block numbers ("file number=X block number=Y"). */
function mtFileBlock(status: string): { file: number | null; block: number | null } {
  const m = status.match(/file number=(\d+).*?block number=(\d+)/);
  return m ? { file: Number(m[1]), block: Number(m[2]) } : { file: null, block: null };
}

/** Printable ASCII runs of >= 4 chars in a binary block. */
export function printableStrings(buf: Buffer, min = 4): string[] {
  const s = buf.toString("latin1");
  const out: string[] = [];
  const re = /[\x20-\x7e]{4,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[0]);
  return out;
}

export interface TapeOpResult {
  confirmationRequired?: boolean;
  wouldRun?: string[];
  note?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// tape_load / tape_unload
// ---------------------------------------------------------------------------

/**
 * Where a slot's tape physically is: in the slot itself, or loaded in a drive
 * (mtx reports the slot as empty once its tape sits in a drive).
 */
function tapeLocation(mtx: MtxStatus, slot: number): { barcode: string | null; driveElement: number | null } {
  const s = mtx.slotStates.find((x) => x.slot === slot);
  if (s?.full) return { barcode: s.barcode, driveElement: null };
  const loaded = mtx.driveStates.find((d) => d.full && d.loadedFromSlot === slot);
  if (loaded) return { barcode: loaded.barcode, driveElement: loaded.drive };
  throw new P5Error(`slot ${slot} is empty or unknown`);
}

/** Drive for a slot's tape, refusing a drive that is not empty. */
function driveForSlotTape(cfg: ArchiwareConfig, mtx: MtxStatus, slot: number): { barcode: string | null; drive: DriveConfig } {
  const loc = tapeLocation(mtx, slot);
  const gen = genFromBarcode(loc.barcode);
  const d = gen ? driveByGen(cfg, gen) : undefined;
  if (!d) throw new P5Error(`slot ${slot} tape ${loc.barcode ?? "(no barcode)"}: no matching drive configured (generation ${gen ?? "unknown"})`);
  const driveState = mtx.driveStates.find((x) => x.drive === d.element);
  if (driveState?.full && driveState.loadedFromSlot !== slot) {
    throw new P5Error(`drive ${d.nst} (element ${d.element}) is not empty (slot ${driveState.loadedFromSlot ?? "?"}, ${driveState.barcode ?? "?"}) — unload it first`);
  }
  return { barcode: loc.barcode, drive: d };
}

export async function tapeLoad(cfg: ArchiwareConfig, slot: number, confirm: boolean, force = false): Promise<TapeOpResult> {
  const mtx = parseMtx(await mtxStatus(cfg));
  const { barcode, drive: d } = driveForSlotTape(cfg, mtx, slot);
  const alreadyLoaded = mtx.driveStates.some((x) => x.full && x.loadedFromSlot === slot);
  const note = alreadyLoaded
    ? `Slot ${slot}'s tape (${barcode}) is already loaded in drive ${d.nst} (P5 ${d.p5}); nothing to do.`
    : `Loads the tape from slot ${slot} (${barcode}, ${d.gen}) into drive ${d.nst} (mtx element ${d.element}, P5 ${d.p5}) and leaves it loaded.`;
  if (!confirm) {
    const cmds = cycleCommands(cfg, d, slot);
    return { confirmationRequired: true, wouldRun: [cmds[0], cmds[1], ...cmds.slice(3)], note };
  }
  await guardBusy(cfg, mtx, [d], force, slot);
  if (alreadyLoaded) {
    const st = await hostCommand(cfg, ["sudo", "-n", "mt", "-f", d.nst, "status"], 30_000);
    return { confirmationRequired: false, slot, barcode, drive: d.nst, p5: d.p5, alreadyLoaded: true, mtStatus: st.stdout.trim() || st.stderr };
  }
  try {
    await loadAndWait(cfg, d, slot, 120_000, barcode);
  } catch (e) {
    // Never leave a tape in a drive on failure.
    const unloadError = await rewindUnload(cfg, d, slot);
    throw new P5Error(`${e instanceof Error ? e.message : String(e)}${unloadError ? `; ${unloadError}` : ""}`);
  }
  const st = await hostCommand(cfg, ["sudo", "-n", "mt", "-f", d.nst, "status"], 30_000);
  return { confirmationRequired: false, slot, barcode, drive: d.nst, p5: d.p5, mtStatus: st.stdout.trim() || st.stderr };
}

export async function tapeUnload(cfg: ArchiwareConfig, slot: number, confirm: boolean, force = false): Promise<TapeOpResult> {
  const mtx = parseMtx(await mtxStatus(cfg));
  const loaded = mtx.driveStates.find((d) => d.full && d.loadedFromSlot === slot);
  if (!loaded) throw new P5Error(`nothing loaded from slot ${slot}`);
  const d = driveByElement(cfg, loaded.drive);
  const note = `Rewinds the tape in drive ${d.nst} and unloads it back to slot ${slot} (${loaded.barcode ?? "?"}).`;
  if (!confirm) {
    const cmds = cycleCommands(cfg, d, slot, []);
    return { confirmationRequired: true, wouldRun: [...cmds.slice(3), cmds[2]], note };
  }
  await guardBusy(cfg, mtx, [d], force);
  const err = await rewindUnload(cfg, d, slot);
  return { confirmationRequired: false, slot, drive: d.nst, unloaded: err === null, error: err };
}

// ---------------------------------------------------------------------------
// tape_read_header
// ---------------------------------------------------------------------------

/** Read the first block of a tape: load, rewind, dd 256k then 1M, report, rewind, unload. */
export async function tapeReadHeader(cfg: ArchiwareConfig, slot: number, force = false): Promise<TapeOpResult> {
  const mtx = parseMtx(await mtxStatus(cfg));
  const { barcode, drive: d } = driveForSlotTape(cfg, mtx, slot);
  await guardBusy(cfg, mtx, [d], force);
  let unloadError: string | null = null;
  try {
    if (!mtx.driveStates.some((x) => x.full && x.loadedFromSlot === slot)) await loadAndWait(cfg, d, slot, 120_000, barcode);
    const attempts: Record<string, unknown>[] = [];
    let data: Buffer | null = null;
    let blockSize = 0;
    for (const bs of [262_144, 1_048_576]) {
      const r = await hostCommand(cfg, ["sudo", "-n", "dd", ifArg(d.nst), "bs=" + bs, "count=1", "iflag=fullblock"], 120_000);
      const bytes = Buffer.byteLength(r.stdout, "latin1");
      attempts.push({ bs, rc: r.rc, bytes, stderr: r.stderr.trim() || null });
      if (r.rc === 0 && bytes > 0) {
        data = Buffer.from(r.stdout, "latin1");
        blockSize = bs;
        break;
      }
    }
    const st = await hostCommand(cfg, ["sudo", "-n", "mt", "-f", d.nst, "status"], 30_000);
    const fb = mtFileBlock(st.stdout);
    return {
      confirmationRequired: false,
      slot,
      barcode,
      drive: d.nst,
      blockSize,
      bytes: data?.length ?? 0,
      printableStrings: data ? printableStrings(data).slice(0, 50) : [],
      mtStatus: st.stdout.trim() || st.stderr,
      file: fb.file,
      block: fb.block,
      ddAttempts: attempts,
    };
  } finally {
    unloadError = await rewindUnload(cfg, d, slot);
  }
}

/** dd needs `if=/dev/nst0` as one argv element. */
function ifArg(nst: string): string {
  return `if=${nst}`;
}

// ---------------------------------------------------------------------------
// tape_erase
// ---------------------------------------------------------------------------

/** Injectable collaborators (unit tests stub these; production uses the real ones). */
export interface EraseDeps {
  volumes: (cfg: ArchiwareConfig) => Promise<VolumeInfo[]>;
  mtxStatus: (cfg: ArchiwareConfig) => Promise<string>;
}
const realEraseDeps: EraseDeps = { volumes: p5Volumes, mtxStatus };

/** Targets whose tape P5 still knows as a volume, or whose barcode is unknown ("?"). */
export function eraseRefusals(targets: { slot: number; barcode: string }[], vols: VolumeInfo[]): string[] {
  const out: string[] = [];
  for (const t of targets) {
    if (t.barcode === "?") {
      out.push(`slot ${t.slot}: barcode unknown, cannot check P5; pass --erase-known to erase anyway`);
      continue;
    }
    const v = vols.find((x) => x.barcode?.toUpperCase() === t.barcode.toUpperCase());
    if (v) out.push(`slot ${t.slot} barcode ${t.barcode}: P5 volume ${v.id} in pool ${v.pool ?? "none"}: erase it in P5 first (recycle/remove the volume) or pass --erase-known`);
  }
  return out;
}

/** DESTRUCTIVE short erase (rewind + `mt erase 0`), one tape at a time. Refuses tapes P5 still knows unless eraseKnown. */
export async function tapeErase(cfg: ArchiwareConfig, slots: number[], confirm: boolean, force = false, eraseKnown = false, deps: EraseDeps = realEraseDeps): Promise<TapeOpResult> {
  const mtx = parseMtx(await deps.mtxStatus(cfg));
  const targets: { slot: number; barcode: string; gen: string; drive: DriveConfig }[] = [];
  for (const slot of slots) {
    const { barcode, drive: d } = driveForSlotTape(cfg, mtx, slot);
    targets.push({ slot, barcode: barcode ?? "?", gen: d.gen, drive: d });
  }
  const refused = eraseKnown ? [] : eraseRefusals(targets, await deps.volumes(cfg));
  const note = `DESTRUCTIVE: short-erases the tapes in slots ${slots.join(", ")} — this DESTROYS all their contents (rewind + mt erase 0). One tape at a time.`;
  if (!confirm) {
    return {
      confirmationRequired: true,
      ...(refused.length ? { refused, refusedNote: "these targets would be refused; confirm fails unless P5 no longer knows them or --erase-known is passed" } : {}),
      wouldRun: targets.flatMap((t) => cycleCommands(cfg, t.drive, t.slot, [["sudo", "-n", "mt", "-f", t.drive.nst, "erase", "0"]])),
      note,
    };
  }
  if (refused.length) throw new P5Error(`refusing to erase: ${refused.join("; ")}`);
  await guardBusy(cfg, mtx, targets.map((t) => t.drive), force);
  const results: Record<string, unknown>[] = [];
  for (const t of targets) {
    let eraseError: string | null = null;
    let unloadError: string | null = null;
    try {
      await loadAndWait(cfg, t.drive, t.slot, 120_000, t.barcode === "?" ? null : t.barcode);
      const rw = await hostCommand(cfg, ["sudo", "-n", "mt", "-f", t.drive.nst, "rewind"], 120_000);
      if (rw.rc !== 0) eraseError = `rewind failed (exit ${rw.rc}): ${rw.stderr || rw.stdout.trim()}`;
      const er = await hostCommand(cfg, ["sudo", "-n", "mt", "-f", t.drive.nst, "erase", "0"], 300_000);
      if (er.rc !== 0) {
        eraseError = `${eraseError ? eraseError + "; " : ""}erase failed (exit ${er.rc}): ${er.stderr || er.stdout.trim()}${er.stderr && /I\/O error/i.test(er.stderr) ? " — I/O error: the tape is probably bad" : ""}`;
      }
    } finally {
      // Rewind + unload even after an erase error: never leave a tape in a drive.
      unloadError = await rewindUnload(cfg, t.drive, t.slot);
    }
    results.push({ slot: t.slot, barcode: t.barcode, drive: t.drive.nst, erased: eraseError === null, eraseError, unloadError });
  }
  return { confirmationRequired: false, results };
}

// ---------------------------------------------------------------------------
// clean_drive
// ---------------------------------------------------------------------------

/** Load the CLN* cleaning tape into a drive, wait for the drive to finish cleaning, unload. */
export async function cleanDrive(cfg: ArchiwareConfig, p5OrGen: string, confirm: boolean, force = false): Promise<TapeOpResult> {
  const d = driveByP5OrGen(cfg, p5OrGen);
  const mtx = parseMtx(await mtxStatus(cfg));
  const cln = mtx.slotStates.find((x) => x.slot === cfg.cleaningSlot && x.full && (x.barcode ?? "").toUpperCase().startsWith("CLN"));
  if (!cln) throw new P5Error(`cleaning tape not found in slot ${cfg.cleaningSlot} (barcode CLN*)`);
  const driveState = mtx.driveStates.find((x) => x.drive === d.element);
  if (driveState?.full && driveState.loadedFromSlot !== cfg.cleaningSlot) {
    throw new P5Error(`drive ${d.nst} (element ${d.element}) is not empty (slot ${driveState.loadedFromSlot ?? "?"}, ${driveState.barcode ?? "?"}) — unload it first`);
  }
  const note = `Cleans drive ${d.nst} (P5 ${d.p5}) with the cleaning tape from slot ${cfg.cleaningSlot} (${cln.barcode}); afterwards sets P5 Device ${d.p5} cleaning 0.`;
  if (!confirm) {
    return {
      confirmationRequired: true,
      wouldRun: [
        ...cycleCommands(cfg, d, cfg.cleaningSlot),
        describeRemote(cfg, p5Exec(cfg, [cfg.nsdchat, "-c", "Device", d.p5, "cleaning", "0"]).map(shellQuote).join(" ")),
      ],
      note,
    };
  }
  await guardBusy(cfg, mtx, [d], force);
  let unloadError: string | null = null;
  let cleanResult: string;
  try {
    // Cleaning tapes report "not ready" while the drive cleans; ready again = done.
    if (!driveState?.full) await loadAndWait(cfg, d, cfg.cleaningSlot, 180_000, cln.barcode);
    const deadline = Date.now() + 180_000;
    let last = "";
    let sawNotReady = false;
    cleanResult = "drive never reported not ready; became ready immediately";
    while (Date.now() < deadline) {
      const st = await hostCommand(cfg, ["sudo", "-n", "mt", "-f", d.nst, "status"], 30_000);
      last = st.stdout.trim() || st.stderr;
      if (st.rc !== 0 && /not ready/i.test(last)) sawNotReady = true;
      if (st.rc === 0) {
        cleanResult = sawNotReady ? "drive cleaned (not ready -> ready)" : last;
        break;
      }
      await sleep(5_000);
    }
    if (Date.now() >= deadline && !/ready/.test(last)) cleanResult = `timed out after 180 s, last status: ${last}`;
  } finally {
    unloadError = await rewindUnload(cfg, d, cfg.cleaningSlot);
  }
  const p5 = await nsdchat(cfg, ["Device", d.p5, "cleaning", "0"]).catch((e) => `P5 cleaning reset failed: ${e instanceof Error ? e.message : String(e)}`);
  return {
    confirmationRequired: false,
    drive: d.nst,
    p5: d.p5,
    cleaningSlot: cfg.cleaningSlot,
    barcode: cln.barcode,
    cleanResult,
    unloadError,
    p5Cleaning: p5 === null ? "Device " + d.p5 + " cleaning set to 0" : p5,
  };
}
