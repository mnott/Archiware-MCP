/**
 * find_file / restore_version: one search over every backup of a file name.
 *
 * Sources feeding the same version model:
 *   - P5 backup index, copied into the catalogue by index_sync (tables names, dirs, p5_files; see indexsync.ts)
 *   - tar catalogue (tables entries, tars, sets): files inside the D2D2T tars
 * A version is a distinct (mtime, size) of one path. Every place a version can be fetched from is a location;
 * locations of one version are sorted cheapest first (RANK). Same path + mtime + size from different sources is
 * ONE version with several locations.
 *
 * Extension point for further sources (Seafile history, Seafile object store): add the kind to SourceKind and RANK,
 * then push FileLocation objects into the version map in findFile() (see addLocation); nothing else changes.
 */

import { createHash } from "node:crypto";
import type { ArchiwareConfig } from "./config.js";
import { catalogRestore, cacheStore, filesExist, q, sql, tapeInfo } from "./catalog.js";
import { getOrFetch } from "./cache.js";
import { locate, restoreVersion, snapshot, whereText, type Snapshot } from "./libops.js";
import { backupIndexDb, sqliteQuery } from "./p5db.js";
import type { Safety } from "./restoreguard.js";
import { P5Error } from "./transport.js";

export type SourceKind = "disk-tar" | "tape-library" | "tape-offline" | "tar-on-tape" | "seafile-live" | "seafile-object";

/** Lower = cheaper to fetch. tar-on-tape is 2 when a tape of it is in the library, else 3 (see locationRank). */
export const RANK: Record<SourceKind, number> = { "disk-tar": 1, "tape-library": 2, "tar-on-tape": 2, "tape-offline": 3, "seafile-live": 0, "seafile-object": 1 };

export interface FileLocation {
  /** stable id, usable as restore_version --from */
  id: string;
  kind: SourceKind;
  rank: number;
  /** human text: "on disk", "tape in library", "tape offline: BARCODE" */
  badge: string;
  barcode?: string | null;
  volume?: string;
  where?: string;
  set?: string;
  tar?: string;
  tarPath?: string;
  /** P5 client and backup time of the index row */
  client?: string;
  btime?: number;
}
export interface FileVersion {
  /** "<mtime>-<size>", the versionKey of restore_version */
  key: string;
  mtime: number;
  mtimeText: string;
  size: number;
  locations: FileLocation[];
  cheapest: SourceKind | null;
}
export interface FileHit {
  path: string;
  versions: FileVersion[];
}

export const versionKey = (mtime: number, size: number) => `${mtime}-${size}`;
const stampText = (s: number) => new Date(s * 1000).toISOString().replace("T", " ").slice(0, 19);
const escLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** LIKE pattern: glob (* ?) anchored, otherwise substring. */
export function likeOf(p: string): string {
  return /[*?]/.test(p) ? escLike(p).replace(/\*/g, "%").replace(/\?/g, "_") : `%${escLike(p)}%`;
}

export interface FindOpts {
  limit?: number;
  client?: string;
  /** only versions modified on/after this date (YYYY-MM-DD) */
  since?: string;
  /** path prefix */
  under?: string;
  /** pattern is one full path (used by restore_version) */
  exact?: boolean;
}

const CLIENT_RE = /^[A-Za-z0-9_.-]+$/;

async function p5Volumes(cfg: ArchiwareConfig, client: string, ids: number[]): Promise<Map<string, string[]>> {
  const m = new Map<string, string[]>();
  if (ids.length === 0) return m;
  const sorted = [...ids].sort((a, b) => a - b);
  const key = `mcp:addr:${client}:${createHash("sha1").update(sorted.join(",")).digest("hex")}`;
  const r = await getOrFetch(cacheStore(cfg), cfg.cacheTtlMinutes, key, async () => {
    const out: [string, string][] = [];
    for (let i = 0; i < sorted.length; i += 500) {
      const rows = await sqliteQuery(cfg, backupIndexDb(cfg, client, "addrs"), `select id,volid from addresses where id in (${sorted.slice(i, i + 500).join(",")}) and etime=2147483647`);
      for (const [id, volid] of rows) out.push([id, volid]);
    }
    return out;
  });
  for (const [id, volid] of r.value) m.set(id, [...(m.get(id) ?? []), volid]);
  return m;
}

/** Every backed-up version of every file matching the pattern, across P5 backups and tars. */
export async function findFile(cfg: ArchiwareConfig, pattern: string, opts: FindOpts = {}) {
  if (!pattern.trim()) throw new P5Error("a file name pattern is required");
  if (opts.client && !CLIENT_RE.test(opts.client)) throw new P5Error(`invalid client name "${opts.client}"`);
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  const since = opts.since ? Date.parse(`${opts.since}T00:00:00`) / 1000 : 0;
  if (opts.since && !Number.isFinite(since)) throw new P5Error(`invalid since "${opts.since}", expected YYYY-MM-DD`);
  const under = (opts.under ?? "").replace(/\/+$/, "");
  const notes: string[] = [];

  const slash = pattern.lastIndexOf("/");
  const base = opts.exact || slash >= 0 ? pattern.slice(slash + 1) : pattern;
  if (!base) throw new P5Error("the pattern needs a file name part (it ends with /)");
  const fullCond = (expr: string) => (opts.exact ? `${expr} = ${q(pattern)}` : slash >= 0 ? `${expr} LIKE ${q(likeOf(pattern))}` : "1=1");
  const underCond = (expr: string) => (under ? `(${expr} = ${q(under)} OR ${expr} LIKE ${q(`${escLike(under)}/%`)})` : "1=1");
  const nameWhere = opts.exact ? `h=UNHEX(LEFT(SHA2(${q(base)},256),32))` : `name LIKE ${q(likeOf(base))}`;

  const byPath = new Map<string, Map<string, FileVersion>>();
  const addVersion = (path: string, mtime: number, size: number, loc: FileLocation | null) => {
    const vs = byPath.get(path) ?? new Map<string, FileVersion>();
    byPath.set(path, vs);
    const key = versionKey(mtime, size);
    const v = vs.get(key) ?? { key, mtime, mtimeText: stampText(mtime), size, locations: [], cheapest: null };
    vs.set(key, v);
    if (loc && !v.locations.some((l) => l.id === loc.id)) v.locations.push(loc);
  };

  // ---- P5 backup index copy
  const nameIds = (await sql(cfg, `SELECT id FROM names WHERE ${nameWhere} LIMIT 5000`)).map((r) => r[0]);
  if (nameIds.length === 5000) notes.push("more than 5000 distinct file names match; narrow the pattern");
  interface P5Row {
    client: string;
    path: string;
    btime: number;
    dtime: number;
    mtime: number;
    size: number;
    pid: number;
  }
  const p5: P5Row[] = [];
  if (nameIds.length) {
    const pathExpr = `CONCAT(IF(d.path='/','',d.path),'/',n.name)`;
    const files = await sql(
      cfg,
      `SELECT f.client, f.dir_id, f.name_id, MIN(${pathExpr}) AS p FROM p5_files f JOIN names n ON n.id=f.name_id JOIN dirs d ON d.id=f.dir_id WHERE f.name_id IN (${nameIds.join(",")}) AND f.type<>1${opts.client ? ` AND f.client=${q(opts.client)}` : ""}${since ? ` AND f.mtime>=${Math.floor(since)}` : ""} AND ${underCond("d.path")} AND ${fullCond(pathExpr)} GROUP BY f.client, f.dir_id, f.name_id ORDER BY p LIMIT ${limit}`,
    );
    if (files.length === limit) notes.push(`P5 side limited to ${limit} files`);
    if (files.length) {
      const tuples = files.map((r) => `(${q(r[0])},${Number(r[1])},${Number(r[2])})`).join(",");
      const paths = new Map(files.map((r) => [`${r[0]}|${r[1]}|${r[2]}`, r[3]]));
      const vers = await sql(cfg, `SELECT client, dir_id, name_id, btime, dtime, mtime, size, pid FROM p5_files WHERE (client,dir_id,name_id) IN (${tuples})${since ? ` AND mtime>=${Math.floor(since)}` : ""} ORDER BY btime DESC`);
      for (const r of vers) p5.push({ client: r[0], path: paths.get(`${r[0]}|${r[1]}|${r[2]}`)!, btime: Number(r[3]), dtime: Number(r[4]), mtime: Number(r[5]), size: Number(r[6]), pid: Number(r[7]) });
    }
  }
  let snap: Snapshot | null = null;
  if (p5.length) {
    try {
      snap = await snapshot(cfg);
    } catch (e) {
      notes.push(`tape locations unknown (library/volumes unreadable: ${(e as Error).message.split("\n")[0]}); P5 versions shown as offline`);
    }
  }
  const volsByClient = new Map<string, Map<string, string[]>>();
  for (const client of new Set(p5.map((r) => r.client))) {
    try {
      volsByClient.set(client, await p5Volumes(cfg, client, p5.filter((r) => r.client === client).map((r) => r.pid)));
    } catch (e) {
      notes.push(`volumes of client ${client} unreadable: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  const volInfo = new Map(snap?.vols.map((v) => [v.id, v]) ?? []);
  for (const r of p5) {
    const vols = volsByClient.get(r.client)?.get(String(r.pid)) ?? [];
    if (vols.length === 0) addVersion(r.path, r.mtime, r.size, null);
    for (const volid of new Set(vols)) {
      const vi = volInfo.get(volid);
      const w = snap ? locate(cfg, snap.mtx, vi?.barcode ?? null) : ({ where: "offsite" } as const);
      const inLib = w.where !== "offsite";
      const barcode = vi?.barcode ?? null;
      addVersion(r.path, r.mtime, r.size, {
        id: `p5:${r.client}:${r.btime}:${volid}`,
        kind: inLib ? "tape-library" : "tape-offline",
        rank: inLib ? RANK["tape-library"] : RANK["tape-offline"],
        badge: inLib ? `tape in library (${barcode ?? volid}, ${whereText(w)})` : `tape offline: ${barcode ?? `volume ${volid}`}`,
        barcode,
        volume: volid,
        where: inLib ? whereText(w) : "not in the library",
        client: r.client,
        btime: r.btime,
      });
    }
  }

  // ---- tar catalogue
  const fullExpr = `CONCAT('/', TRIM(BOTH '/' FROM s.source_root), '/', e.path)`;
  const tarRows = await sql(
    cfg,
    `SELECT s.name, ${fullExpr}, e.size, UNIX_TIMESTAMP(e.mtime), t.id, t.name, t.path FROM entries e JOIN sets s ON s.id=e.set_id JOIN tars t ON t.id=e.tar_id WHERE e.basename ${opts.exact ? `= ${q(base)}` : `LIKE ${q(likeOf(base))}`} AND ${underCond(fullExpr)} AND ${fullCond(fullExpr)}${since ? ` AND e.mtime>=FROM_UNIXTIME(${Math.floor(since)})` : ""} ORDER BY ${fullExpr} LIMIT ${limit * 10}`,
  );
  const tarPaths = [...new Set(tarRows.map((r) => r[6]))];
  const disk = await filesExist(cfg, tarPaths);
  const tape = new Map<string, Awaited<ReturnType<typeof tapeInfo>>>();
  for (const tp of tarPaths.filter((p) => !disk.get(p)).slice(0, 30)) tape.set(tp, await tapeInfo(cfg, tp));
  if (tarPaths.filter((p) => !disk.get(p)).length > 30) notes.push("tape lookup done for the first 30 tars that are not on disk");
  const tarFiles = new Set<string>();
  for (const r of tarRows) {
    const path = r[1].replace(/\/{2,}/g, "/");
    if (opts.exact && path !== pattern) continue;
    tarFiles.add(path);
    if (tarFiles.size > limit && !byPath.has(path)) continue;
    const mtime = Number(r[3]) || 0;
    const base: Pick<FileLocation, "set" | "tar" | "tarPath"> = { set: r[0], tar: r[5], tarPath: r[6] };
    if (disk.get(r[6])) {
      addVersion(path, mtime, Number(r[2]), { id: `tar:${r[4]}`, kind: "disk-tar", rank: RANK["disk-tar"], badge: `on disk (${r[5]})`, ...base });
      continue;
    }
    const t = tape.get(r[6]);
    const vols = [...new Map((t?.versions ?? []).flatMap((v) => v.volumes).map((x) => [x.barcode ?? x.label ?? "?", x])).values()];
    if (!t?.onTape) {
      addVersion(path, mtime, Number(r[2]), null);
      continue;
    }
    const barcodes = vols.map((x) => x.barcode ?? x.label).filter(Boolean).join(", ");
    addVersion(path, mtime, Number(r[2]), {
      id: `tar:${r[4]}`,
      kind: "tar-on-tape",
      rank: t.available ? RANK["tar-on-tape"] : 3,
      badge: t.available ? `tar on tape in library (${barcodes})` : `tar on tape offline: ${barcodes}`,
      barcode: vols[0]?.barcode ?? null,
      ...base,
    });
  }

  const hits: FileHit[] = [...byPath.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([path, vs]) => ({
      path,
      versions: [...vs.values()]
        .map((v) => {
          v.locations.sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1));
          v.cheapest = v.locations[0]?.kind ?? null;
          return v;
        })
        .sort((a, b) => b.mtime - a.mtime || b.size - a.size),
    }));
  return {
    pattern,
    hits,
    limited: byPath.size > limit || notes.some((n) => /limited/.test(n)),
    notes,
    ranking: "disk-tar (1) < tape in library / tar on tape in library (2) < tape offline (3)",
  };
}

/** Cheapest location first, or the one named by `from`. */
export function pickLocation(v: FileVersion, from?: string): FileLocation {
  const loc = from ? v.locations.find((l) => l.id === from) : v.locations[0];
  if (!loc) throw new P5Error(from ? `version ${v.key} has no location "${from}" (have: ${v.locations.map((l) => l.id).join(", ") || "none"})` : `version ${v.key} has no known place to fetch it from`);
  return loc;
}

export async function restoreFileVersion(cfg: ArchiwareConfig, path: string, key: string, opts: Safety & { from?: string; client?: string }) {
  if (!path.startsWith("/")) throw new P5Error("path must be absolute (as find_file shows it)");
  const r = await findFile(cfg, path, { exact: true, limit: 1, client: opts.client });
  const hit = r.hits.find((h) => h.path === path);
  if (!hit) throw new P5Error(`"${path}" is in no backup index copy or tar catalogue; run find_file (and index_sync if the index is old)`);
  const v = hit.versions.find((x) => x.key === key);
  if (!v) throw new P5Error(`no version "${key}" of ${path}; versions: ${hit.versions.map((x) => `${x.key} (${x.mtimeText})`).join(", ")}`);
  const loc = pickLocation(v, opts.from);
  const chosen = { location: loc, alternatives: v.locations.filter((l) => l.id !== loc.id).map((l) => ({ id: l.id, badge: l.badge })) };
  if (loc.kind === "tape-offline" || (loc.kind === "tar-on-tape" && loc.rank === 3)) {
    throw new P5Error(`this version is only on a tape outside the library: insert ${loc.barcode ?? "the tape"} (${loc.badge}), run tape_import, then retry`);
  }
  if (loc.kind === "disk-tar" || loc.kind === "tar-on-tape") {
    const res = await catalogRestore(cfg, path.replace(/^\/+/, ""), { set: loc.set!, to: opts.to, confirm: opts.confirm, onConflict: opts.onConflict, forceSync: opts.forceSync, plan: opts.plan });
    return { version: key, ...chosen, via: loc.kind, result: res };
  }
  if (loc.kind === "tape-library") {
    const res = await restoreVersion(cfg, String(loc.btime), path, opts, loc.client);
    return { version: key, ...chosen, via: loc.kind, result: res };
  }
  throw new P5Error(`restoring from ${loc.kind} is not supported yet`);
}
