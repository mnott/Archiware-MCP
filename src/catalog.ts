/**
 * File catalogue for D2D2T: data is packed into tar files before it goes to
 * tape; P5 knows which tar is on which tape, this catalogue adds "which file
 * is in which tar". It lives in a MySQL database (`archive_catalog`) in a
 * container on the P5 host, reached the way a host job would:
 *   docker exec -i <container> mysql --defaults-extra-file=/dev/stdin ... < <cnf>
 * run on the P5 host through the normal transport (ssh, or local). The
 * credentials file is only ever redirected into the client, never read here.
 *
 * Packing never takes the nsdchat lock: it only uses find/tar/sha256sum/mysql
 * on the host (low I/O priority).
 */

import { spawn } from "node:child_process";
import type { ArchiwareConfig } from "./config.js";
import { launch, nsdchat, P5Error, shellQuote } from "./transport.js";
import { restoreOptions, restoreVersion } from "./libops.js";

export type Progress = (msg: string) => void;
const noProgress: Progress = () => undefined;

export const CATALOG_DB = "archive_catalog";
const SET_RE = /^[A-Za-z0-9._-]+$/;
const GiB = 1024 ** 3;

// ---------------------------------------------------------------------------
// host plumbing
// ---------------------------------------------------------------------------

interface RunResult {
  rc: number;
  stdout: string;
  stderr: string;
}

/** Run one shell string on the P5 host; optional stdin; streams stdout lines to onLine. */
function runRemote(cfg: ArchiwareConfig, remote: string, opts: { input?: string; timeoutMs?: number; onLine?: (l: string) => void } = {}): Promise<RunResult> {
  const l = launch(cfg, remote);
  return new Promise((resolve, reject) => {
    const p = spawn(l.cmd, l.args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let buf = "";
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new P5Error(`host command timed out after ${Math.round((opts.timeoutMs ?? 120_000) / 1000)}s`));
    }, opts.timeoutMs ?? 120_000);
    p.stdout.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stdout += s;
      if (opts.onLine) {
        buf += s;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          opts.onLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      }
    });
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (rc) => {
      clearTimeout(timer);
      resolve({ rc: rc ?? 1, stdout, stderr: stderr.trim() });
    });
    p.stdin.on("error", () => undefined);
    p.stdin.end(opts.input ?? "");
  });
}

/** Run a bash script on the host with positional arguments (script travels as one quoted argument; stdin stays free). */
function runScript(cfg: ArchiwareConfig, script: string, args: string[], opts: Parameters<typeof runRemote>[2] = {}) {
  return runRemote(cfg, ["bash", "-c", script, "catalog", ...args].map(shellQuote).join(" "), opts);
}

const q = (s: string): string => `'${s.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;

function unescapeBatch(f: string): string {
  return f.replace(/\\([tn0\\])/g, (_, c: string) => (c === "t" ? "\t" : c === "n" ? "\n" : c === "0" ? "\0" : "\\"));
}

/** Run SQL in the catalogue database (batch mode, no header); rows of fields. The credentials file is redirected into the client only. */
export async function sql(cfg: ArchiwareConfig, statement: string, timeoutMs = 300_000): Promise<string[][]> {
  const remote = `docker exec -i ${shellQuote(cfg.catalogMysqlContainer)} mysql --defaults-extra-file=/dev/stdin --default-character-set=utf8mb4 -N -B ${CATALOG_DB} -e ${shellQuote(statement)} < ${shellQuote(cfg.catalogDbCnf)}`;
  const r = await runRemote(cfg, remote, { timeoutMs });
  if (r.rc !== 0) throw new P5Error(`catalogue SQL failed (container ${cfg.catalogMysqlContainer}, credentials file ${cfg.catalogDbCnf}): ${r.stderr.split("\n").filter((x) => !/Using a password/.test(x))[0] ?? "unknown error"}`);
  const t = r.stdout.replace(/\n$/, "");
  return t === "" ? [] : t.split("\n").map((l) => l.split("\t").map(unescapeBatch));
}

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS sets (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(190) NOT NULL,
  source_root VARCHAR(2048) NOT NULL,
  pack_root VARCHAR(2048) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'planned',
  created TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes TEXT NULL,
  UNIQUE KEY uq_sets_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS tars (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  set_id INT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  path VARCHAR(2048) NOT NULL,
  bytes BIGINT UNSIGNED NOT NULL,
  files BIGINT UNSIGNED NOT NULL,
  sha256 CHAR(64) NULL,
  created TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tars_set_name (set_id, name),
  CONSTRAINT fk_tars_set FOREIGN KEY (set_id) REFERENCES sets (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  set_id INT UNSIGNED NOT NULL,
  tar_id INT UNSIGNED NOT NULL,
  path VARCHAR(4096) NOT NULL,
  basename VARCHAR(255) NOT NULL,
  size BIGINT UNSIGNED NOT NULL,
  mtime DATETIME NULL,
  KEY ix_entries_set_path (set_id, path(300)),
  KEY ix_entries_basename (basename),
  KEY ix_entries_tar (tar_id),
  CONSTRAINT fk_entries_tar FOREIGN KEY (tar_id) REFERENCES tars (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

/** Create the schema idempotently; returns the tables with column lists. */
export async function catalogInit(cfg: ArchiwareConfig) {
  for (const s of SCHEMA) await sql(cfg, s);
  const cols = await sql(cfg, `SELECT table_name, GROUP_CONCAT(column_name ORDER BY ordinal_position SEPARATOR ', ') FROM information_schema.columns WHERE table_schema='${CATALOG_DB}' GROUP BY table_name ORDER BY table_name`);
  const idx = await sql(cfg, `SELECT table_name, index_name, GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',') FROM information_schema.statistics WHERE table_schema='${CATALOG_DB}' GROUP BY table_name, index_name ORDER BY table_name, index_name`);
  return {
    database: CATALOG_DB,
    tables: cols.map(([name, columns]) => ({ name, columns, indexes: idx.filter((i) => i[0] === name).map((i) => `${i[1]}(${i[2]})`) })),
    note: "Idempotent: existing tables are left alone. No FULLTEXT index: substring search uses LIKE on the (set_id, path) / basename indexes.",
  };
}

// ---------------------------------------------------------------------------
// sets
// ---------------------------------------------------------------------------

export async function catalogSets(cfg: ArchiwareConfig) {
  const rows = await sql(cfg, "SELECT s.name, s.status, COUNT(t.id), COALESCE(SUM(t.files),0), COALESCE(SUM(t.bytes),0), s.source_root, s.pack_root, s.created, COALESCE(s.notes,'') FROM sets s LEFT JOIN tars t ON t.set_id=s.id GROUP BY s.id ORDER BY s.name");
  return {
    sets: rows.map((r) => ({ name: r[0], status: r[1], tars: Number(r[2]), files: Number(r[3]), bytes: Number(r[4]), size: human(Number(r[4])), sourceRoot: r[5], packRoot: r[6], created: r[7], notes: r[8] || null })),
  };
}

const human = (b: number): string => (b >= 1024 ** 4 ? `${(b / 1024 ** 4).toFixed(2)} TiB` : b >= GiB ? `${(b / GiB).toFixed(2)} GiB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MiB` : `${Math.round(b / 1024)} KiB`);
const dur = (s: number): string => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : s >= 90 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);

// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------

/** Parse "50G", "500M", "1T" or bytes. */
export function parseSize(s: string | number | undefined, dflt = 50 * GiB): number {
  if (s === undefined || s === "") return dflt;
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*([KMGT]?)i?B?$/i);
  if (!m) throw new P5Error(`invalid size "${s}" (e.g. 50G, 500M)`);
  const mult = { "": 1, K: 1024, M: 1024 ** 2, G: GiB, T: 1024 ** 4 }[m[2].toUpperCase() as "" | "K" | "M" | "G" | "T"];
  return Math.floor(Number(m[1]) * mult);
}

export interface DirInfo {
  dir: string;
  bytes: number;
  files: number;
  directBytes: number;
  directFiles: number;
}
export interface Unit {
  /** tree: a directory with everything below it; files: explicit files of one directory */
  kind: "tree" | "files";
  /** items handed to tar, relative to the source root */
  items: string[];
  bytes: number;
  files: number;
  label: string;
}
export interface PlannedTar {
  name: string;
  bytes: number;
  files: number;
  items: string[];
  /** a single unit bigger than --max (one file or one directory that cannot be split) */
  oversize: boolean;
}

const parentOf = (d: string): string => (d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "");

/**
 * Cut the tree into units no bigger than max along folder boundaries: a folder
 * that fits is one unit, a bigger one is split one level deeper (its own direct
 * files become file units, split by size). `directFiles(dir)` returns the
 * direct files of an oversized dir (name relative to dir, size).
 */
export async function buildUnits(dirs: Map<string, DirInfo>, max: number, directFiles: (dir: string) => Promise<{ name: string; size: number }[]>, topEntries: () => Promise<string[]>): Promise<Unit[]> {
  const kids = new Map<string, string[]>();
  for (const d of dirs.keys()) if (d !== "") kids.set(parentOf(d), [...(kids.get(parentOf(d)) ?? []), d]);
  const out: Unit[] = [];
  const join = (dir: string, n: string) => (dir ? `${dir}/${n}` : n);
  async function walk(dir: string): Promise<void> {
    const info = dirs.get(dir);
    if (!info || info.files === 0) return;
    if (info.bytes <= max) {
      if (dir === "") {
        // whole source fits: name the top level entries so tar members carry no "./" prefix
        out.push({ kind: "tree", items: await topEntries(), bytes: info.bytes, files: info.files, label: "(all)" });
      } else out.push({ kind: "tree", items: [dir], bytes: info.bytes, files: info.files, label: dir });
      return;
    }
    for (const c of (kids.get(dir) ?? []).sort()) await walk(c);
    if (info.directFiles > 0) {
      const files = (await directFiles(dir)).sort((a, b) => (a.name < b.name ? -1 : 1));
      let cur: Unit | null = null;
      for (const f of files) {
        if (cur && cur.bytes + f.size > max) {
          out.push(cur);
          cur = null;
        }
        cur ??= { kind: "files", items: [], bytes: 0, files: 0, label: `${dir || "."} (files)` };
        cur.items.push(join(dir, f.name));
        cur.bytes += f.size;
        cur.files++;
      }
      if (cur) out.push(cur);
    }
  }
  await walk("");
  return out;
}

/** Pack consecutive units into tars of at most max; an oversize unit gets its own tar. */
export function packUnits(units: Unit[], max: number, set: string): PlannedTar[] {
  const tars: PlannedTar[] = [];
  let cur: PlannedTar | null = null;
  const flush = () => {
    if (cur) tars.push(cur);
    cur = null;
  };
  for (const u of units) {
    if (cur && cur.bytes + u.bytes > max) flush();
    cur ??= { name: "", bytes: 0, files: 0, items: [], oversize: false };
    cur.items.push(...u.items);
    cur.bytes += u.bytes;
    cur.files += u.files;
    if (u.bytes > max) {
      cur.oversize = true;
      flush();
    }
  }
  flush();
  const w = Math.max(4, String(tars.length).length);
  tars.forEach((t, i) => (t.name = `${set}-${String(i + 1).padStart(w, "0")}.tar`));
  return tars;
}

const WALK_SCRIPT = String.raw`
export LC_ALL=C
src="$1"; max="$2"
[ -d "$src" ] || { echo "source is not a directory: $src" >&2; exit 3; }
nice -n 19 ionice -c 3 find "$src" -type f -printf '%s\t%P\n' 2>/dev/null | awk -F'\t' -v MAX="$max" '
{ if (NF < 2 || $1 !~ /^[0-9]+$/) { bad++; next }
  sz = $1; p = $0; sub(/^[0-9]+\t/, "", p); total += sz; n++
  d = p; if (!sub(/\/[^\/]*$/, "", d)) d = ""
  direct[d] += sz; dfiles[d]++
  a = d
  while (1) { size[a] += sz; cnt[a]++; if (a == "") break; if (!sub(/\/[^\/]*$/, "", a)) a = "" }
}
END {
  for (d in size) { par = d; if (d != "") { if (!sub(/\/[^\/]*$/, "", par)) par = "" }
    if (d == "" || size[par] > MAX) print "D\t" d "\t" size[d] "\t" cnt[d] "\t" direct[d] + 0 "\t" dfiles[d] + 0 }
  print "T\t" total + 0 "\t" n + 0 "\t" bad + 0
}'
`;

/** Start the walk detached on the host (survives a lost connection) or report its state. Args: walk-script src max fresh */
const WALK_DETACH = String.raw`
export LC_ALL=C
d=/tmp/archiware-walk; mkdir -p "$d"
key=$(printf '%s\n%s' "$2" "$3" | sha1sum | cut -c1-16)
b="$d/$key"
[ "$4" = "1" ] && rm -f "$b.rc" "$b.out" "$b.err" "$b.pid"
find "$d" -name '*.rc' -mmin +720 -delete 2>/dev/null
if [ -f "$b.rc" ]; then echo "STATE finished $(cat "$b.rc") $key"; exit 0; fi
if [ -f "$b.pid" ] && kill -0 "$(cat "$b.pid")" 2>/dev/null; then echo "STATE running 0 $key"; exit 0; fi
rm -f "$b.out" "$b.err"
setsid nohup bash -c 'bash -c "$1" walk "$2" "$3" > "$4.out" 2> "$4.err"; echo $? > "$4.rc"' x "$1" "$2" "$3" "$b" > /dev/null 2>&1 < /dev/null &
echo $! > "$b.pid"
echo "STATE started 0 $key"
`;

const DIRECT_SCRIPT = String.raw`
export LC_ALL=C
d="$1"; [ -n "$2" ] && d="$1/$2"
nice -n 19 ionice -c 3 find "$d" -maxdepth 1 -type f -printf '%s\t%f\n'
`;

const TOP_SCRIPT = String.raw`
export LC_ALL=C
find "$1" -mindepth 1 -maxdepth 1 -printf '%f\n'
`;

export interface PackPlan {
  set: string;
  source: string;
  packRoot: string;
  tarDir: string;
  maxBytes: number;
  totalBytes: number;
  totalFiles: number;
  skippedNames: number;
  tars: PlannedTar[];
  estimate: string;
}

/** Walk the source once (low I/O priority) and cut it into tars. Writes nothing. */
export async function planPack(cfg: ArchiwareConfig, source: string, set: string, maxBytes: number, packRoot: string, progress: Progress = noProgress, fresh = false): Promise<PackPlan> {
  const src = source.replace(/\/+$/, "") || "/";
  progress(`walking ${src} (one pass, low I/O priority)`);
  const t0 = Date.now();
  // the walk runs detached on the host: a lost connection or a client timeout does not stop it, and a rerun picks up its result
  let state = "";
  for (let n = 0; ; n++) {
    const s = await runScript(cfg, WALK_DETACH, [WALK_SCRIPT, src, String(maxBytes), n === 0 && fresh ? "1" : "0"]);
    const m = s.stdout.match(/STATE (\w+) (\d+) (\w+)/);
    if (s.rc !== 0 || !m) throw new P5Error(`cannot start the walk of ${src}: ${s.stderr}`);
    state = m[1];
    if (state === "finished") {
      if (m[2] !== "0") throw new P5Error(`walk of ${src} failed (exit ${m[2]}); rerun to walk again after fixing the cause (cache key ${m[3]})`);
      var key = m[3];
      break;
    }
    if (n % 4 === 0) progress(`walk ${state} (${dur((Date.now() - t0) / 1000)})`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
  const w = await runRemote(cfg, `cat /tmp/archiware-walk/${key}.out`, { timeoutMs: 300_000 });
  const dirs = new Map<string, DirInfo>();
  let total = { bytes: 0, files: 0, bad: 0 };
  for (const line of w.stdout.split("\n")) {
    const f = line.split("\t");
    if (f[0] === "D") dirs.set(f[1], { dir: f[1], bytes: Number(f[2]), files: Number(f[3]), directBytes: Number(f[4]), directFiles: Number(f[5]) });
    else if (f[0] === "T") total = { bytes: Number(f[1]), files: Number(f[2]), bad: Number(f[3]) };
  }
  if (total.files === 0) throw new P5Error(`${src} holds no regular files`);
  progress(`walk done in ${dur((Date.now() - t0) / 1000)}: ${total.files} files, ${human(total.bytes)}`);
  const units = await buildUnits(
    dirs,
    maxBytes,
    async (dir) => {
      const r = await runScript(cfg, DIRECT_SCRIPT, [src, dir]);
      if (r.rc !== 0) throw new P5Error(`listing ${dir} failed: ${r.stderr}`);
      return r.stdout.split("\n").filter(Boolean).map((l) => ({ size: Number(l.slice(0, l.indexOf("\t"))), name: l.slice(l.indexOf("\t") + 1) }));
    },
    async () => (await runScript(cfg, TOP_SCRIPT, [src])).stdout.split("\n").filter(Boolean),
  );
  const tars = packUnits(units, maxBytes, set);
  const secs = total.bytes / (cfg.packMBps * 1024 * 1024) + total.files / 2000;
  return {
    set,
    source: src,
    packRoot,
    tarDir: `${packRoot}/${set}`,
    maxBytes,
    totalBytes: total.bytes,
    totalFiles: total.files,
    skippedNames: total.bad,
    tars,
    estimate: `about ${dur(secs)} (assumes ${cfg.packMBps} MB/s sequential read+write plus ~2000 files/s; disks that are busy with other work take longer)`,
  };
}

function printable(p: PackPlan) {
  return {
    set: p.set,
    source: p.source,
    tarDir: p.tarDir,
    max: human(p.maxBytes),
    totalFiles: p.totalFiles,
    totalBytes: p.totalBytes,
    total: human(p.totalBytes),
    tarCount: p.tars.length,
    tars: p.tars.map((t) => ({ name: t.name, bytes: t.bytes, size: human(t.bytes), files: t.files, items: t.items.length, ...(t.oversize ? { note: "single unit larger than --max" } : {}) })),
    estimate: p.estimate,
    ...(p.skippedNames ? { warning: `${p.skippedNames} file name(s) with a newline in the name were not counted and will not be packed` } : {}),
  };
}

// ---------------------------------------------------------------------------
// pack
// ---------------------------------------------------------------------------

/** One tar: write it, checksum, listing, then the tar's rows in one transaction, then the .done marker. Args: container cnf db setid tarpath items src name */
const TAR_SCRIPT = String.raw`
export LC_ALL=C
C="$1"; CNF="$2"; DB="$3"; SID="$4"; T="$5"; ITEMS="$6"; SRC="$7"; NAME="$8"
if [ -f "$T.done" ]; then echo "SKIP"; exit 0; fi
rm -f "$T.part" "$T.idx" "$T.sql" "$T.list.part"
nice -n 19 ionice -c 3 tar --sort=inode --warning=no-file-changed -C "$SRC" --verbatim-files-from --null -T "$ITEMS" -cvv --full-time --index-file="$T.idx" -f "$T.part"
rc=$?
if [ "$rc" -gt 1 ]; then echo "tar failed rc=$rc" >&2; exit 2; fi
sum=$(nice -n 19 ionice -c 3 sha256sum "$T.part" | cut -d' ' -f1)
bytes=$(stat -c %s "$T.part")
mv "$T.part" "$T"
echo "$sum  $NAME" > "$T.sha256"
# plain-text listing next to the tar: path, size, mtime (rebuilds the catalogue from disk/tape alone)
awk '
substr($0,1,1) == "-" && match($0, /^[^ ]+ +[^ ]+ +[0-9]+ [0-9-]+ [0-9:.]+ /) {
  hdr = substr($0, 1, RLENGTH - 1); path = substr($0, RLENGTH + 1)
  n = split(hdr, h, / +/); print path "\t" h[3] "\t" h[4] " " substr(h[5], 1, 8)
}' "$T.idx" | iconv -c -f UTF-8 -t UTF-8 > "$T.list.part"
mv "$T.list.part" "$T.list"
files=$(wc -l < "$T.list" | tr -d ' ')
{
  echo "SET autocommit=0;"
  echo "START TRANSACTION;"
  echo "DELETE FROM tars WHERE set_id=$SID AND name='$NAME';"
  echo "INSERT INTO tars(set_id,name,path,bytes,files,sha256) VALUES ($SID,'$NAME','$T',$bytes,$files,'$sum');"
  echo "SET @tid=LAST_INSERT_ID();"
  awk -F'\t' -v SID="$SID" '
  function esc(s) { gsub(/\\/, "\\\\", s); gsub(/\047/, "\047\047", s); return s }
  { b = $1; sub(/.*\//, "", b)
    row = "(" SID ",@tid,\047" esc($1) "\047,\047" esc(b) "\047," $2 ",\047" $3 "\047)"
    if (n % 2000 == 0) { if (n > 0) print ";"; printf "INSERT INTO entries(set_id,tar_id,path,basename,size,mtime) VALUES " row }
    else printf ",%s", row
    n++ }
  END { if (n > 0) print ";" }' "$T.list"
  echo "COMMIT;"
} > "$T.sql"
tmp="/tmp/catalog-$$.sql"
docker cp "$T.sql" "$C:$tmp" >/dev/null || { echo "docker cp failed" >&2; exit 3; }
docker exec -i "$C" mysql --defaults-extra-file=/dev/stdin --default-character-set=utf8mb4 "$DB" -e "source $tmp" < "$CNF" >/dev/null
mrc=$?
docker exec "$C" rm -f "$tmp"
if [ "$mrc" -ne 0 ]; then echo "catalogue insert failed (mysql rc=$mrc); tar kept, rerun resumes" >&2; exit 4; fi
rm -f "$T.sql" "$T.idx"
touch "$T.done"
printf 'RESULT\t%s\t%s\t%s\n' "$files" "$bytes" "$sum"
`;

export async function pack(
  cfg: ArchiwareConfig,
  source: string,
  opts: { set: string; max?: string | number; into?: string; confirm: boolean; replan?: boolean },
  progress: Progress = noProgress,
) {
  if (!SET_RE.test(opts.set)) throw new P5Error(`invalid set name "${opts.set}" (letters, digits, . _ -)`);
  if (!source.startsWith("/")) throw new P5Error("source must be an absolute path on the P5 host");
  const max = parseSize(opts.max);
  const packRoot = (opts.into ?? cfg.packRoot).replace(/\/+$/, "");
  if (!packRoot.startsWith("/")) throw new P5Error("pack root must be an absolute path on the P5 host");
  const tarDir = `${packRoot}/${opts.set}`;
  if (!opts.confirm) {
    const plan = await planPack(cfg, source, opts.set, max, packRoot, progress);
    return { confirmationRequired: true as const, plan: printable(plan), note: "Plan only; nothing was written. Confirm to write the tars into the tar dir and record every member in the catalogue (resumable per tar: finished tars have a .done marker)." };
  }
  await catalogInit(cfg);
  const existing = await sql(cfg, `SELECT id, source_root FROM sets WHERE name=${q(opts.set)}`);
  const src = source.replace(/\/+$/, "") || "/";
  if (existing[0] && existing[0][1] !== src) throw new P5Error(`set ${opts.set} already exists for source ${existing[0][1]}; use another name or catalog_drop it first`);
  // reuse a stored plan so a resumed run cuts the tars identically
  const planFile = `${tarDir}/.plan.json`;
  let plan: PackPlan | null = null;
  if (!opts.replan) {
    const r = await runRemote(cfg, ["cat", planFile].map(shellQuote).join(" "));
    if (r.rc === 0) {
      try {
        const p = JSON.parse(r.stdout) as PackPlan;
        if (p.source === src && p.maxBytes === max) plan = p;
      } catch {
        /* replan */
      }
    }
  }
  if (plan) progress(`resuming with the stored plan (${plan.tars.length} tars)`);
  else plan = await planPack(cfg, src, opts.set, max, packRoot, progress, Boolean(opts.replan));
  const mk = await runRemote(cfg, `mkdir -p ${shellQuote(tarDir)}`);
  if (mk.rc !== 0) throw new P5Error(`cannot create ${tarDir}: ${mk.stderr}`);
  await runRemote(cfg, `cat > ${shellQuote(planFile)}`, { input: JSON.stringify(plan) });
  if (!existing[0]) await sql(cfg, `INSERT INTO sets(name, source_root, pack_root, status) VALUES (${q(opts.set)}, ${q(src)}, ${q(tarDir)}, 'packing')`);
  else await sql(cfg, `UPDATE sets SET status='packing' WHERE name=${q(opts.set)}`);
  const sid = (await sql(cfg, `SELECT id FROM sets WHERE name=${q(opts.set)}`))[0][0];
  const done: { name: string; files: number; bytes: number; sha256: string | null; skipped: boolean }[] = [];
  const t0 = Date.now();
  let bytesDone = 0;
  for (let i = 0; i < plan.tars.length; i++) {
    const t = plan.tars[i];
    const tarPath = `${tarDir}/${t.name}`;
    const items = `${tarDir}/.${t.name}.items`;
    await runRemote(cfg, `cat > ${shellQuote(items)}`, { input: t.items.map((x) => `${x}\0`).join("") });
    progress(`[${i + 1}/${plan.tars.length}] ${t.name}: ${t.files} files, ${human(t.bytes)}`);
    const r = await runScript(cfg, TAR_SCRIPT, [cfg.catalogMysqlContainer, cfg.catalogDbCnf, CATALOG_DB, sid, tarPath, items, plan.source, t.name], { timeoutMs: 24 * 3600_000 });
    if (r.rc !== 0) throw new P5Error(`pack stopped at ${t.name} (exit ${r.rc}); rerun the same command to resume: ${r.stderr.split("\n").slice(-3).join(" | ")}`);
    const res = r.stdout.split("\n").find((l) => l.startsWith("RESULT\t"));
    if (!res) {
      done.push({ name: t.name, files: t.files, bytes: t.bytes, sha256: null, skipped: true });
      progress(`[${i + 1}/${plan.tars.length}] ${t.name}: already done, skipped`);
    } else {
      const f = res.split("\t");
      done.push({ name: t.name, files: Number(f[1]), bytes: Number(f[2]), sha256: f[3], skipped: false });
      bytesDone += Number(f[2]);
      const el = (Date.now() - t0) / 1000;
      progress(`[${i + 1}/${plan.tars.length}] ${t.name} done: ${f[1]} files, ${human(Number(f[2]))}, sha256 ${f[3].slice(0, 12)}...; ${human(bytesDone)} in ${dur(el)}`);
    }
    await runRemote(cfg, `rm -f ${shellQuote(items)}`);
  }
  await sql(cfg, `UPDATE sets SET status='packed' WHERE name=${q(opts.set)}`);
  return { confirmationRequired: false as const, set: opts.set, tarDir, tars: done.length, written: done.filter((d) => !d.skipped).length, skipped: done.filter((d) => d.skipped).length, files: done.reduce((a, d) => a + d.files, 0), bytes: done.reduce((a, d) => a + d.bytes, 0), details: done, elapsed: dur((Date.now() - t0) / 1000) };
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

/** Glob (* ?) or substring -> SQL LIKE pattern and the column to match. */
export function likeFor(pattern: string): { column: "path" | "basename"; like: string } {
  const glob = /[*?]/.test(pattern);
  const esc = pattern.replace(/[\\%_]/g, (c) => `\\${c}`);
  const like = glob ? esc.replace(/\*/g, "%").replace(/\?/g, "_") : `%${esc}%`;
  return { column: pattern.includes("/") || !glob ? "path" : "basename", like };
}

const p5Path = (cfg: ArchiwareConfig, hostPath: string): string => (cfg.packRootP5 && hostPath.startsWith(`${cfg.packRoot}/`) ? cfg.packRootP5 + hostPath.slice(cfg.packRoot.length) : hostPath);

async function filesExist(cfg: ArchiwareConfig, paths: string[]): Promise<Map<string, boolean>> {
  const m = new Map<string, boolean>();
  if (paths.length === 0) return m;
  const r = await runScript(cfg, 'for f in "$@"; do if [ -f "$f" ]; then echo 1; else echo 0; fi; done', paths);
  r.stdout.split("\n").filter(Boolean).forEach((v, i) => m.set(paths[i], v === "1"));
  return m;
}

/** Tape side of one tar: versions in P5's backup index with volume, barcode, location. */
async function tapeInfo(cfg: ArchiwareConfig, tarPath: string) {
  try {
    const o = await restoreOptions(cfg, p5Path(cfg, tarPath), { limit: 5 });
    return {
      onTape: o.versions.length > 0,
      available: o.versions.some((v) => v.available),
      versions: o.versions.map((v) => ({ date: v.start, job: v.plan, event: v.event, level: v.level, volumes: v.volumes.map((x) => ({ label: x.label, barcode: x.barcode, location: x.location })) })),
      fetchList: o.fetchList,
    };
  } catch (e) {
    return { onTape: false, available: false, versions: [], fetchList: [], error: (e as Error).message };
  }
}

export async function catalogSearch(cfg: ArchiwareConfig, pattern: string, opts: { set?: string; limit?: number } = {}) {
  if (!pattern) throw new P5Error("a pattern is required");
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 500);
  const { column, like } = likeFor(pattern);
  const rows = await sql(
    cfg,
    `SELECT s.name, e.path, e.size, e.mtime, t.name, t.path FROM entries e JOIN sets s ON s.id=e.set_id JOIN tars t ON t.id=e.tar_id WHERE e.${column} LIKE ${q(like)}${opts.set ? ` AND s.name=${q(opts.set)}` : ""} ORDER BY s.name, e.path LIMIT ${limit}`,
  );
  const tarPaths = [...new Set(rows.map((r) => r[5]))];
  const disk = await filesExist(cfg, tarPaths);
  const tape = new Map<string, Awaited<ReturnType<typeof tapeInfo>>>();
  for (const tp of tarPaths) tape.set(tp, await tapeInfo(cfg, tp));
  return {
    pattern,
    hits: rows.map((r) => ({ set: r[0], path: r[1], size: Number(r[2]), mtime: r[3], tar: r[4], tarPath: r[5], tarOnDisk: disk.get(r[5]) ?? false, tape: tape.get(r[5]) })),
    limited: rows.length === limit,
  };
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

async function lookup(cfg: ArchiwareConfig, set: string, path: string) {
  const setRow = await sql(cfg, `SELECT id, source_root FROM sets WHERE name=${q(set)}`);
  if (!setRow[0]) throw new P5Error(`no set "${set}" (catalog_sets lists them)`);
  let rel = path.replace(/^\/+/, "");
  const root = setRow[0][1].replace(/^\/+/, "") + "/";
  if (rel.startsWith(root)) rel = rel.slice(root.length);
  const rows = await sql(cfg, `SELECT e.path, e.size, e.mtime, t.name, t.path, t.sha256 FROM entries e JOIN tars t ON t.id=e.tar_id WHERE e.set_id=${setRow[0][0]} AND e.path=${q(rel)} AND BINARY e.path=BINARY ${q(rel)}`);
  const r = rows.find((x) => x[0] === rel);
  if (!r) throw new P5Error(`"${rel}" is not in set ${set} (path is relative to ${setRow[0][1]}); use catalog_search`);
  return { rel, size: Number(r[1]), mtime: r[2], tar: r[3], tarPath: r[4], sha256: r[5] };
}

const EXTRACT_SCRIPT = String.raw`
export LC_ALL=C
mkdir -p "$3" || exit 2
tar -C "$3" --no-wildcards -xf "$1" -- "$2" || exit 3
f="$3/$2"
[ -f "$f" ] || { echo "member not found after extraction" >&2; exit 4; }
printf 'OK\t%s\t%s\n' "$(stat -c %s "$f")" "$(sha256sum "$f" | cut -d' ' -f1)"
`;

export async function catalogRestore(cfg: ArchiwareConfig, path: string, opts: { set: string; to: string; confirm: boolean }, progress: Progress = noProgress) {
  if (!opts.to.startsWith("/")) throw new P5Error("--to must be an absolute directory on the P5 host");
  const hit = await lookup(cfg, opts.set, path);
  const onDisk = (await filesExist(cfg, [hit.tarPath])).get(hit.tarPath) ?? false;
  const dest = `${opts.to.replace(/\/+$/, "")}/${hit.rel}`;
  const base = { set: opts.set, path: hit.rel, size: hit.size, tar: hit.tar, tarPath: hit.tarPath, tarOnDisk: onDisk, destination: dest };
  let tape: Awaited<ReturnType<typeof tapeInfo>> | undefined;
  let version: Awaited<ReturnType<typeof restoreOptions>>["versions"][number] | undefined;
  if (!onDisk) {
    const o = await restoreOptions(cfg, p5Path(cfg, hit.tarPath), { limit: 20 });
    tape = await tapeInfo(cfg, hit.tarPath);
    if (o.versions.length === 0) throw new P5Error(`tar ${hit.tar} is not on disk and P5 has no backup of it (${hit.tarPath}); nothing to restore from`);
    version = o.versions.find((v) => v.available);
    if (!version) throw new P5Error(`tar ${hit.tar} is not on disk and no tape holding it is in the library; fetch one of: ${JSON.stringify(o.fetchList)} and import it (tape_import), then retry`);
  }
  if (!opts.confirm) {
    return {
      confirmationRequired: true as const,
      ...base,
      plan: onDisk
        ? `extract ${hit.rel} from ${hit.tarPath} into ${opts.to}`
        : `restore ${hit.tar} from tape (${version!.start}, ${version!.volumes.map((v) => `${v.label ?? v.id} ${v.barcode ?? ""} ${v.location}`).join(" | ")}) into a scratch dir below ${cfg.packRoot}/.restore, extract ${hit.rel} into ${opts.to}, delete the scratch tar`,
      tape,
    };
  }
  if (onDisk) {
    const r = await runScript(cfg, EXTRACT_SCRIPT, [hit.tarPath, hit.rel, opts.to]);
    if (r.rc !== 0) throw new P5Error(`extraction failed (exit ${r.rc}): ${r.stderr}`);
    const f = r.stdout.split("\n").find((l) => l.startsWith("OK\t"))!.split("\t");
    return { confirmationRequired: false as const, ...base, source: "disk", extractedBytes: Number(f[1]), sha256: f[2] };
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const scratch = `${cfg.packRoot}/.restore/${opts.set}-${stamp}`;
  const scratchP5 = cfg.packRootP5 ? `${cfg.packRootP5}/.restore/${opts.set}-${stamp}` : scratch;
  progress(`restoring ${hit.tar} from tape into ${scratch}`);
  const started = (await restoreVersion(cfg, version!.start, p5Path(cfg, hit.tarPath), scratchP5, true)) as { job?: string };
  if (!started.job) throw new P5Error("P5 did not return a restore job id");
  progress(`restore job ${started.job} submitted`);
  const t0 = Date.now();
  let status = "";
  for (;;) {
    status = (await nsdchat(cfg, ["Job", started.job, "status"])).trim();
    if (!/^(running|scheduled|waiting|pending|active|queued)/i.test(status)) break;
    if (Date.now() - t0 > cfg.longTimeoutMs * 6) throw new P5Error(`restore job ${started.job} still ${status} after ${dur((Date.now() - t0) / 1000)}; the scratch dir ${scratch} is left in place, rerun later`);
    progress(`job ${started.job}: ${status} (${dur((Date.now() - t0) / 1000)})`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
  if (!/completed|finished|done|success/i.test(status)) throw new P5Error(`restore job ${started.job} ended with status "${status}"; scratch dir ${scratch} left for inspection`);
  const find = await runRemote(cfg, ["find", scratch, "-name", hit.tar, "-type", "f"].map(shellQuote).join(" "));
  const restored = find.stdout.split("\n").filter(Boolean)[0];
  if (!restored) throw new P5Error(`job ${started.job} completed but ${hit.tar} is not below ${scratch}; scratch dir left in place`);
  const r = await runScript(cfg, EXTRACT_SCRIPT, [restored, hit.rel, opts.to]);
  if (r.rc !== 0) throw new P5Error(`extraction from the restored tar failed (exit ${r.rc}): ${r.stderr}; scratch dir ${scratch} left in place`);
  const f = r.stdout.split("\n").find((l) => l.startsWith("OK\t"))!.split("\t");
  if (scratch.startsWith(`${cfg.packRoot}/.restore/`)) await runRemote(cfg, ["rm", "-rf", scratch].map(shellQuote).join(" "));
  return { confirmationRequired: false as const, ...base, source: "tape", job: started.job, extractedBytes: Number(f[1]), sha256: f[2], scratchRemoved: true };
}

// ---------------------------------------------------------------------------
// drop
// ---------------------------------------------------------------------------

export async function catalogDrop(cfg: ArchiwareConfig, set: string, confirm: boolean) {
  const r = await sql(cfg, `SELECT s.id, COUNT(t.id), COALESCE(SUM(t.files),0) FROM sets s LEFT JOIN tars t ON t.set_id=s.id WHERE s.name=${q(set)} GROUP BY s.id`);
  if (!r[0]) throw new P5Error(`no set "${set}"`);
  const info = { set, tars: Number(r[0][1]), files: Number(r[0][2]) };
  if (!confirm) return { confirmationRequired: true as const, ...info, wouldDo: "delete the set's rows (entries, tars, set) from the catalogue; the tar files on disk and on tape are not touched" };
  const id = r[0][0];
  for (;;) {
    const n = await sql(cfg, `DELETE FROM entries WHERE set_id=${id} LIMIT 50000; SELECT ROW_COUNT()`);
    if (Number(n[0]?.[0] ?? 0) === 0) break;
  }
  await sql(cfg, `DELETE FROM tars WHERE set_id=${id}; DELETE FROM sets WHERE id=${id}`);
  return { confirmationRequired: false as const, ...info, dropped: true, note: "rows deleted; tar files untouched" };
}
