/**
 * Library and restore workflow: slot layout per pool, rearranging, mail slot
 * import/export, restore finder, offsite view, P5 reconciliation and the
 * persisted conversational session (library_plan / step / status / abort).
 *
 * Moves use `mtx transfer`; P5 addresses media by label/barcode, so after any
 * real move a P5 jukebox inventory refreshes its slot knowledge and
 * `reconcile` compares it with mtx.
 */

import { beginGuard, destOf, finishGuard, type Safety } from "./restoreguard.js";
import { indexPreview } from "./restorepreview.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configPath, readConfigFile, type ArchiwareConfig } from "./config.js";
import { hostCommand, mtxStatus, nsdchat, nsdchatCalls, P5Error, parseTclList, describeRemote, shellQuote } from "./transport.js";
import * as ops from "./operations.js";
import { guardBusy } from "./tapeops.js";
import { indexVersions } from "./p5db.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// slot layout
// ---------------------------------------------------------------------------

/** "9-12", "1,3,5-7" or [9,10] -> sorted unique slot numbers. */
export function parseSlotSpec(spec: string | number[] | number): number[] {
  if (Array.isArray(spec)) return [...new Set(spec.map(Number))].sort((a, b) => a - b);
  if (typeof spec === "number") return [spec];
  const out = new Set<number>();
  for (const part of spec.split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new P5Error(`invalid slot range "${part}" in slotLayout (use "9-12" or "1,3,5-7")`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (b < a) throw new P5Error(`invalid slot range "${part}": end before start`);
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

/** pool -> slots from config; each slot may belong to one pool only. */
export function layoutSlots(cfg: ArchiwareConfig): Map<string, number[]> {
  const m = new Map<string, number[]>();
  const owner = new Map<number, string>();
  for (const [pool, spec] of Object.entries(cfg.slotLayout ?? {})) {
    const slots = parseSlotSpec(spec).filter((s) => s !== cfg.cleaningSlot);
    for (const s of slots) {
      if (owner.has(s)) throw new P5Error(`slotLayout: slot ${s} is assigned to both "${owner.get(s)}" and "${pool}"`);
      owner.set(s, pool);
    }
    m.set(pool, slots);
  }
  return m;
}

export function poolOfSlot(layout: Map<string, number[]>, slot: number): string | null {
  for (const [pool, slots] of layout) if (slots.includes(slot)) return pool;
  return null;
}

/** Mail (import/export) element ids: mtx flags first, config as addition. */
export function mailSlotsOf(cfg: ArchiwareConfig, mtx: ops.MtxStatus): number[] {
  return [...new Set([...mtx.slotStates.filter((s) => s.importExport).map((s) => s.slot), ...(cfg.mailSlots ?? [])])].sort((a, b) => a - b);
}

const isCleaning = (barcode: string | null) => (barcode ?? "").toUpperCase().startsWith("CLN");

export interface Snapshot {
  mtx: ops.MtxStatus;
  vols: ops.VolumeInfo[];
  byBarcode: Map<string, ops.VolumeInfo>;
}

export async function snapshot(cfg: ArchiwareConfig): Promise<Snapshot> {
  const mtx = ops.parseMtx(await mtxStatus(cfg));
  const vols = await ops.volumes(cfg);
  return { mtx, vols, byBarcode: ops.indexVolumesByBarcode(vols) };
}

export type SlotStatus = "ok" | "misplaced" | "foreign" | "empty";

export interface LayoutRow {
  slot: number;
  kind: "storage" | "mail" | "drive";
  barcode: string | null;
  label: string | null;
  pool: string | null;
  targetPool: string | null;
  status: SlotStatus;
  note?: string;
}

/** Pure: layout rows from mtx, P5 volume data and config. */
export function computeLayout(cfg: ArchiwareConfig, mtx: ops.MtxStatus, byBarcode: Map<string, ops.VolumeInfo>) {
  const layout = layoutSlots(cfg);
  const mail = new Set(mailSlotsOf(cfg, mtx));
  const rows: LayoutRow[] = [];
  const classify = (slot: number, barcode: string | null, full: boolean, kind: LayoutRow["kind"]): LayoutRow => {
    const info = barcode ? byBarcode.get(barcode.toUpperCase()) : undefined;
    const target = kind === "storage" ? poolOfSlot(layout, slot) : null;
    const row: LayoutRow = { slot, kind, barcode, label: info?.label ?? null, pool: info?.pool ?? null, targetPool: target, status: "empty" };
    if (!full) return row;
    if (slot === cfg.cleaningSlot && isCleaning(barcode)) return { ...row, status: "ok", note: "cleaning tape" };
    if (isCleaning(barcode)) return { ...row, status: "ok", note: "cleaning tape (not in the configured cleaningSlot)" };
    if (!info) return { ...row, status: "foreign", note: "barcode unknown to P5" };
    if (kind !== "storage") return { ...row, status: "ok" };
    if (!target) return { ...row, status: "ok", note: "slot not covered by slotLayout" };
    return { ...row, status: info.pool === target ? "ok" : "misplaced", note: info.pool === target ? undefined : `belongs to pool ${info.pool ?? "none"}, slot is for ${target}` };
  };
  for (const s of mtx.slotStates) rows.push(classify(s.slot, s.barcode, s.full, mail.has(s.slot) ? "mail" : "storage"));
  const drives = mtx.driveStates.map((d) => classify(d.drive, d.barcode, d.full, "drive"));
  return { rows, drives, layout, mail: [...mail] };
}

export async function libraryLayout(cfg: ArchiwareConfig) {
  const snap = await snapshot(cfg);
  const l = computeLayout(cfg, snap.mtx, snap.byBarcode);
  const poolsWithoutSlots = [...new Set(snap.vols.filter((v) => v.pool && v.barcode).map((v) => v.pool!))].filter((p) => !l.layout.has(p));
  const capacity: string[] = [];
  for (const [pool, slots] of l.layout) {
    const n = snap.vols.filter((v) => v.pool === pool && v.barcode && snap.mtx.slotStates.some((s) => s.barcode?.toUpperCase() === v.barcode!.toUpperCase())).length;
    if (n > slots.length) capacity.push(`pool ${pool}: ${n} tapes in the library but only ${slots.length} slot(s) in slotLayout`);
  }
  return {
    slots: l.rows,
    drives: l.drives.map((d) => ({ drive: d.slot, barcode: d.barcode, label: d.label, pool: d.pool, status: d.status })),
    mailSlots: l.mail,
    summary: Object.fromEntries((["ok", "misplaced", "foreign", "empty"] as SlotStatus[]).map((k) => [k, l.rows.filter((r) => r.kind === "storage" && r.status === k).length])),
    configuredPools: [...l.layout.keys()],
    poolsWithTapesButNoSlots: poolsWithoutSlots,
    warnings: capacity,
  };
}

// ---------------------------------------------------------------------------
// arrange: minimal move plan
// ---------------------------------------------------------------------------

export interface TransferStep {
  kind: "transfer";
  src: number;
  dst: number;
  barcode: string;
  why: string;
}
export type Step =
  | TransferStep
  | { kind: "human_put"; barcode: string; mailSlot: number }
  | { kind: "human_take"; barcode: string; mailSlot: number }
  | { kind: "finish" };

/**
 * Pure: minimal transfer list reaching the layout. Tapes already in a slot of
 * their pool stay; others go to a free slot of their pool (preferably empty).
 * A tape sitting in a slot that another pool needs, but which has no layout of
 * its own (foreign, unmanaged pool, overflow), is moved to a free slot outside
 * all pool ranges. Chains are ordered so every move lands on an empty slot;
 * cycles use a free buffer slot. Drives and the mail slot are never touched.
 */
export function computeArrange(cfg: ArchiwareConfig, mtx: ops.MtxStatus, byBarcode: Map<string, ops.VolumeInfo>): { moves: TransferStep[]; problems: string[] } {
  const layout = layoutSlots(cfg);
  const mail = new Set(mailSlotsOf(cfg, mtx));
  const problems: string[] = [];
  const storage = mtx.slotStates.filter((s) => !mail.has(s.slot)).map((s) => s.slot);
  const content = new Map<number, string | null>(); // slot -> barcode (null = empty)
  for (const s of mtx.slotStates) if (!mail.has(s.slot)) content.set(s.slot, s.full ? s.barcode ?? "?" : null);
  const poolOf = (b: string) => byBarcode.get(b.toUpperCase())?.pool ?? null;
  const fixed = (slot: number, b: string) => slot === cfg.cleaningSlot || isCleaning(b);

  // desired slot per barcode
  const want = new Map<string, number>();
  const taken = new Set<number>();
  for (const [pool, slots] of layout) {
    const here = [...content].filter(([, b]) => b && poolOf(b) === pool && !fixed(0, b)).map(([s, b]) => ({ slot: s, b: b! }));
    const stay = here.filter((t) => slots.includes(t.slot));
    for (const t of stay) {
      want.set(t.b, t.slot);
      taken.add(t.slot);
    }
    const movers = here.filter((t) => !slots.includes(t.slot));
    const freeSlots = slots.filter((s) => !taken.has(s));
    // prefer currently empty slots, then slots held by tapes that must leave anyway
    freeSlots.sort((a, b) => Number(content.get(a) !== null) - Number(content.get(b) !== null) || a - b);
    for (const t of movers) {
      const dst = freeSlots.shift();
      if (dst === undefined) {
        problems.push(`pool ${pool}: no slot left in its range for ${t.b}; it stays in slot ${t.slot}`);
        continue;
      }
      want.set(t.b, dst);
      taken.add(dst);
    }
  }
  // tapes occupying a slot someone else wants, without a place of their own: evict them to a slot
  // that is free once the planned moves are done (preferably outside all ranges)
  const inRange = new Set([...layout.values()].flat());
  const evict = [...content].filter(([s, b]) => b && !want.has(b) && taken.has(s) && !fixed(s, b));
  const occupiedAfter = new Set<number>(want.values());
  for (const [s, b] of content) if (b && !want.has(b) && !evict.some(([es]) => es === s)) occupiedAfter.add(s);
  for (const [s, b] of evict) {
    const free = storage.filter((x) => x !== cfg.cleaningSlot && !occupiedAfter.has(x));
    const dst = free.find((x) => !inRange.has(x)) ?? free[0];
    if (dst === undefined) {
      problems.push(`slot ${s} (${b}) blocks pool ${poolOfSlot(layout, s)} but no slot is free after the moves`);
      continue;
    }
    want.set(b!, dst);
    occupiedAfter.add(dst);
  }

  // order the moves
  const pending = new Map<string, { src: number; dst: number }>();
  for (const [b, dst] of want) {
    const src = [...content].find(([, x]) => x === b)?.[0];
    if (src !== undefined && src !== dst) pending.set(b, { src, dst });
  }
  const moves: TransferStep[] = [];
  const why = (b: string, dst: number) => {
    const pool = poolOf(b);
    const t = poolOfSlot(layout, dst);
    return t && pool === t ? `${b} (pool ${pool}) into its pool range` : `${b} out of the way`;
  };
  let guard = 0;
  while (pending.size > 0 && guard++ < 1000) {
    const ready = [...pending].find(([, m]) => content.get(m.dst) === null);
    if (ready) {
      const [b, m] = ready;
      moves.push({ kind: "transfer", src: m.src, dst: m.dst, barcode: b, why: why(b, m.dst) });
      content.set(m.src, null);
      content.set(m.dst, b);
      pending.delete(b);
      continue;
    }
    // cycle: park one tape in a free slot that no pending move targets
    const targets = new Set([...pending.values()].map((m) => m.dst));
    // last resort: an empty mail slot as buffer (the tape comes back in a later move)
    const buffer =
      storage.find((x) => content.get(x) === null && !targets.has(x) && x !== cfg.cleaningSlot) ??
      [...mail].find((m) => mtx.slotStates.some((x) => x.slot === m && !x.full) && (content.get(m) ?? null) === null);
    if (buffer === undefined) {
      problems.push("rearrangement needs a free buffer slot to break a cycle but neither a storage slot nor a mail slot is free");
      break;
    }
    const [b, m] = [...pending][0];
    moves.push({ kind: "transfer", src: m.src, dst: buffer, barcode: b, why: `${b} parked in ${mail.has(buffer) ? "mail slot" : "free slot"} ${buffer} to break a cycle` });
    content.set(m.src, null);
    content.set(buffer, b);
    pending.set(b, { src: buffer, dst: m.dst });
  }
  return { moves, problems };
}

const transferCmd = (cfg: ArchiwareConfig, src: number, dst: number): string[] => ["sudo", "-n", "mtx", "-f", cfg.changer, "transfer", String(src), String(dst)];
const describeStep = (cfg: ArchiwareConfig, st: Step): string => {
  switch (st.kind) {
    case "transfer":
      return `transfer slot ${st.src} -> ${st.dst} (${st.barcode}): ${describeRemote(cfg, transferCmd(cfg, st.src, st.dst).map(shellQuote).join(" "))}`;
    case "human_put":
      return `HUMAN: put ${st.barcode === "?" ? "the tape" : `tape ${st.barcode}`} into mail slot ${st.mailSlot}, then call library_step again`;
    case "human_take":
      return `HUMAN: take tape ${st.barcode} out of mail slot ${st.mailSlot}, then call library_step again`;
    case "finish":
      return "P5 jukebox inventory, then compare P5 locations with mtx, check cleaningSlot and plan events (library_reconcile)";
  }
};

// ---------------------------------------------------------------------------
// export / import plans
// ---------------------------------------------------------------------------

/** Find the storage slot of a tape given a barcode or P5 volume label. */
export function findTape(snap: Snapshot, ref: string): { barcode: string; slot: number | null; drive: number | null; label: string | null } {
  const r = ref.trim().toUpperCase();
  const vol = snap.vols.find((v) => (v.barcode ?? "").toUpperCase() === r || (v.label ?? "").toUpperCase() === r);
  const barcode = (vol?.barcode ?? ref).toUpperCase();
  const slot = snap.mtx.slotStates.find((s) => s.full && (s.barcode ?? "").toUpperCase() === barcode);
  const drive = snap.mtx.driveStates.find((d) => d.full && (d.barcode ?? "").toUpperCase() === barcode);
  if (!slot && !drive) throw new P5Error(`tape ${ref} is not in the library${vol && !vol.barcode ? " (volume has no barcode: offsite)" : ""}`);
  return { barcode, slot: slot?.slot ?? null, drive: drive?.drive ?? null, label: vol?.label ?? null };
}

export function planExport(cfg: ArchiwareConfig, snap: Snapshot, ref: string): { steps: Step[]; note: string } {
  const t = findTape(snap, ref);
  if (t.drive !== null) throw new P5Error(`tape ${t.barcode} is loaded in drive ${t.drive}; unload it first`);
  const mailSet = new Set(mailSlotsOf(cfg, snap.mtx));
  if (t.slot !== null && mailSet.has(t.slot)) throw new P5Error(`tape ${t.barcode} is already in mail slot ${t.slot}`);
  const free = [...mailSet].find((m) => snap.mtx.slotStates.find((s) => s.slot === m && !s.full));
  if (free === undefined) throw new P5Error(mailSet.size === 0 ? "the library reports no mail slot (set mailSlots in the config)" : "no free mail slot");
  return {
    steps: [
      { kind: "transfer", src: t.slot!, dst: free, barcode: t.barcode, why: "export to mail slot" },
      { kind: "human_take", barcode: t.barcode, mailSlot: free },
      { kind: "finish" },
    ],
    note: `Moves ${t.barcode}${t.label ? ` (${t.label})` : ""} from slot ${t.slot} to mail slot ${free}; afterwards a human takes it out.`,
  };
}

export function planImport(cfg: ArchiwareConfig, snap: Snapshot, mailSlot?: number): { steps: Step[]; note: string; needsHuman: boolean } {
  const mailSet = mailSlotsOf(cfg, snap.mtx);
  const m = mailSlot ?? mailSet[0];
  if (m === undefined || !mailSet.includes(m)) throw new P5Error(`mail slot ${mailSlot ?? "?"} is not a mail slot (known: ${mailSet.join(", ") || "none"})`);
  const cur = snap.mtx.slotStates.find((s) => s.slot === m);
  const barcode = cur?.full ? cur.barcode : null;
  const layout = layoutSlots(cfg);
  const occupied = (slot: number) => snap.mtx.slotStates.some((s) => s.slot === slot && s.full) || snap.mtx.driveStates.some((d) => d.full && d.loadedFromSlot === slot);
  const pickDst = (b: string): { dst: number; why: string } => {
    const pool = snap.byBarcode.get(b.toUpperCase())?.pool ?? null;
    const own = pool ? layout.get(pool) ?? [] : [];
    const dstOwn = own.find((s) => !occupied(s));
    if (dstOwn !== undefined) return { dst: dstOwn, why: `free slot of pool ${pool}` };
    const inRange = new Set([...layout.values()].flat());
    const storage = snap.mtx.slotStates.filter((s) => !mailSet.includes(s.slot) && s.slot !== cfg.cleaningSlot);
    const free = storage.find((s) => !s.full && !occupied(s.slot) && !inRange.has(s.slot)) ?? storage.find((s) => !s.full && !occupied(s.slot));
    if (!free) throw new P5Error(`no free slot for ${b}`);
    return { dst: free.slot, why: pool && own.length ? `pool ${pool}'s slots are full, first free slot` : "first free slot" };
  };
  const steps: Step[] = [];
  if (!barcode) {
    // Barcode is only known once the human has put the tape in; the transfer step is planned with a placeholder resolved at step time.
    steps.push({ kind: "human_put", barcode: "?", mailSlot: m });
    steps.push({ kind: "transfer", src: m, dst: 0, barcode: "?", why: "import from mail slot (target resolved when the tape is there)" });
  } else {
    const p = pickDst(barcode);
    steps.push({ kind: "transfer", src: m, dst: p.dst, barcode, why: `import: ${p.why}` });
  }
  steps.push({ kind: "finish" });
  return {
    steps,
    needsHuman: !barcode,
    note: barcode ? `Moves ${barcode} from mail slot ${m} to slot ${(steps[0] as TransferStep).dst}.` : `Mail slot ${m} is empty: a human puts a tape in first; the target slot is then chosen by the tape's pool.`,
  };
}

/** Resolve placeholders of an import transfer once the tape is physically in the mail slot. */
export function resolveImportStep(cfg: ArchiwareConfig, snap: Snapshot, step: TransferStep): TransferStep {
  const cur = snap.mtx.slotStates.find((s) => s.slot === step.src);
  if (!cur?.full || !cur.barcode) throw new P5Error(`mail slot ${step.src} is empty`);
  const p = planImport(cfg, snap, step.src).steps[0] as TransferStep;
  return { ...p, why: p.why };
}

// ---------------------------------------------------------------------------
// offsite
// ---------------------------------------------------------------------------

export type Where = { where: "drive"; drive: number } | { where: "slot"; slot: number } | { where: "mail"; slot: number } | { where: "offsite" };

export const whereText = (w: Where) => (w.where === "drive" ? `drive ${w.drive}` : w.where === "slot" ? `library slot ${w.slot}` : w.where === "mail" ? `mail slot ${w.slot}` : "not in the library (offsite)");

/** Pure: where a barcode currently is. */
export function locate(cfg: ArchiwareConfig, mtx: ops.MtxStatus, barcode: string | null): Where {
  if (!barcode) return { where: "offsite" };
  const b = barcode.toUpperCase();
  const d = mtx.driveStates.find((x) => x.full && (x.barcode ?? "").toUpperCase() === b);
  if (d) return { where: "drive", drive: d.drive };
  const s = mtx.slotStates.find((x) => x.full && (x.barcode ?? "").toUpperCase() === b);
  if (s) return mailSlotsOf(cfg, mtx).includes(s.slot) ? { where: "mail", slot: s.slot } : { where: "slot", slot: s.slot };
  return { where: "offsite" };
}

export async function offsiteStatus(cfg: ArchiwareConfig) {
  const snap = await snapshot(cfg);
  const pools = await ops.pools(cfg);
  const byId = new Map(snap.vols.map((v) => [v.id, v]));
  const out = pools
    .filter((p) => /tape/i.test(p.mediatype ?? "") && /backup/i.test(p.usage ?? "backup"))
    .map((p) => {
      const vols = p.volumes.map((id) => byId.get(id)).filter((v): v is ops.VolumeInfo => Boolean(v));
      const rows = vols.map((v) => ({ id: v.id, label: v.label, barcode: v.barcode, mode: v.mode, ...locate(cfg, snap.mtx, v.barcode) }));
      const inLib = rows.filter((r) => r.where === "slot" || r.where === "drive");
      const inMail = rows.filter((r) => r.where === "mail");
      const out = rows.filter((r) => r.where === "offsite");
      const warnings: string[] = [];
      if (rows.length > 0 && out.length === 0) warnings.push("no volume of this pool is out of the house");
      return { pool: p.name, volumes: rows, inLibrary: inLib.length, inMailSlot: inMail.length, out: out.length, warnings };
    });
  return { pools: out, warnings: out.flatMap((p) => p.warnings.map((w) => `pool ${p.pool}: ${w}`)) };
}

// ---------------------------------------------------------------------------
// restore finder
// ---------------------------------------------------------------------------

/** "Incremental save of: /a/b to pool Daily." -> { root, pool, level } */
export function parseSource(source: string | null): { level: string; root: string; pool: string | null } | null {
  const m = source?.match(/^(\w+) save of:\s*(.+?)(?:\s+to pool (.+?))?\.?$/);
  return m ? { level: m[1], root: m[2].replace(/\/+$/, "") || "/", pool: m[3] ?? null } : null;
}

export interface RestoreVersion {
  /** backup time, server-local "YYYY-MM-DD HH:MM" */
  start: string;
  btime: number;
  mtime: string | null;
  type: string;
  sizeBytes: number;
  plan: string | null;
  event: string | null;
  level: string | null;
  /** Volumes holding a copy of this version (any one is enough to restore it). */
  volumes: { id: string; label: string | null; barcode: string | null; pool: string | null; where: Where; location: string }[];
  /** true when at least one copy is in the library (slot, drive or mail slot). */
  available: boolean;
}

const localStamp = (sec: number) => {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * Every backed-up version of a file or folder, from the client's backup index
 * (P5 keeps one per client: <config>/index/backup/bsx_<client>), with the
 * volume copies that hold each version and where each tape is now. The index
 * is read directly and read-only (see p5db.ts for why nsdchat/REST cannot).
 * Never lists a volume inventory.
 */
export async function restoreOptions(cfg: ArchiwareConfig, path: string, opts: { limit?: number; since?: string; client?: string; light?: boolean } = {}) {
  const p = path.replace(/\/+$/, "") || "/";
  if (!p.startsWith("/")) throw new P5Error("path must be absolute (as P5 sees it)");
  const client = opts.client ?? "localhost";
  const since = opts.since ? Date.parse(`${opts.since}T00:00:00`) / 1000 : undefined;
  if (opts.since && !Number.isFinite(since)) throw new P5Error(`invalid since "${opts.since}", expected YYYY-MM-DD`);
  const found = await indexVersions(cfg, client, p, since);
  // light: only the volumes of the listed versions (restore of one version); full: every volume (fetch list)
  const wanted = [...new Set(found.slice(0, opts.limit ?? 100).flatMap((v) => v.volumes))];
  const snap = opts.light ? { mtx: ops.parseMtx(await mtxStatus(cfg)), vols: await ops.volumesByIds(cfg, wanted) } : await snapshot(cfg);
  const byId = new Map(snap.vols.map((v) => [v.id, v]));
  const planIds = [...new Set(found.map((v) => v.plan).filter((x): x is string => !!x))];
  const pd = planIds.length ? await nsdchatCalls(cfg, planIds.map((id) => ["BackupPlan", id, "describe"])) : [];
  const planName = new Map(planIds.map((id, i) => [id, pd[i]?.rc === 0 ? pd[i].out.trim() : id]));
  const poolOf = new Map<string, string | null>();
  if (!opts.light) for (const pl of await ops.pools(cfg)) for (const v of pl.volumes) poolOf.set(v, pl.name);
  const versions: RestoreVersion[] = found.slice(0, opts.limit ?? 100).map((v) => {
    const volumes = v.volumes.map((id) => {
      const vi = byId.get(id);
      const w = locate(cfg, snap.mtx, vi?.barcode ?? null);
      return { id, label: vi?.label ?? null, barcode: vi?.barcode ?? null, pool: poolOf.get(id) ?? null, where: w, location: vi ? whereText(w) : "volume unknown to P5 (recycled?)" };
    });
    return {
      start: localStamp(v.btime),
      btime: v.btime,
      mtime: v.mtime ? localStamp(v.mtime) : null,
      type: v.type,
      sizeBytes: v.size,
      plan: v.plan ? (planName.get(v.plan) ?? v.plan) : null,
      event: v.event,
      level: v.level === null ? null : v.level === 1 ? "full" : "incremental",
      volumes,
      available: volumes.some((x) => byId.has(x.id) && x.where.where !== "offsite"),
    };
  });
  return {
    path: p,
    client,
    versions,
    fetchList: fetchList(versions),
    note: "Versions come from P5's backup index of the client (read-only). Each version lists every volume holding a copy; one copy in the library is enough. A folder's versions are the runs that saved the folder entry itself; its files have their own versions.",
  };
}

/** Tapes still to fetch: for every version with no copy in the library, its first copy. */
export function fetchList(versions: RestoreVersion[]) {
  const m = new Map<string, { barcode: string | null; label: string | null; volume: string; versions: string[] }>();
  for (const v of versions) {
    if (v.available || v.volumes.length === 0) continue;
    const vol = v.volumes[0];
    const k = vol.barcode ?? vol.id;
    const e = m.get(k) ?? { barcode: vol.barcode, label: vol.label, volume: vol.id, versions: [] };
    e.versions.push(v.start);
    m.set(k, e);
  }
  return [...m.values()];
}

export async function offsiteFetchList(cfg: ArchiwareConfig, path: string) {
  const r = await restoreOptions(cfg, path);
  return { path: r.path, fetchList: r.fetchList };
}

/**
 * Restore one chosen version (`at` = the start printed by restore_options, "YYYY-MM-DD HH:MM", or its unix btime)
 * of a path from a P5 BACKUP into a directory.
 *
 * P5's CLI (and REST) have no call that selects one path/version of a BACKUP index: RestoreSelection addentry
 * takes only ARCHIVE entry handles, and the only backup-capable call, addfromvolume, restores the whole volume
 * (volume inventories carry no handle for backup entries). So this never starts a P5 job: it returns the full
 * preview (version, volumes with barcode and location, destination, bytes, free space, bounded tree, conflicts,
 * policy, planId) plus the exact P5 GUI steps; a confirmed call with the planId prepares the destination folder.
 * Preview data comes from the catalogue copy of the index when the client is indexed, else from P5's SQLite index.
 */
export async function restoreVersion(cfg: ArchiwareConfig, at: string, path: string, safety: Safety, client?: string) {
  path = path.replace(/\/+$/, "") || "/";
  if (!path.startsWith("/")) throw new P5Error("path must be absolute");
  if (safety.to === "original") throw new P5Error("restore into a folder (default) and move what you need; in-place P5 restores are not offered");
  if (safety.onConflict === "rename") throw new P5Error("--on-conflict rename is not possible for a P5 restore; use refuse or overwrite");
  const cl = client ?? "localhost";
  const opts = await restoreOptions(cfg, path, { client: cl, light: true });
  const v = opts.versions.find((x) => x.start === at || String(x.btime) === at);
  if (!v) throw new P5Error(`no version "${at}" of ${path}; run restore_options first (starts: ${opts.versions.slice(0, 5).map((x) => x.start).join(", ") || "none"})`);
  if (v.volumes.length === 0) throw new P5Error(`version ${v.start} has no volume recorded`);
  const usable = v.volumes.filter((x) => x.where.where !== "offsite");
  if (usable.length === 0) throw new P5Error(`no copy of this version is in the library; fetch one of: ${v.volumes.map((x) => `${x.barcode ?? "(no barcode)"} ${x.label ?? ""} (volume ${x.id})`).join(", ")} and import it (tape_import), then retry`);
  const volText = (x: (typeof v.volumes)[number]) => `${x.label ?? x.id} (volume ${x.id}, barcode ${x.barcode ?? "none"}, ${x.location})`;
  const source = `P5 backup of ${cl}, version ${v.start} (${v.level ?? "?"}); volume(s): ${v.volumes.map(volText).join(" | ")}`;
  const g = beginGuard(cfg, safety, { p5: true });
  const pv = await indexPreview(cfg, cl, path, v.btime);
  const guard = await finishGuard(
    cfg,
    g,
    {
      sourceKey: `p5-backup:${cl}:${path}:${v.btime}`,
      source,
      inContainer: true,
      files: pv.files.map((f) => ({ ...f, dest: destOf(g, f.dest) })),
      totals: pv.totals,
      notes: [
        "P5 lays the restored tree out as <destination>/<original absolute path>",
        `preview from ${pv.from === "catalog-db" ? "the catalogue copy of the P5 backup index" : "P5's backup index"} at the chosen version${pv.kind === "dir" ? " (direct entries of the folder; subfolders are not expanded)" : ""}`,
      ],
    },
    safety,
  );
  const base = cfg.restUrl || "<P5 web address>";
  const dest = g.base;
  const manual = {
    executedByTool: false,
    why: "P5's CLI/REST cannot select one path of a backup version (RestoreSelection addentry needs an archive handle; addfromvolume would restore the whole volume). Nothing was started.",
    p5: base,
    steps: [
      `open ${base} and sign in`,
      `Restore > Backup: client ${cl}`,
      `navigate to ${path}${pv.kind === "dir" ? " (select the folder)" : ""}`,
      `pick the backup date ${v.start}`,
      `restore to folder ${dest} (a relocate directory on the client; it must exist: re-run with --yes --plan <planId> to create it)`,
      `keep the conflict policy: ${g.policy}`,
    ],
    volumesNeeded: v.volumes.map((x) => ({ volume: x.id, label: x.label, barcode: x.barcode, location: x.location })),
  };
  if (!guard.proceed) return { ...guard.preview, executed: false as const, manual };
  await ops.containerExec(cfg, ["mkdir", "-p", dest]);
  return { ...guard.preview, confirmationRequired: false as const, executed: false as const, destinationPrepared: dest, manual };
}

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

/** "<jukebox> : Slot  4" or "...: Drive 1::Slot 4" -> 4 */
export function p5SlotOf(location: string | null): number | null {
  const m = location?.match(/Slot\s+(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

export interface Reconcile {
  locationMismatches: { volume: string; label: string | null; barcode: string; p5: string | null; mtx: string }[];
  cleaning: { configured: number; actual: number | null; changed: boolean; fixed?: boolean };
  planWarnings: string[];
  manual: string[];
}

export function compareLocations(cfg: ArchiwareConfig, mtx: ops.MtxStatus, vols: ops.VolumeInfo[]) {
  const out: Reconcile["locationMismatches"] = [];
  for (const v of vols) {
    if (!v.barcode) continue;
    const w = locate(cfg, mtx, v.barcode);
    if (w.where === "offsite") continue;
    const p5 = p5SlotOf(v.location);
    // a tape in a drive reports its home slot in P5 and mtx alike; compare to the mtx slot or loadedFromSlot
    const want = w.where === "slot" || w.where === "mail" ? w.slot : mtx.driveStates.find((d) => d.drive === (w as { drive: number }).drive)?.loadedFromSlot ?? null;
    if (p5 !== want) out.push({ volume: v.id, label: v.label, barcode: v.barcode, p5: v.location, mtx: whereText(w) });
  }
  return out;
}

async function planEventWarnings(cfg: ArchiwareConfig, mtx: ops.MtxStatus, vols: ops.VolumeInfo[]): Promise<string[]> {
  const warnings: string[] = [];
  const pools = await ops.pools(cfg);
  const tapePools = new Set(pools.filter((p) => /tape/i.test(p.mediatype ?? "")).map((p) => p.name));
  const usable = (poolName: string) =>
    vols.filter((v) => v.pool === poolName && /^(appendable|recyclable|blank)$/i.test(v.mode ?? "") && locate(cfg, mtx, v.barcode).where !== "offsite" && locate(cfg, mtx, v.barcode).where !== "mail").length;
  const planIds = parseTclList(await nsdchat(cfg, ["BackupPlan", "names"]).catch(() => ""));
  // next run per plan: smallest runat of its scheduled jobs
  const sched = parseTclList(await nsdchat(cfg, ["Job", "names"]).catch(() => ""));
  const jr = sched.length ? await nsdchatCalls(cfg, sched.flatMap((j) => [["Job", j, "describe"], ["Job", j, "runat"]])) : [];
  const nextByPlan = new Map<string, number>();
  sched.forEach((_, i) => {
    const d = jr[2 * i]?.out.trim().replace(/ - '.*'$/, "") ?? "";
    const t = Number(jr[2 * i + 1]?.out.trim());
    if (d && t > 0 && (!nextByPlan.has(d) || t < nextByPlan.get(d)!)) nextByPlan.set(d, t);
  });
  for (const id of planIds) {
    const pl = await ops.plan(cfg, id);
    if (!pl.enabled) continue;
    const next = nextByPlan.get(pl.describe ?? "");
    for (const pool of new Set(pl.events.map((e) => e.pool).filter((x): x is string => Boolean(x)))) {
      if (!tapePools.has(pool) || usable(pool) > 0) continue;
      warnings.push(`plan ${pl.describe ?? id}: pool ${pool} has no appendable volume in the library${next ? `; next run ${ops.posixToLocal(String(next)) ?? next}` : "; next run unknown"}`);
    }
  }
  return warnings;
}

/** Update `cleaningSlot` in the config file when the CLN* tape moved. */
export function fixCleaningSlot(file: string, slot: number): void {
  const raw = readConfigFile(file) as Record<string, unknown>;
  raw.cleaningSlot = slot;
  writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
}

export async function reconcile(cfg: ArchiwareConfig, fix: boolean, opts: { mtx?: ops.MtxStatus; vols?: ops.VolumeInfo[]; simulate?: boolean } = {}): Promise<Reconcile> {
  const mtx = opts.mtx ?? ops.parseMtx(await mtxStatus(cfg));
  const vols = opts.vols ?? (await ops.volumes(cfg));
  const cln = mtx.slotStates.find((s) => s.full && isCleaning(s.barcode)) ?? null;
  const clnDrive = mtx.driveStates.find((d) => d.full && isCleaning(d.barcode));
  const actual = cln?.slot ?? clnDrive?.loadedFromSlot ?? null;
  const cleaning: Reconcile["cleaning"] = { configured: cfg.cleaningSlot, actual, changed: actual !== null && actual !== cfg.cleaningSlot };
  if (cleaning.changed && fix && !opts.simulate) {
    fixCleaningSlot(configPath(), actual!);
    cleaning.fixed = true;
  }
  const manual = [
    "P5 stores media locations per volume (refreshed by the jukebox inventory). The CLI and REST expose no jukebox setting for the cleaning slot, reserved slots or mail slot (REST jukebox detail has slotcount only): if the P5 GUI (Jukebox > Settings) has reserved/cleaning slots configured, check them there.",
  ];
  const planWarnings = opts.simulate ? ["(simulated: plan events are checked against the live P5 state in a real run)"] : await planEventWarnings(cfg, mtx, vols).catch((e) => [`plan check failed: ${(e as Error).message}`]);
  return { locationMismatches: compareLocations(cfg, mtx, vols), cleaning, planWarnings, manual };
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

export interface Session {
  id: string;
  created: string;
  op: "arrange" | "export" | "import";
  simulate: boolean;
  note: string;
  steps: Step[];
  done: number;
  state: "open" | "finished" | "aborted";
  virtual?: ops.MtxStatus;
  log: string[];
}

export const sessionFile = () => join(dirname(configPath()), "library_session.json");

export function loadSessions(file = sessionFile()): Record<string, Session> {
  try {
    return JSON.parse(readFileSync(file, "utf8")).sessions ?? {};
  } catch {
    return {};
  }
}
function saveSessions(s: Record<string, Session>, file = sessionFile()) {
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ sessions: s }, null, 2) + "\n", { mode: 0o600 });
}
function getSession(id: string): Session {
  const s = loadSessions()[id];
  if (!s) throw new P5Error(`unknown library session ${id}`);
  return s;
}
function putSession(s: Session) {
  const all = loadSessions();
  all[s.id] = s;
  saveSessions(all);
}

const view = (cfg: ArchiwareConfig, s: Session) => ({
  session: s.id,
  op: s.op,
  simulated: s.simulate,
  state: s.state,
  note: s.note,
  done: s.steps.slice(0, s.done).map((st, i) => `${i + 1}. ${describeStep(cfg, st)}`),
  next: s.state === "open" && s.done < s.steps.length ? `${s.done + 1}. ${describeStep(cfg, s.steps[s.done])}` : null,
  remaining: s.steps.slice(s.done + 1).map((st, i) => `${s.done + 2 + i}. ${describeStep(cfg, st)}`),
});

export async function libraryPlan(cfg: ArchiwareConfig, kind: "arrange" | "export" | "import", arg: { ref?: string; mailSlot?: number }, simulate = false) {
  const open = Object.values(loadSessions()).find((s) => s.state === "open" && s.simulate === simulate);
  if (open) throw new P5Error(`library session ${open.id} (${open.op}) is still open: finish it with library_step or stop it with library_abort`);
  const snap = await snapshot(cfg);
  let steps: Step[];
  let note: string;
  let problems: string[] = [];
  if (kind === "arrange") {
    const a = computeArrange(cfg, snap.mtx, snap.byBarcode);
    steps = [...a.moves, { kind: "finish" } as Step];
    problems = a.problems;
    note = a.moves.length ? `${a.moves.length} move(s) to reach the slotLayout.` : "Library already matches the slotLayout.";
  } else if (kind === "export") {
    if (!arg.ref) throw new P5Error("tape (barcode or volume label) required");
    ({ steps, note } = planExport(cfg, snap, arg.ref));
  } else {
    ({ steps, note } = planImport(cfg, snap, arg.mailSlot));
  }
  if (steps.length === 1 && kind === "arrange") return { nothingToDo: true, note, problems };
  const s: Session = { id: `lib-${Date.now().toString(36)}`, created: new Date().toISOString(), op: kind, simulate, note, steps, done: 0, state: "open", virtual: simulate ? snap.mtx : undefined, log: [] };
  putSession(s);
  return { ...view(cfg, s), problems, hint: "call library_step <session> (confirm) to execute exactly one step" };
}

export const libraryStatus = (cfg: ArchiwareConfig, id: string) => ({ ...view(cfg, getSession(id)), log: getSession(id).log.slice(-10) });

/** Apply one transfer/put/take to a virtual mtx state. */
function applyVirtual(m: ops.MtxStatus, st: Step) {
  const slot = (n: number) => m.slotStates.find((s) => s.slot === n);
  if (st.kind === "transfer") {
    const a = slot(st.src);
    const b = slot(st.dst);
    if (a && b) {
      b.full = true;
      b.barcode = a.barcode;
      a.full = false;
      a.barcode = null;
    }
  } else if (st.kind === "human_put") {
    const s = slot(st.mailSlot);
    if (s) {
      s.full = true;
      s.barcode = st.barcode === "?" ? "SIMULATED" : st.barcode;
    }
  } else if (st.kind === "human_take") {
    const s = slot(st.mailSlot);
    if (s) {
      s.full = false;
      s.barcode = null;
    }
  }
}

async function runInventory(cfg: ArchiwareConfig): Promise<string> {
  const jb = parseTclList(await nsdchat(cfg, ["Jukebox", "names"]).catch(() => ""))[0] ?? "";
  const jbName = jb || (await ops.slots(cfg)).jukebox;
  const r = (await ops.inventory(cfg, jbName, true, true)) as { result: string | null };
  const job = (r.result ?? "").trim();
  if (/^\d+$/.test(job)) {
    const deadline = Date.now() + cfg.longTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(10_000);
      const st = (await nsdchat(cfg, ["Job", job, "status"]).catch(() => "")).trim();
      if (st && !/^(running|pending|waiting|scheduled)$/i.test(st)) return `inventory job ${job} ${st}`;
    }
    return `inventory job ${job} still running after ${Math.round(cfg.longTimeoutMs / 1000)} s`;
  }
  return `inventory scheduled${r.result ? ` (${r.result})` : ""}`;
}

/**
 * Execute exactly one next step. Human steps are verified (read-only, no confirm).
 * Machine steps need confirm; without it the step is only described. Every step
 * re-checks busy state and the expected slot contents and stops if reality differs.
 */
export async function libraryStep(cfg: ArchiwareConfig, id: string, confirm: boolean, force = false) {
  const s = getSession(id);
  if (s.state !== "open") throw new P5Error(`session ${id} is ${s.state}`);
  let st = s.steps[s.done];
  if (!st) throw new P5Error(`session ${id} has no steps left`);
  const sim = s.simulate;
  const mtx = sim ? s.virtual! : ops.parseMtx(await mtxStatus(cfg));
  const stop = (why: string) => {
    s.log.push(`stopped at step ${s.done + 1}: ${why}`);
    putSession(s);
    return { ...view(cfg, s), executed: false, stopped: why };
  };
  const slotOf = (n: number) => mtx.slotStates.find((x) => x.slot === n);

  if (st.kind === "human_put" || st.kind === "human_take") {
    const slot = slotOf(st.mailSlot);
    if (st.kind === "human_put") {
      if (!sim && !slot?.full) return stop(`mail slot ${st.mailSlot} is still empty: ${describeStep(cfg, st)}`);
      const bc = sim ? (st.barcode === "?" ? "SIMULATED" : st.barcode) : slot!.barcode ?? "?";
      if (!sim && st.barcode !== "?" && (slot!.barcode ?? "").toUpperCase() !== st.barcode.toUpperCase()) return stop(`mail slot ${st.mailSlot} holds ${slot!.barcode}, expected ${st.barcode}`);
      if (st.barcode === "?") {
        s.steps[s.done] = { ...st, barcode: bc };
        const nxt = s.steps[s.done + 1];
        if (nxt?.kind === "transfer" && nxt.barcode === "?") {
          const snap = sim ? ({ mtx, vols: [], byBarcode: new Map() } as Snapshot) : await snapshot(cfg);
          if (sim) applyVirtual(mtx, { ...st, barcode: bc });
          try {
            if (sim) {
              const free = mtx.slotStates.find((x) => !x.full && x.slot !== nxt.src && !mailSlotsOf(cfg, mtx).includes(x.slot) && x.slot !== cfg.cleaningSlot);
              if (!free) throw new P5Error(`no free slot for ${bc}`);
              s.steps[s.done + 1] = { ...nxt, barcode: bc, dst: free.slot, why: "import (simulated target)" };
            } else s.steps[s.done + 1] = { ...resolveImportStep(cfg, snap, nxt) };
          } catch (e) {
            return stop(e instanceof Error ? e.message : String(e));
          }
        }
      } else if (sim) applyVirtual(mtx, st);
    } else {
      if (!sim && slot?.full) return stop(`tape ${slot.barcode} is still in mail slot ${st.mailSlot}: ${describeStep(cfg, st)}`);
      if (sim) applyVirtual(mtx, st);
    }
    s.done++;
    s.log.push(`step ${s.done}: ${describeStep(cfg, st)} confirmed`);
    if (sim) s.virtual = mtx;
    putSession(s);
    return { ...view(cfg, s), executed: true, human: true };
  }

  if (st.kind === "transfer") {
    const a = slotOf(st.src);
    const b = slotOf(st.dst);
    if (!a?.full || (st.barcode !== "?" && (a.barcode ?? "").toUpperCase() !== st.barcode.toUpperCase())) return stop(`slot ${st.src} holds ${a?.full ? a.barcode : "nothing"}, plan expected ${st.barcode}; library changed, create a new plan`);
    if (!b || b.full) return stop(`target slot ${st.dst} is ${b ? `occupied by ${b.barcode}` : "unknown"}; library changed, create a new plan`);
    if (mtx.driveStates.some((d) => d.full)) return stop(`a drive is loaded (${mtx.driveStates.filter((d) => d.full).map((d) => `${d.drive}:${d.barcode ?? "?"}`).join(", ")}); P5 or another process is using the library`);
    if (!confirm) return { ...view(cfg, s), executed: false, confirmationRequired: true, wouldRun: [describeStep(cfg, st)], note: "Re-run with confirm/--yes to execute exactly this step." };
    await guardBusy(cfg, mtx, cfg.drives, force);
    if (sim) {
      applyVirtual(mtx, st);
      s.virtual = mtx;
    } else {
      const r = await hostCommand(cfg, transferCmd(cfg, st.src, st.dst));
      if (r.rc !== 0) return stop(`mtx transfer ${st.src} ${st.dst} failed (exit ${r.rc}): ${r.stderr || r.stdout.trim()}`);
      const after = ops.parseMtx(await mtxStatus(cfg));
      const landed = after.slotStates.find((x) => x.slot === st!.dst);
      if (!landed?.full || (landed.barcode ?? "").toUpperCase() !== st.barcode.toUpperCase()) return stop(`after the move slot ${st.dst} holds ${landed?.full ? landed.barcode : "nothing"}, expected ${st.barcode}`);
    }
    s.done++;
    s.log.push(`step ${s.done}: moved ${st.barcode} ${st.src} -> ${st.dst}${sim ? " (simulated)" : ""}`);
    putSession(s);
    return { ...view(cfg, s), executed: true };
  }

  // finish: inventory + reconcile
  if (!confirm) return { ...view(cfg, s), executed: false, confirmationRequired: true, wouldRun: [describeStep(cfg, st)], note: "Re-run with confirm/--yes to execute exactly this step." };
  let inv = "skipped (simulated)";
  if (!sim) {
    await guardBusy(cfg, mtx, cfg.drives, force);
    inv = await runInventory(cfg);
  }
  const rec = await reconcile(cfg, true, sim ? { mtx, simulate: true, vols: await ops.volumes(cfg) } : {});
  s.done++;
  s.state = "finished";
  s.log.push(`step ${s.done}: finish: ${inv}`);
  putSession(s);
  return { ...view(cfg, s), executed: true, inventory: inv, reconcile: rec };
}

export async function libraryAbort(cfg: ArchiwareConfig, id: string) {
  const s = getSession(id);
  if (s.state !== "open") return { ...view(cfg, s), note: `session already ${s.state}` };
  let drives = "simulated session: no hardware touched";
  if (!s.simulate) {
    // Steps never leave a tape in a drive (transfer slot->slot only); verify it.
    const mtx = ops.parseMtx(await mtxStatus(cfg));
    const loaded = mtx.driveStates.filter((d) => d.full);
    drives = loaded.length ? `WARNING: drive(s) loaded: ${loaded.map((d) => `${d.drive} (${d.barcode ?? "?"}, from slot ${d.loadedFromSlot ?? "?"})`).join(", ")} — not loaded by this session; check P5 or use tape_unload` : "both drives empty";
  }
  s.state = "aborted";
  s.log.push(`aborted after ${s.done} step(s)`);
  putSession(s);
  return { ...view(cfg, s), drives, note: "Session aborted. Completed moves stay done; run library_reconcile to refresh P5 if tapes were moved." };
}

// ---------------------------------------------------------------------------
// one-shot confirm-gated wrappers
// ---------------------------------------------------------------------------

/** Dry plan without confirm; with confirm runs the whole plan as one session (machine steps only: refuses plans needing a human). */
export async function libraryArrange(cfg: ArchiwareConfig, confirm: boolean, force = false) {
  const snap = await snapshot(cfg);
  const a = computeArrange(cfg, snap.mtx, snap.byBarcode);
  const loaded = snap.mtx.driveStates.filter((d) => d.full);
  const steps: Step[] = [...a.moves, { kind: "finish" }];
  if (!confirm) {
    return {
      confirmationRequired: true as const,
      note: a.problems.length && !a.moves.length ? `Cannot reach the slotLayout: ${a.problems.length} problem(s), see below.` : a.moves.length ? `${a.moves.length} mtx transfer move(s) to reach the slotLayout; afterwards a P5 jukebox inventory and reconcile.${loaded.length ? " WARNING: a drive is loaded now; the real run would refuse." : ""}` : "Library already matches the slotLayout; nothing to move.",
      wouldRun: steps.map((st, i) => `${i + 1}. ${describeStep(cfg, st)}`),
      moves: a.moves,
      problems: a.problems,
    };
  }
  if (a.moves.length === 0) return { confirmationRequired: false as const, moves: 0, note: "Library already matches the slotLayout." };
  if (a.problems.length) throw new P5Error(`plan has problems: ${a.problems.join("; ")}`);
  await guardBusy(cfg, snap.mtx, cfg.drives, force);
  const plan = (await libraryPlan(cfg, "arrange", {}, false)) as { session: string };
  let last: unknown;
  for (let i = 0; i < steps.length; i++) {
    last = await libraryStep(cfg, plan.session, true, force);
    if ((last as { stopped?: string }).stopped) break;
  }
  return { confirmationRequired: false as const, session: plan.session, result: last };
}

export async function tapeExport(cfg: ArchiwareConfig, ref: string, confirm: boolean, force = false) {
  const snap = await snapshot(cfg);
  const p = planExport(cfg, snap, ref);
  if (!confirm) return { confirmationRequired: true as const, note: p.note, wouldRun: p.steps.map((st, i) => `${i + 1}. ${describeStep(cfg, st)}`) };
  await guardBusy(cfg, snap.mtx, cfg.drives, force);
  const plan = (await libraryPlan(cfg, "export", { ref })) as { session: string };
  const r = await libraryStep(cfg, plan.session, true, force);
  return { confirmationRequired: false as const, ...r, hint: "take the tape out of the mail slot, then call library_step to finish (inventory + reconcile)" };
}

export async function tapeImport(cfg: ArchiwareConfig, mailSlot: number | undefined, confirm: boolean, force = false) {
  const snap = await snapshot(cfg);
  const p = planImport(cfg, snap, mailSlot);
  if (!confirm) return { confirmationRequired: true as const, note: p.note, wouldRun: p.steps.map((st, i) => `${i + 1}. ${describeStep(cfg, st)}`) };
  await guardBusy(cfg, snap.mtx, cfg.drives, force);
  const plan = (await libraryPlan(cfg, "import", { mailSlot })) as { session: string };
  const first = await libraryStep(cfg, plan.session, true, force);
  return { confirmationRequired: false as const, ...first, hint: "call library_step to continue" };
}
