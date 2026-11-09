/**
 * Restore destination safety shared by restore_version, catalog_restore and restore (P5).
 *
 *   - default destination is a restore folder: <restoreRoot>/<YYYYMMDD-HHMMSS>/<original absolute path>
 *   - restoring to the original location needs an explicit to:"original"; any other `to` places the
 *     original absolute path under that directory
 *   - the plan (no confirm) shows host, destination, source, bytes, free space, a short tree and every
 *     destination file that already exists (size+mtime now vs restored)
 *   - conflict policy: refuse (default), rename (<name>.restored-YYYYMMDD) or overwrite
 *   - syncRoots: destinations below a sync root get a warning; original inside one is refused without forceSync
 *   - planId binds the execute call to the plan that was shown: <stamp>-<hash>; the stamp names the
 *     restore folder, so the execute call lands where the preview said
 */

import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { ArchiwareConfig } from "./config.js";
import { hostCommand, p5Exec, P5Error } from "./transport.js";

export type OnConflict = "refuse" | "rename" | "overwrite";
export type DestMode = "restore-folder" | "original" | "directory";

export interface Safety {
  /** undefined = restore folder, "original" = original location, else a directory (absolute) */
  to?: string;
  onConflict?: string;
  forceSync?: boolean;
  /** planId from the preview; required with confirm */
  plan?: string;
  confirm: boolean;
  /** internal: a scratch restore of this tool itself (fresh directory); skips plan binding */
  trusted?: boolean;
}

export interface Guard {
  stamp: string;
  mode: DestMode;
  /** "" for original, else absolute directory; entries land at base + original absolute path */
  base: string;
  policy: OnConflict;
  planGiven: boolean;
  suffix: string;
}

export interface GuardFile {
  /** absolute destination path */
  dest: string;
  size: number;
  /** restored mtime: epoch seconds or a "YYYY-MM-DD HH:MM:SS" text */
  mtime?: string | number | null;
  /** directory entries are never conflicts */
  dir?: boolean;
}

export interface GuardInput {
  /** version key of the source (identifies what is restored) */
  sourceKey: string;
  /** human text of the chosen source: "disk-tar <tar>", "tape volume X barcode Y" */
  source: string;
  files: GuardFile[];
  /** P5-side restore: stat/df run inside the P5 container (docker mode) */
  inContainer: boolean;
  /** extra lines for the plan */
  notes?: string[];
  /** when `files` is only a bounded head of a bigger set: the real totals (entries, bytes of non-directory entries) */
  totals?: { entries: number; bytes: number };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function newStamp(d = new Date()): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const PLAN_RE = /^(\d{8}-\d{6})-([0-9a-f]{6})$/;

const trimSlash = (p: string) => p.replace(/\/+$/, "") || (p ? "/" : "");

export const isUnderPath = (p: string, root: string) => {
  const r = trimSlash(root);
  return r === "/" || p === r || p.startsWith(r + "/");
};

/** restoreRoot as the P5 container sees it (packRootP5 mapping), for P5-side restores. */
export function p5View(cfg: ArchiwareConfig, hostPath: string): string {
  if (cfg.packRootP5 && cfg.packRootP5 !== cfg.packRoot && isUnderPath(hostPath, cfg.packRoot)) return cfg.packRootP5 + hostPath.slice(trimSlash(cfg.packRoot).length);
  return hostPath;
}

/** Decide destination mode and base directory; the stamp comes from the plan id when one is given. */
export function beginGuard(cfg: ArchiwareConfig, s: Safety, opts: { p5?: boolean } = {}): Guard {
  let stamp = newStamp();
  if (s.plan) {
    const m = PLAN_RE.exec(s.plan.trim());
    if (!m) throw new P5Error(`plan "${s.plan}" is not a plan id (form 20260101-120000-ab12cd, printed by the preview)`);
    stamp = m[1];
  }
  const policy = (s.onConflict ?? "refuse") as OnConflict;
  if (!["refuse", "rename", "overwrite"].includes(policy)) throw new P5Error(`--on-conflict must be refuse, rename or overwrite (got "${s.onConflict}")`);
  let mode: DestMode;
  let base: string;
  if (!s.to) {
    mode = "restore-folder";
    const root = opts.p5 ? p5View(cfg, cfg.restoreRoot) : cfg.restoreRoot;
    base = `${trimSlash(root)}/${stamp}`;
  } else if (s.to === "original") {
    mode = "original";
    base = "";
  } else {
    if (!s.to.startsWith("/")) throw new P5Error('--to must be "original" or an absolute directory on the P5 host');
    mode = "directory";
    base = trimSlash(posix.normalize(s.to));
    if (base === "/") throw new P5Error('--to / would be the original location: say --to original');
  }
  return { stamp, mode, base, policy, planGiven: Boolean(s.plan), suffix: `.restored-${stamp.slice(0, 8)}` };
}

/** Destination of a file originally at `abs` (absolute). */
export const destOf = (g: Guard, abs: string): string => posix.normalize(g.base + abs);

const STAT_SCRIPT = String.raw`
for f; do
  if [ -d "$f" ] && [ ! -L "$f" ]; then continue; fi
  if [ -e "$f" ] || [ -L "$f" ]; then
    s=$(stat -c '%s %Y' "$f" 2>/dev/null || stat -f '%z %m' "$f" 2>/dev/null)
    printf 'C\t%s\t%s\n' "$s" "$f"
  fi
done
exit 0
`;

const DF_SCRIPT = String.raw`
d="$1"
while [ ! -d "$d" ] && [ "$d" != "/" ]; do d=$(dirname "$d"); done
printf 'D\t%s\t%s\n' "$d" "$(df -Pk "$d" | tail -1 | awk '{print $4}')"
exit 0
`;

async function sh(cfg: ArchiwareConfig, inContainer: boolean, script: string, args: string[]) {
  const argv = ["sh", "-c", script, "guard", ...args];
  const r = await hostCommand(cfg, inContainer ? p5Exec(cfg, argv) : argv, 120_000);
  if (r.rc !== 0) throw new P5Error(`destination check failed (exit ${r.rc}): ${r.stderr}`);
  return r.stdout;
}

const MAX_CHECK = 50_000;
const iso = (epoch: number) => new Date(epoch * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
const mtimeText = (m: string | number | null | undefined) => (m === null || m === undefined || m === "" ? "unknown" : typeof m === "number" ? iso(m) : String(m));

export interface Conflict {
  path: string;
  current: { size: number; mtime: string };
  restored: { size: number; mtime: string };
}

/**
 * Check the destination and build the plan. `proceed` is true only for a confirmed call whose planId
 * matches the recomputed plan and that nothing blocks; otherwise return `preview` to the caller.
 */
export async function finishGuard(cfg: ArchiwareConfig, g: Guard, inp: GuardInput, s: Safety) {
  const files = inp.files;
  const check = files.filter((f) => !f.dir).slice(0, MAX_CHECK);
  const found = new Map<string, { size: number; mtime: number }>();
  for (let i = 0; i < check.length; i += 400) {
    const out = await sh(cfg, inp.inContainer, STAT_SCRIPT, check.slice(i, i + 400).map((f) => f.dest));
    for (const l of out.split("\n")) {
      if (!l.startsWith("C\t")) continue;
      const [, sm, path] = l.split("\t");
      const [size, mt] = sm.split(" ");
      found.set(path, { size: Number(size), mtime: Number(mt) });
    }
  }
  const conflicts: Conflict[] = check
    .filter((f) => found.has(f.dest))
    .map((f) => ({
      path: f.dest,
      current: { size: found.get(f.dest)!.size, mtime: iso(found.get(f.dest)!.mtime) },
      restored: { size: f.size, mtime: mtimeText(f.mtime) },
    }));
  const bytes = inp.totals?.bytes ?? files.reduce((a, f) => a + (f.dir ? 0 : f.size), 0);
  const entryCount = inp.totals?.entries ?? files.length;
  const first = files[0]?.dest ?? g.base ?? "/";
  const dfDir = g.mode === "original" ? posix.dirname(first) : g.base || "/";
  const df = (await sh(cfg, inp.inContainer, DF_SCRIPT, [dfDir])).split("\n").find((l) => l.startsWith("D\t"))?.split("\t");
  const freeBytes = df && /^\d+$/.test(df[2] ?? "") ? Number(df[2]) * 1024 : null;

  const warnings: string[] = [];
  const blocked: string[] = [];
  const syncHit = cfg.syncRoots.find((r) => files.some((f) => isUnderPath(f.dest, r)) || isUnderPath(g.base || "/", r));
  if (syncHit) {
    warnings.push(`destination is inside the sync root ${syncHit}: restored files will be synced out to other machines`);
    if (g.mode === "original" && !s.forceSync) blocked.push(`restoring to the original location inside the sync root ${syncHit} is refused without --force-sync (MCP: forceSync:true); restore to a folder instead and move the file by hand`);
  }
  if (freeBytes !== null && freeBytes < bytes) blocked.push(`not enough free space at ${dfDir}: ${freeBytes} bytes free, ${bytes} needed`);
  if (conflicts.length > 0 && g.policy === "refuse") blocked.push(`${conflicts.length} destination file(s) already exist; restore refused. Choose --on-conflict rename (restored file becomes <name>${g.suffix}) or --on-conflict overwrite, or a different --to`);
  if (check.length < files.filter((f) => !f.dir).length) warnings.push(`only the first ${MAX_CHECK} entries were checked for conflicts`);

  const policyText =
    g.policy === "refuse"
      ? "refuse: nothing is written when any destination file exists"
      : g.policy === "rename"
        ? `rename: an existing destination file is kept; the restored file becomes <name>${g.suffix}`
        : "overwrite: existing destination files are replaced";
  const hash = createHash("sha256")
    .update(JSON.stringify({ k: inp.sourceKey, b: g.base, m: g.mode, p: g.policy, n: entryCount, c: conflicts.map((c) => [c.path, c.current.size, c.current.mtime]) }))
    .digest("hex")
    .slice(0, 6);
  const planId = `${g.stamp}-${hash}`;

  const hostText = cfg.mode === "local" ? "this machine" : cfg.mode === "docker" && inp.inContainer ? `${cfg.sshHost} (container ${cfg.container})` : cfg.sshHost;
  const preview = {
    confirmationRequired: true as const,
    planId,
    host: hostText,
    destinationMode: g.mode,
    destination: g.mode === "original" ? (files.length === 1 ? files[0].dest : posix.dirname(first)) : g.base,
    source: inp.source,
    bytesToWrite: bytes,
    freeBytesAtDestination: freeBytes,
    entries: entryCount,
    tree: files.slice(0, 50).map((f) => `${f.dir ? "d" : "-"} ${f.dest}${f.dir ? "" : ` (${f.size} bytes)`}`),
    treeMore: Math.max(0, entryCount - 50),
    conflictPolicy: policyText,
    conflicts: { count: conflicts.length, first50: conflicts.slice(0, 50), more: Math.max(0, conflicts.length - 50) },
    warnings,
    ...(inp.notes?.length ? { notes: inp.notes } : {}),
    ...(blocked.length ? { refused: blocked.join("; ") } : {}),
    next: blocked.length ? "nothing will run until the refusal is resolved" : `to run exactly this: repeat the call with confirm/--yes and plan ${planId}`,
  };
  if (!s.confirm) return { proceed: false as const, preview, conflicts };
  if (!s.plan) return { proceed: false as const, preview: { ...preview, refused: [`a confirmed restore needs the plan id of its preview (--plan / planId); this one is ${planId}`, ...blocked].join("; ") }, conflicts };
  if (s.plan.trim() !== planId) {
    return { proceed: false as const, preview: { ...preview, refused: [`plan ${s.plan} does not match the current state (destination, policy or existing files changed); the new plan is ${planId}, review it and repeat with that id`, ...blocked].join("; ") }, conflicts };
  }
  if (blocked.length) return { proceed: false as const, preview, conflicts };
  return { proceed: true as const, preview, conflicts };
}

export const refusedOutput = <T extends { refused?: string }>(p: T) => ({ ...p, confirmationRequired: true as const, executed: false as const });
