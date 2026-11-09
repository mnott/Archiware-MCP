/**
 * p5_config_backup: a consistent, routine copy of P5's own configuration and
 * index databases on the P5 host, outside P5, restorable without P5.
 *
 * Every SQLite file under the config tree (found by its file header, not its
 * extension) is copied with SQLite's online backup (`sqlite3 .backup`), never
 * with cp/tar, and `PRAGMA integrity_check` is run on each COPY. Everything
 * else is tarred. SHA256SUMS + manifest.json describe the copy; only a copy
 * that verified gets a VERIFIED marker, and only then older copies are pruned.
 * P5 keeps running; nsdchat is not used for the copy (only for the version
 * string in the manifest). All steps are host commands built by pure functions.
 */

import type { ArchiwareConfig } from "./config.js";
import { configDir } from "./p5db.js";
import { nsdchat } from "./transport.js";
import { hostCommand, P5Error, shellQuote } from "./transport.js";
import { dateStamp } from "./containerops.js";

export const CONFIG_BACKUP_WARN_H = 36;
const RUN_MS = 6 * 3600_000;
const STAMP_RE = /^\d{8}-\d{6}$/;

export const configBackupRoot = (cfg: Pick<ArchiwareConfig, "backupDir">) => `${cfg.backupDir}/p5-config`;

export function timeStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dateStamp(d)}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const sh = (script: string): string[] => ["sh", "-c", script];

/** Read-only discovery: `<size> <relative path>` of every SQLite file under the config tree. */
export function discoverArgv(src: string): string[] {
  return sh(
    `find ${shellQuote(src)} -type f | while IFS= read -r f; do [ "$(head -c 15 "$f" 2>/dev/null)" = "SQLite format 3" ] && stat -c '%s %n' "$f"; done | sed ${shellQuote(`s#${src}/##`)} | sort -rn`,
  );
}

export function parseDiscovery(out: string): { bytes: number; path: string }[] {
  return out
    .split("\n")
    .map((l) => l.match(/^(\d+) (.+)$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => ({ bytes: Number(m[1]), path: m[2] }));
}

/** Which tools exist: host sqlite3 / flock / ionice, container sqlite3 (reported; only the host one is used). */
export function toolsArgv(): string[] {
  return sh("for t in sqlite3 flock ionice sha256sum; do command -v $t >/dev/null 2>&1 && echo \"have $t\"; done; true");
}

/** The full copy as one POSIX sh script (run under flock/nice/ionice). */
export function backupScript(o: { src: string; root: string; stamp: string; keep: number; version: string }): string {
  const v = (k: string, x: string) => `${k}=${shellQuote(x)}`;
  return [
    "set -u",
    v("SRC", o.src),
    v("ROOT", o.root),
    v("STAMP", o.stamp),
    v("VER", o.version),
    `KEEP=${Math.max(1, Math.floor(o.keep))}`,
    'D="$ROOT/$STAMP"; T0=$(date +%s)',
    'fail() { echo "p5_config_backup FAILED: $1" >&2; touch "$D/FAILED"; exit 1; }',
    'mkdir -p "$D/db" || exit 1',
    'find "$SRC" -type f | while IFS= read -r f; do [ "$(head -c 15 "$f" 2>/dev/null)" = "SQLite format 3" ] && printf "%s\\n" "${f#$SRC/}"; done > "$D/dblist.txt"',
    ': > "$D/dbs.tsv"; : > "$D/exclude.txt"',
    "BAD=0",
    'while IFS= read -r rel; do',
    '  mkdir -p "$D/db/$(dirname "$rel")"; printf "%s\\n" "$rel" >> "$D/exclude.txt"',
    '  sqlite3 -cmd ".timeout 60000" "$SRC/$rel" ".backup \\"$D/db/$rel\\"" || fail "backup of $rel"',
    '  r=$(sqlite3 "$D/db/$rel" "PRAGMA integrity_check;" | head -n 1); pg=$(sqlite3 "$D/db/$rel" "PRAGMA page_count;")',
    '  [ "$r" = "ok" ] || BAD=1',
    '  printf "%s\\t%s\\t%s\\t%s\\n" "$rel" "$(stat -c %s "$D/db/$rel")" "$pg" "$r" >> "$D/dbs.tsv"',
    'done < "$D/dblist.txt"',
    'for p in "*.lock" "*.tmp" "*-wal" "*-shm" "*-journal"; do printf "%s\\n" "$p" >> "$D/exclude.txt"; done',
    'tar -C "$SRC" --exclude-from="$D/exclude.txt" -cf "$D/config-rest.tar" .; rc=$?',
    '[ "$rc" -le 1 ] || fail "tar exit $rc"',
    'rm -f "$D/exclude.txt" "$D/dblist.txt"',
    '[ "$BAD" = 0 ] || fail "integrity_check not ok on a copy (see dbs.tsv)"',
    'DUR=$(( $(date +%s) - T0 ))',
    'printf \'{"p5Version":"%s","stamp":"%s","durationSeconds":%s,"sqlite3":"%s","databases":[\' "$VER" "$STAMP" "$DUR" "$(command -v sqlite3)" > "$D/manifest.json"',
    'awk -F"\\t" \'{printf "%s{\\"path\\":\\"%s\\",\\"bytes\\":%s,\\"pageCount\\":%s,\\"integrity\\":\\"%s\\"}", (NR>1?",":""), $1,$2,$3,$4}\' "$D/dbs.tsv" >> "$D/manifest.json"',
    'printf "]}\\n" >> "$D/manifest.json"',
    '( cd "$D" && find . -type f ! -name SHA256SUMS ! -name VERIFIED ! -name FAILED -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS && sha256sum -c --quiet SHA256SUMS ) || fail "SHA256SUMS verify"',
    'date +%s > "$D/VERIFIED"',
    retentionScript(),
    'echo "OK $D $DUR"',
  ].join("\n");
}

/** Shell fragment: keep the newest KEEP verified copies, drop older verified ones and failed ones. Never touches archiware-update-*. */
export function retentionScript(): string {
  return [
    'ls -1 "$ROOT" | grep -E "^[0-9]{8}-[0-9]{6}$" | sort -r > "$ROOT/.names.$$"',
    'n=0; while IFS= read -r nm; do',
    '  if [ -f "$ROOT/$nm/VERIFIED" ]; then n=$((n+1)); [ "$n" -le "$KEEP" ] || rm -rf "${ROOT:?}/$nm"; elif [ -f "$ROOT/$nm/FAILED" ]; then rm -rf "${ROOT:?}/$nm"; fi',
    'done < "$ROOT/.names.$$"; rm -f "$ROOT/.names.$$"',
  ].join("\n");
}

export function runArgv(root: string, script: string): string[] {
  return sh(`mkdir -p ${shellQuote(root)} && exec flock -n -E 75 ${shellQuote(`${root}/.lock`)} nice -n 19 ionice -c3 sh -c ${shellQuote(script)}`);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export interface CopyInfo {
  name: string;
  at: number; // ms, from VERIFIED/dir mtime
  kb: number;
  state: "verified" | "failed" | "incomplete";
}

export function statusArgv(root: string): string[] {
  return sh(
    `cd ${shellQuote(root)} 2>/dev/null && for d in [0-9]*-[0-9]*; do [ -d "$d" ] || continue; s=incomplete; [ -f "$d/FAILED" ] && s=failed; [ -f "$d/VERIFIED" ] && s=verified; echo "$d $(stat -c %Y "$d") $(du -sk "$d" | cut -f1) $s"; done; true`,
  );
}

export function parseStatus(out: string): CopyInfo[] {
  return out
    .split("\n")
    .map((l) => l.trim().match(/^(\d{8}-\d{6}) (\d+) (\d+) (verified|failed|incomplete)$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => ({ name: m[1], at: Number(m[2]) * 1000, kb: Number(m[3]), state: m[4] as CopyInfo["state"] }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** Pure: warning text when the newest verified copy is older than 36 h; null if fine or if the feature was never used. */
export function staleWarning(copies: CopyInfo[], nowMs: number): string | null {
  if (copies.length === 0) return null;
  const v = copies.filter((c) => c.state === "verified").sort((a, b) => b.at - a.at)[0];
  if (!v) return "p5_config_backup: copies exist but none verified";
  const h = (nowMs - v.at) / 3600_000;
  return h > CONFIG_BACKUP_WARN_H ? `newest verified P5 config copy is ${Math.floor(h)} h old (limit ${CONFIG_BACKUP_WARN_H} h): run p5_config_backup --yes` : null;
}

export async function listCopyState(cfg: ArchiwareConfig, root: string): Promise<CopyInfo[]> {
  return parseStatus((await hostCommand(cfg, statusArgv(root), 60_000)).stdout);
}

export async function listCopies(cfg: ArchiwareConfig): Promise<CopyInfo[]> {
  if (!cfg.backupDir) return [];
  return listCopyState(cfg, configBackupRoot(cfg));
}

// ---------------------------------------------------------------------------
// operation
// ---------------------------------------------------------------------------

const ageText = (at: number, now: number) => `${Math.round((now - at) / 3600_000)} h`;

export async function p5ConfigBackup(cfg: ArchiwareConfig, opts: { confirm: boolean; status?: boolean }) {
  if (opts.status) {
    const now = Date.now();
    const copies = await listCopies(cfg);
    return {
      confirmationRequired: false as const,
      root: configBackupRoot(cfg),
      keep: cfg.p5ConfigBackupKeep,
      copies: copies.map((c) => ({ name: c.name, age: ageText(c.at, now), sizeMB: Math.round(c.kb / 1024), state: c.state })),
      warning: staleWarning(copies, now),
    };
  }
  if (!cfg.backupDir) throw new P5Error("backupDir is not configured (needed as the destination root)");
  const src = configDir(cfg);
  const root = configBackupRoot(cfg);
  const stamp = timeStamp();
  const tools = (await hostCommand(cfg, toolsArgv(), 20_000)).stdout;
  const have = (t: string) => tools.includes(`have ${t}`);
  if (!have("sqlite3")) {
    const c = cfg.mode === "docker" ? await hostCommand(cfg, ["docker", "exec", cfg.container, "test", "-x", `${cfg.p5Home}/bin/sqlite3`], 20_000).catch(() => null) : null;
    throw new P5Error(
      `sqlite3 is not installed on the P5 host${c && c.rc === 0 ? ` (P5's own ${cfg.p5Home}/bin/sqlite3 exists in the container, but the destination is a host directory; install sqlite3 on the host)` : ""}`,
    );
  }
  for (const t of ["flock", "ionice", "sha256sum"]) if (!have(t)) throw new P5Error(`${t} is not installed on the P5 host`);
  if (!opts.confirm) {
    const dbs = parseDiscovery((await hostCommand(cfg, discoverArgv(src), 300_000)).stdout);
    const du = await hostCommand(cfg, sh(`du -sk ${shellQuote(src)} | cut -f1; df -Pk ${shellQuote(cfg.backupDir)} | tail -1 | awk '{print $4}'`), 300_000);
    const [duKb, freeKb] = du.stdout.trim().split("\n").map(Number);
    const dbBytes = dbs.reduce((s, d) => s + d.bytes, 0);
    return {
      confirmationRequired: true as const,
      plan: [
        `copy ${dbs.length} SQLite database(s) with host sqlite3 .backup (online, P5 keeps running), then PRAGMA integrity_check on each copy`,
        "tar everything else (excluding the databases, *.lock, *.tmp, *-wal, *-shm, *-journal)",
        "write manifest.json and SHA256SUMS, verify, mark VERIFIED",
        `then keep the newest ${cfg.p5ConfigBackupKeep} verified copies (archiware-update-* is never touched)`,
        "under flock, nice -n 19, ionice -c3",
      ],
      sources: { configDir: src, sqliteTool: "host sqlite3", databases: dbs.slice(0, 20), databaseCount: dbs.length },
      destination: `${root}/${stamp}/`,
      estimatedSizeMB: Math.round((Number.isFinite(duKb) ? duKb : dbBytes / 1024) / 1024),
      databaseMB: Math.round(dbBytes / 1048576),
      freeSpaceMB: Number.isFinite(freeKb) ? Math.round(freeKb / 1024) : null,
      note: "Re-run with confirm:true (CLI --yes).",
    };
  }
  let version = "?";
  try {
    version = (await nsdchat(cfg, ["srvinfo", "lexxvers"], 15_000)).trim() || "?";
  } catch {
    /* version is informational */
  }
  const script = backupScript({ src, root, stamp, keep: cfg.p5ConfigBackupKeep, version });
  const r = await hostCommand(cfg, runArgv(root, script), RUN_MS);
  if (r.rc === 75) throw new P5Error("another p5_config_backup is running (lock held)");
  if (r.rc !== 0) throw new P5Error(`p5_config_backup failed (exit ${r.rc}); the failed copy is marked FAILED, older copies were kept`, r.stderr);
  const copies = await listCopies(cfg);
  return { confirmationRequired: false as const, destination: `${root}/${stamp}`, result: r.stdout.trim().split("\n").pop(), copies: copies.length, p5Version: version };
}
