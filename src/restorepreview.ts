/**
 * Restore preview from P5's backup INDEX (never from a volume inventory).
 *
 * `Volume <id> inventory` walks the whole backup volume (minutes, more on big tapes). The preview
 * only needs what the chosen version of the path looked like, and the index has that:
 *   file    -> its size and mtime at that version
 *   folder  -> its direct entries at that version (parent = folder, btime <= at < dtime),
 *              first 50 listed, totals by one aggregate query
 * Source order: the catalogue database copy (p5_files, filled by index_sync; fast) when it covers
 * the version, else P5's own SQLite index on the P5 host (files.db).
 */

import type { ArchiwareConfig } from "./config.js";
import { q, sql } from "./catalog.js";
import { backupIndexDb, pathEidSql, sqliteQuery } from "./p5db.js";
import type { GuardFile } from "./restoreguard.js";
import { P5Error } from "./transport.js";

export const PREVIEW_LIMIT = 50;
const CLIENT_RE = /^[A-Za-z0-9_.-]+$/;

export interface IndexPreview {
  /** where the data came from */
  from: "catalog-db" | "p5-index";
  kind: "file" | "dir";
  /** at most PREVIEW_LIMIT entries; absolute source paths */
  files: GuardFile[];
  totals: { entries: number; bytes: number };
}

const fileEntry = (path: string, size: number, mtime: number): GuardFile => ({ dest: path, size, mtime: mtime || null });

/** Rows of `type` 1 are directories, 3 files, 2 links. */
const isDir = (t: string) => t === "1";

async function fromCatalog(cfg: ArchiwareConfig, client: string, path: string, at: number): Promise<IndexPreview | null> {
  const st = await sql(cfg, `SELECT last_btime FROM index_state WHERE source='p5' AND client=${q(client)} AND \`rows\`>0`, 20_000);
  if (!st.length || Number(st[0][0]) < at) return null; // not populated, or does not cover this version yet
  const h = (s: string) => `UNHEX(LEFT(SHA2(${q(s)},256),32))`;
  const ver = `f.client=${q(client)} AND f.btime<=${at} AND f.dtime>${at}`;
  const slash = path.lastIndexOf("/");
  const parent = slash <= 0 ? "/" : path.slice(0, slash);
  const name = path.slice(slash + 1);
  const one = await sql(
    cfg,
    `SELECT f.type, f.size, f.mtime FROM p5_files f JOIN dirs d ON d.id=f.dir_id AND d.h=${h(parent)} JOIN names n ON n.id=f.name_id AND n.h=${h(name)} WHERE ${ver} ORDER BY f.btime DESC LIMIT 1`,
    20_000,
  );
  if (one.length && !isDir(one[0][0])) {
    const size = Number(one[0][1]);
    return { from: "catalog-db", kind: "file", files: [fileEntry(path, size, Number(one[0][2]))], totals: { entries: 1, bytes: size } };
  }
  const from = `FROM p5_files f JOIN dirs d ON d.id=f.dir_id AND d.h=${h(path)} JOIN names n ON n.id=f.name_id WHERE ${ver}`;
  const agg = await sql(cfg, `SELECT COUNT(*), COALESCE(SUM(CASE WHEN f.type<>1 THEN f.size ELSE 0 END),0) ${from}`, 20_000);
  const count = Number(agg[0]?.[0] ?? 0);
  if (count === 0) return null;
  const rows = await sql(cfg, `SELECT n.name, f.type, f.size, f.mtime ${from} ORDER BY n.name LIMIT ${PREVIEW_LIMIT}`, 20_000);
  return {
    from: "catalog-db",
    kind: "dir",
    files: rows.map((r) => ({ ...fileEntry(`${path === "/" ? "" : path}/${r[0]}`, Number(r[2]), Number(r[3])), dir: isDir(r[1]) })),
    totals: { entries: count, bytes: Number(agg[0][1]) },
  };
}

async function fromP5Index(cfg: ArchiwareConfig, client: string, path: string, at: number): Promise<IndexPreview | null> {
  const files = backupIndexDb(cfg, client, "files");
  const ver = `btime<=${at} and dtime>${at}`;
  const one = await sqliteQuery(cfg, files, `select type,size,mtime from elements where eid in (${pathEidSql(path)}) and ${ver} order by btime desc limit 1`, 60_000);
  if (!one.length) return null;
  if (!isDir(one[0][0])) {
    const size = Number(one[0][1]);
    return { from: "p5-index", kind: "file", files: [fileEntry(path, size, Number(one[0][2]))], totals: { entries: 1, bytes: size } };
  }
  const kids = `from elements where peid in (${pathEidSql(path)}) and ${ver}`;
  const agg = await sqliteQuery(cfg, files, `select count(*), coalesce(sum(case when type<>1 then size else 0 end),0) ${kids}`, 60_000);
  const rows = await sqliteQuery(cfg, files, `select name,type,size,mtime ${kids} order by name limit ${PREVIEW_LIMIT}`, 60_000);
  return {
    from: "p5-index",
    kind: "dir",
    files: rows.map((r) => ({ ...fileEntry(`${path === "/" ? "" : path}/${r[0]}`, Number(r[2]), Number(r[3])), dir: isDir(r[1]) })),
    totals: { entries: Number(agg[0]?.[0] ?? 0), bytes: Number(agg[0]?.[1] ?? 0) },
  };
}

/** What `path` looked like at backup time `at` (unix seconds). Throws when the index knows nothing of it. */
export async function indexPreview(cfg: ArchiwareConfig, client: string, path: string, at: number): Promise<IndexPreview> {
  if (!CLIENT_RE.test(client)) throw new P5Error(`invalid client name "${client}"`);
  const p = path.replace(/\/+$/, "") || "/";
  const viaCatalog = await fromCatalog(cfg, client, p, at).catch(() => null);
  const r = viaCatalog ?? (await fromP5Index(cfg, client, p, at));
  if (!r) throw new P5Error(`${p} is not in the backup index of ${client} at ${new Date(at * 1000).toISOString()}`);
  return r;
}
