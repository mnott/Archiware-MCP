/**
 * index_sync: extract P5's backup index (files.db per client) into the catalogue database tables
 * names / dirs / p5_dirs / p5_files / index_state (schema in indexschema.ts).
 *
 * Everything runs on the P5 host as one pipeline per phase and never touches P5 itself:
 *   sqlite3 -readonly (immutable=1)  ->  awk (hex rows to multi-row INSERTs)  ->  mysql in the catalogue container
 * Phase 1 "dirs": ONE recursive CTE over the peid index builds every directory path set-based (no query per row);
 *   paths are merged into dirs, eid -> dir id into p5_dirs.
 * Phase 2 "files": one rowid-ordered scan of `elements` streams the version rows; every 200 000 rows the batch is
 *   merged (names INSERT IGNORE by hash, then p5_files joined to names and p5_dirs inside the database) and last_id is
 *   checkpointed. Memory is one stage table of that size on the database side, nothing is kept in a client map.
 * Incremental: rows with id > last_id (new versions) plus rows whose dtime moved since last_btime (versions that ended);
 *   one sequential pass, as the P5 tables have no index for either. A killed run resumes from last_id.
 * Long runs go detached (setsid nohup, like pack --detach); index_status shows rows, rows/s and the log tail.
 * The credentials file is streamed into the container's stdin ahead of the SQL and written to a mktemp file there
 * for the life of the mysql client only (removed on exit).
 */

import type { ArchiwareConfig } from "./config.js";
import { backupIndexDb, configDir } from "./p5db.js";
import { CATALOG_DB, q, runRemote, runScript, sql } from "./catalog.js";
import { SCHEMA_INDEX } from "./indexschema.js";
import { P5Error, shellQuote } from "./transport.js";

export const CLIENT_RE = /^[A-Za-z0-9_.-]+$/;
const FLUSH_ROWS = 200_000;

const RUNNER = String.raw`
set -o pipefail
export LC_ALL=C
CNF="$1"; CT="$2"; CL="$3"; FILESDB="$4"; LASTID="$5"; LASTBT="$6"; DTIME="$7"; FLUSH="$8"; INFO="$9"
N=$(wc -c < "$CNF" | tr -d ' ')
MY='f=$(mktemp) || exit 9; trap "rm -f \"$f\"" EXIT; dd bs=1 count="$1" of="$f" 2>/dev/null; "$(command -v mariadb || command -v mysql)" --defaults-extra-file="$f" --default-character-set=utf8mb4 -N -B ${CATALOG_DB}'
mysqlpipe() { { cat "$CNF"; cat; } | docker exec -i "$CT" sh -c "$MY" sh "$N"; }
tag() { while IFS= read -r l; do printf '%s %s\n' "$(date +%s)" "$l"; done; }
NICE=""; command -v ionice > /dev/null && NICE="nice -n 19 ionice -c 3"
sq() { $NICE sqlite3 -readonly -separator '|' "file:$FILESDB?immutable=1" "$1"; }
AWK='
BEGIN { FS = "|"; b = 0; n = 0; tot = 0; maxid = 0; maxbt = 0 }
function batch() { if (b > 0) { print HEAD buf ";"; buf = ""; b = 0 } }
function merge(   t) {
  batch()
  if (n > 0) {
    print MERGE
    print "TRUNCATE st;"
    t = TAIL; gsub(/@ID@/, maxid, t); gsub(/@N@/, n, t); if (t != "") print t
    print "SELECT \"PROGRESS " tot " " maxid "\";"
    n = 0
  }
}
{
  row = "(" $1
  for (i = 2; i < NF; i++) row = row "," $i
  row = row ",UNHEX(\"" $NF "\"))"
  buf = buf (b ? "," : "") row; b++; n++; tot++
  if ($1 + 0 > maxid) maxid = $1 + 0
  if (MODE == "files" && $4 + 0 > maxbt) maxbt = $4 + 0
  if (b >= 1000) batch()
  if (n >= FLUSH) merge()
}
END { merge(); print tot, maxbt > INFO }
'
START=$(date +%s)
echo "START client=$CL last_id=$LASTID last_btime=$LASTBT" | tag

echo "PHASE dirs" | tag
DIRS_MERGE="UPDATE st SET h=UNHEX(LEFT(SHA2(p,256),32)); INSERT IGNORE INTO dirs(path,h) SELECT CONVERT(p USING utf8mb4), h FROM st GROUP BY h; INSERT INTO p5_dirs(client,eid,dir_id) SELECT \"$CL\", s.eid, d.id FROM st s JOIN dirs d ON d.h=s.h ON DUPLICATE KEY UPDATE dir_id=VALUES(dir_id);"
{
  echo "SET SESSION sql_mode='';"
  echo "CREATE TEMPORARY TABLE st (eid BIGINT UNSIGNED NOT NULL, p VARBINARY(8192) NOT NULL, h BINARY(16) NULL) ENGINE=InnoDB;"
  echo "INSERT IGNORE INTO dirs(path,h) VALUES ('/', UNHEX(LEFT(SHA2('/',256),32))); INSERT IGNORE INTO p5_dirs(client,eid,dir_id) SELECT \"$CL\", 1, id FROM dirs WHERE h=UNHEX(LEFT(SHA2('/',256),32));"
  sq "with recursive d(eid,path) as (select distinct eid, '/'||name from elements where peid=1 and type=1 union select e.eid, d.path||'/'||e.name from elements e join d on e.peid=d.eid where e.type=1) select eid, hex(path) from d" |
    awk -v MODE=dirs -v FLUSH="$FLUSH" -v INFO="$INFO.dirs" -v HEAD="INSERT INTO st(eid,p) VALUES " -v MERGE="$DIRS_MERGE" -v TAIL=""  "$AWK"
} | mysqlpipe | tag || { echo "FAIL dirs" | tag; exit 1; }

echo "PHASE files" | tag
COND="e.id>$LASTID"
[ "$DTIME" = "1" ] && COND="($COND or (e.dtime<2147483647 and e.dtime>$LASTBT))"
FILES_MERGE="UPDATE st SET h=UNHEX(LEFT(SHA2(name,256),32)); INSERT IGNORE INTO names(name,h) SELECT CONVERT(name USING utf8mb4), h FROM st GROUP BY h; INSERT INTO p5_files(client,eid,btime,pid,name_id,dir_id,dtime,mtime,size,type) SELECT \"$CL\", s.eid, s.btime, s.pid, n.id, pd.dir_id, s.dtime, s.mtime, s.size, s.type FROM st s JOIN names n ON n.h=s.h JOIN p5_dirs pd ON pd.client=\"$CL\" AND pd.eid=s.peid ON DUPLICATE KEY UPDATE dtime=VALUES(dtime);"
FILES_TAIL="UPDATE index_state SET last_id=GREATEST(last_id,@ID@), \`rows\`=\`rows\`+@N@, updated_at=NOW() WHERE source='p5' AND client=\"$CL\";"
{
  echo "SET SESSION sql_mode='';"
  echo "CREATE TEMPORARY TABLE st (pid BIGINT UNSIGNED NOT NULL, eid BIGINT UNSIGNED NOT NULL, peid BIGINT UNSIGNED NOT NULL, btime INT UNSIGNED NOT NULL, dtime INT UNSIGNED NOT NULL, type TINYINT NOT NULL, mtime BIGINT NOT NULL, size BIGINT UNSIGNED NOT NULL, name VARBINARY(4096) NOT NULL, h BINARY(16) NULL, KEY (h)) ENGINE=InnoDB;"
  sq "select e.id, e.eid, e.peid, e.btime, e.dtime, e.type, ifnull(e.mtime,0), ifnull(e.size,0), hex(e.name) from elements e where e.type<>1 and $COND order by e.id" |
    awk -v MODE=files -v FLUSH="$FLUSH" -v INFO="$INFO.files" -v HEAD="INSERT INTO st(pid,eid,peid,btime,dtime,type,mtime,size,name) VALUES " -v MERGE="$FILES_MERGE" -v TAIL="$FILES_TAIL" "$AWK"
} | mysqlpipe | tag || { echo "FAIL files" | tag; exit 1; }

read TOT MAXBT < "$INFO.files"
[ -z "$MAXBT" ] && MAXBT=0
echo "UPDATE index_state SET last_btime=GREATEST(last_btime,$MAXBT), updated_at=NOW() WHERE source='p5' AND client=\"$CL\";" | mysqlpipe || { echo "FAIL state" | tag; exit 1; }
END=$(date +%s)
echo "DONE rows=$TOT seconds=$((END-START)) max_btime=$MAXBT" | tag
`;

const DETACH = String.raw`
export LC_ALL=C
d=/tmp/archiware-sync; mkdir -p "$d"
script="$1"; b="$d/$2"; shift 2
if [ -f "$b.pid" ] && kill -0 "$(cat "$b.pid")" 2>/dev/null; then echo "running $b"; exit 0; fi
rm -f "$b.rc" "$b.log"
setsid nohup bash -c 's="$1"; l="$2"; shift 2; bash -c "$s" runner "$@" > "$l.log" 2>&1; echo $? > "$l.rc"' x "$script" "$b" "$@" > /dev/null 2>&1 < /dev/null &
echo $! > "$b.pid"
echo "started $b"
`;

async function p5Clients(cfg: ArchiwareConfig): Promise<string[]> {
  const r = await runRemote(cfg, `ls -1 ${shellQuote(`${configDir(cfg)}/index/backup`)}`);
  if (r.rc !== 0) throw new P5Error(`cannot list ${configDir(cfg)}/index/backup on the P5 host: ${r.stderr.split("\n")[0]}`);
  return r.stdout.split("\n").filter((x) => x.startsWith("bsx_")).map((x) => x.slice(4)).filter((c) => CLIENT_RE.test(c));
}

export interface SyncState {
  client: string;
  lastBtime: number;
  lastId: number;
  rows: number;
  updatedAt: string;
}

async function readState(cfg: ArchiwareConfig, client?: string): Promise<SyncState[]> {
  const rows = await sql(cfg, `SELECT client, last_btime, last_id, \`rows\`, updated_at FROM index_state WHERE source='p5'${client ? ` AND client=${q(client)}` : ""} ORDER BY client`);
  return rows.map((r) => ({ client: r[0], lastBtime: Number(r[1]), lastId: Number(r[2]), rows: Number(r[3]), updatedAt: r[4] }));
}

/** Pure: rows/s from the timestamped PROGRESS lines of a runner log. */
export function rateFromLog(log: string): { rows: number; seconds: number; rowsPerSec: number | null; phase: string | null; done: boolean; failed: boolean } {
  const lines = log.split("\n").filter(Boolean);
  let phase: string | null = null;
  let first: { t: number; rows: number } | null = null;
  let last: { t: number; rows: number } | null = null;
  let start = 0;
  let done = false;
  let failed = false;
  let doneRows = 0;
  for (const l of lines) {
    const m = l.match(/^(\d+) (.*)$/);
    if (!m) continue;
    const t = Number(m[1]);
    const msg = m[2];
    if (msg.startsWith("START")) start = t;
    else if (msg.startsWith("PHASE ")) {
      phase = msg.slice(6);
      start = t;
      first = last = null;
    } else if (msg.startsWith("FAIL")) failed = true;
    else if (msg.startsWith("DONE")) {
      done = true;
      doneRows = Number(msg.match(/rows=(\d+)/)?.[1] ?? 0);
    } else if (msg.startsWith("PROGRESS ")) {
      const rows = Number(msg.split(" ")[1]);
      first ??= { t: start || t, rows: 0 };
      last = { t, rows };
    }
  }
  const rows = done ? doneRows : (last?.rows ?? 0);
  const seconds = last && first ? Math.max(last.t - first.t, 0) : 0;
  return { rows, seconds, rowsPerSec: last && first && seconds > 0 ? Math.round(last.rows / seconds) : null, phase, done, failed };
}

export async function indexSync(cfg: ArchiwareConfig, opts: { client?: string; full?: boolean; detach?: boolean; noDtime?: boolean; flushRows?: number } = {}, progress: (m: string) => void = () => undefined) {
  if (opts.client && !CLIENT_RE.test(opts.client)) throw new P5Error(`invalid client name "${opts.client}"`);
  for (const s of SCHEMA_INDEX) await sql(cfg, s);
  const clients = opts.client ? [opts.client] : await p5Clients(cfg);
  if (clients.length === 0) throw new P5Error(`no backup index found below ${configDir(cfg)}/index/backup`);
  const out: Record<string, unknown>[] = [];
  for (const client of clients) {
    await sql(cfg, `INSERT IGNORE INTO index_state(source,client,last_btime,last_id,\`rows\`,updated_at) VALUES ('p5',${q(client)},0,0,0,NOW())`);
    if (opts.full) await sql(cfg, `UPDATE index_state SET last_btime=0,last_id=0,\`rows\`=0 WHERE source='p5' AND client=${q(client)}`);
    const st = (await readState(cfg, client))[0];
    const args = [cfg.catalogDbCnf, cfg.catalogMysqlContainer, client, backupIndexDb(cfg, client, "files"), String(st.lastId), String(st.lastBtime), opts.noDtime ? "0" : "1", String(opts.flushRows ?? FLUSH_ROWS), `/tmp/archiware-sync/${client}.info`];
    if (opts.detach) {
      const r = await runScript(cfg, DETACH, [RUNNER, client, ...args]);
      out.push({ client, detached: true, state: r.stdout.trim(), resumeFromId: st.lastId, note: "index_status shows progress" });
      continue;
    }
    await runRemote(cfg, "mkdir -p /tmp/archiware-sync");
    let log = "";
    const r = await runScript(cfg, RUNNER, args, {
      timeoutMs: 12 * 3600_000,
      onLine: (l) => {
        log += `${l}\n`;
        progress(l.replace(/^\d+ /, ""));
      },
    });
    if (r.rc !== 0) throw new P5Error(`index_sync ${client} failed (exit ${r.rc}): ${r.stderr.split("\n")[0]} ${log.split("\n").filter((l) => /FAIL|rror/.test(l)).join("; ")}`);
    const rate = rateFromLog(log);
    const after = (await readState(cfg, client))[0];
    out.push({ client, mode: opts.full || st.lastId === 0 ? "full" : "incremental", rowsRead: rate.rows, seconds: rate.seconds, rowsPerSec: rate.rowsPerSec, lastId: after.lastId, lastBtime: after.lastBtime });
  }
  return { clients: out, note: "Nightly (staging runner, later): 15 2 * * * archiware index_sync >> /var/log/archiware-index.log 2>&1" };
}

export async function indexStatus(cfg: ArchiwareConfig) {
  const state = await readState(cfg).catch(() => [] as SyncState[]);
  const counts = await sql(cfg, `SELECT table_name, table_rows FROM information_schema.tables WHERE table_schema='${CATALOG_DB}' AND table_name IN ('names','dirs','p5_files','p5_dirs') ORDER BY table_name`).catch(() => []);
  const runs = await runRemote(cfg, 'for f in /tmp/archiware-sync/*.log; do [ -f "$f" ] || continue; b=$(echo "$f" | sed "s/\\.log$//"); echo "@@ $(basename "$b") rc=$(cat "$b.rc" 2>/dev/null) running=$( [ -f "$b.pid" ] && kill -0 "$(cat "$b.pid")" 2>/dev/null && echo 1 || echo 0)"; tail -n 400 "$f"; done');
  const detached: Record<string, unknown>[] = [];
  let cur: { name: string; head: string; log: string } | null = null;
  const flush = () => {
    if (!cur) return;
    const r = rateFromLog(cur.log);
    detached.push({ run: cur.name, ...(/running=1/.test(cur.head) ? { state: "running" } : { state: /rc=0\b/.test(cur.head) ? "finished" : "failed" }), phase: r.phase, rows: r.rows, rowsPerSec: r.rowsPerSec, logTail: cur.log.trim().split("\n").slice(-3) });
  };
  for (const l of runs.stdout.split("\n")) {
    if (l.startsWith("@@ ")) {
      flush();
      cur = { name: l.split(" ")[1], head: l, log: "" };
    } else if (cur) cur.log += `${l}\n`;
  }
  flush();
  return {
    state,
    tables: counts.map((c) => ({ table: c[0], approxRows: Number(c[1]) })),
    detached,
    note: "last_id = highest P5 element id read (resume point), last_btime = newest backup time read; table row counts are InnoDB estimates.",
  };
}
