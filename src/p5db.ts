/**
 * Read-only access to P5's own databases on the P5 host.
 *
 * P5 8 exposes neither the per-client backup index (a restore selection can only
 * take archive indexes through `findentry`, backup indexes are not addressable
 * by name, REST restore/restoreselections wants a body shape that is not
 * documented) nor its mail settings through nsdchat or REST. Both live in
 * SQLite files in P5's config folder:
 *   <config>/index/backup/bsx_<client>/{files,addrs}.db   the backup index
 *   <config>/customerconfig/resources.db                  resources incl. mail
 * They are opened with `sqlite3 -readonly file:...?immutable=1` on the host
 * (nothing is written, P5 is not disturbed). Needs `sqlite3` on the host.
 */

import type { ArchiwareConfig } from "./config.js";
import { hostCommand, P5Error } from "./transport.js";
import { dirname } from "node:path";

/** Host path of P5's config folder. */
export function configDir(cfg: ArchiwareConfig): string {
  if (cfg.p5ConfigDir) return cfg.p5ConfigDir;
  if (cfg.mode === "docker") {
    if (!cfg.logPath) throw new P5Error("cannot locate P5's config folder on the host: set p5ConfigDir (or logPath) in the config");
    return `${dirname(dirname(cfg.logPath))}/config`;
  }
  return `${cfg.p5Home}/config`;
}

export const sqlQuote = (s: string): string => `'${s.replaceAll("'", "''")}'`;

const SEP = "\x1f";

/** Run one read-only SELECT on a P5 SQLite file; rows of fields. */
export async function sqliteQuery(cfg: ArchiwareConfig, dbFile: string, sql: string, timeoutMs = 120_000): Promise<string[][]> {
  const r = await hostCommand(cfg, ["sqlite3", "-readonly", "-separator", SEP, `file:${dbFile}?immutable=1`, sql], timeoutMs);
  if (r.rc !== 0) throw new P5Error(`sqlite3 on the P5 host failed (is sqlite3 installed there? is ${dbFile} readable?): ${r.stderr.split("\n")[0]}`);
  const t = r.stdout.replace(/\n$/, "");
  return t === "" ? [] : t.split("\n").map((l) => l.split(SEP));
}

export const resourcesDb = (cfg: ArchiwareConfig) => `${configDir(cfg)}/customerconfig/resources.db`;
export const backupIndexDb = (cfg: ArchiwareConfig, client: string, file: "files" | "addrs") => `${configDir(cfg)}/index/backup/bsx_${client}/${file}.db`;

/** Nested SELECT resolving an absolute path to the entity ids (eid) of its last component. */
export function pathEidSql(path: string): string {
  const parts = path.split("/").filter((x) => x !== "");
  let sql = "select 1";
  for (const p of parts) sql = `select distinct eid from elements where peid in (${sql}) and name=${sqlQuote(p)}`;
  return sql;
}

export interface IndexVersion {
  id: string;
  eid: string;
  /** backup (snapshot) time, unix seconds */
  btime: number;
  /** version superseded/deleted at (2147483647 = still current) */
  dtime: number;
  type: "dir" | "file" | "link" | "other";
  mtime: number;
  size: number;
  /** snapshot info of the backup run that stored this version */
  plan: string | null;
  event: string | null;
  level: number | null;
  /** copies: volume ids that hold this version */
  volumes: string[];
}

const TYPES: Record<string, IndexVersion["type"]> = { "1": "dir", "3": "file", "2": "link" };

/**
 * Every stored version of a file or folder in the client's backup index: one
 * row per backup run that saved it, with the volumes holding a copy.
 * (For a folder the rows are the folder entry itself, i.e. runs that saved the
 * folder's metadata; its files have versions of their own.)
 */
export async function indexVersions(cfg: ArchiwareConfig, client: string, path: string, since?: number): Promise<IndexVersion[]> {
  if (!/^[A-Za-z0-9_.-]+$/.test(client)) throw new P5Error(`invalid client name "${client}"`);
  const p = path.replace(/\/+$/, "") || "/";
  const files = backupIndexDb(cfg, client, "files");
  const eidSql = pathEidSql(p);
  const rows = await sqliteQuery(
    cfg,
    files,
    `select e.id,e.eid,e.btime,e.dtime,e.type,e.mtime,e.size,s.plan,s.pool,s.level from elements e left join snapshots s on s.btime=e.btime where e.eid in (${eidSql}) ${since ? `and e.btime>=${Math.floor(since)}` : ""} order by e.btime desc limit 500`,
  );
  const ids = rows.map((r) => Number(r[0])).filter(Number.isFinite);
  const vols = new Map<string, Set<string>>();
  if (ids.length) {
    const adr = await sqliteQuery(cfg, backupIndexDb(cfg, client, "addrs"), `select id,volid from addresses where id in (${ids.join(",")}) and etime=2147483647`);
    for (const [id, volid] of adr) vols.set(id, (vols.get(id) ?? new Set()).add(volid));
  }
  const seen = new Set<string>();
  const out: IndexVersion[] = [];
  for (const r of rows) {
    if (seen.has(r[0])) continue;
    seen.add(r[0]);
    out.push({
      id: r[0],
      eid: r[1],
      btime: Number(r[2]),
      dtime: Number(r[3]),
      type: TYPES[r[4]] ?? "other",
      mtime: Number(r[5]),
      size: Number(r[6]),
      plan: r[7] || null,
      event: r[8] || null,
      level: r[9] === "" || r[9] === undefined ? null : Number(r[9]),
      volumes: [...(vols.get(r[0]) ?? [])],
    });
  }
  return out;
}

/** Past run spans per plan from the index snapshot table: runs of back-to-back snapshots of one plan are one run. */
export async function runSpans(cfg: ArchiwareConfig, client: string): Promise<{ plan: string; start: number; end: number }[]> {
  const rows = await sqliteQuery(cfg, backupIndexDb(cfg, client, "files"), "select plan,btime,ctime from snapshots where ctime>btime order by plan,btime");
  const out: { plan: string; start: number; end: number }[] = [];
  for (const [plan, b, c] of rows) {
    const start = Number(b);
    const end = Number(c);
    const last = out[out.length - 1];
    if (last && last.plan === plan && start - last.end < 1800) last.end = Math.max(last.end, end);
    else out.push({ plan, start, end });
  }
  return out;
}
