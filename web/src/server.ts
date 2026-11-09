/**
 * Read-only web page for the archiware-mcp tar catalogue.
 * Data: MySQL/MariaDB (SELECT only, user catalog_ro; INSERT/UPDATE on the cache table p5_cache only), P5 REST (volume label/barcode/location),
 * P5's backup index (SQLite, mounted read-only). Nothing is written, nothing is restored here:
 * restores stay confirm-gated in the MCP/CLI; the detail view shows the command.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { timingSafeEqual, scryptSync, createHmac, randomBytes, createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { DatabaseSync } from "node:sqlite";
import mysql from "mysql2/promise";

// ---------------------------------------------------------------- config

interface Config {
  listen: number;
  p5BaseUrl: string;
  p5RestUrl: string;
  p5Client: string;
  indexDir: string;
  mysqlHost: string;
  mysqlPort: number;
  mysqlDatabase: string;
  packRoot: string;
  /** default restore folder shown in the copyable commands (same as the MCP config restoreRoot; default <packRoot>/restore) */
  restoreRoot: string;
  packRootMount: string;
  packRootP5: string;
  mailSlots: number[];
  cliName: string;
  /** minutes a cached P5 lookup stays fresh; 0 = no cache */
  cacheTtlMinutes: number;
}
interface Secrets {
  mysql: { user: string; password: string };
  p5: { user: string; password: string };
  auth: { user: string; hash: string };
  sessionSecret?: string;
}

const cfg: Config = { listen: 8080, p5Client: "localhost", indexDir: "/p5index", mysqlPort: 3306, mysqlDatabase: "archive_catalog", packRootMount: "/packroot", packRootP5: "", mailSlots: [], cliName: "archiware", cacheTtlMinutes: 60, p5BaseUrl: "", p5RestUrl: "", mysqlHost: "", packRoot: "", restoreRoot: "", ...JSON.parse(readFileSync(process.env.CONFIG_FILE ?? "/config/config.json", "utf8")) };
const restoreRoot = (cfg.restoreRoot || `${cfg.packRoot || "/srv/archive/pack"}/restore`).replace(/\/+$/, "");
const destText = (origPath: string) => `${restoreRoot}/<YYYYMMDD-HHMMSS>${origPath.startsWith("/") ? "" : "/"}${origPath}`;
const planNote = "Run it as shown: it only prints the plan (host, destination, source, bytes, free space, files that would be overwritten, planId). To run exactly that plan, repeat with --yes --plan <planId from the plan>. Use --to original to restore in place, --on-conflict rename|overwrite to change what happens when files exist.";
const secrets: Secrets = JSON.parse(readFileSync(process.env.SECRETS_FILE ?? "/secrets/secrets.json", "utf8"));

const pool = mysql.createPool({ host: cfg.mysqlHost, port: cfg.mysqlPort, user: secrets.mysql.user, password: secrets.mysql.password, database: cfg.mysqlDatabase, connectionLimit: 4, charset: "utf8mb4" });

// ---------------------------------------------------------------- cache of slow P5 lookups (table p5_cache)
// Same helper as src/cache.ts of archiware-mcp (copied: this is a separate build). The table is created by
// catalog_init; if it is missing the viewer tries to create it and, lacking the right (catalog_ro has no CREATE), runs without cache.

interface Cached<T> {
  value: T;
  cache: "off" | "miss" | "hit" | "stale";
  ageS?: number;
  error?: string;
}

let cacheReady: Promise<boolean> | null = null;
function cacheAvailable(): Promise<boolean> {
  cacheReady ??= (async () => {
    if (!(cfg.cacheTtlMinutes > 0)) return false;
    try {
      await pool.query("CREATE TABLE IF NOT EXISTS p5_cache (k VARCHAR(255) NOT NULL PRIMARY KEY, v LONGTEXT NULL, fetched_at DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    } catch {
      /* no CREATE right: fine when the table exists already, probed next */
    }
    try {
      await pool.query("SELECT 1 FROM p5_cache LIMIT 1");
      return true;
    } catch (e) {
      console.error("p5_cache unavailable, running without cache:", (e as Error).message);
      return false;
    }
  })();
  return cacheReady;
}

async function getOrFetch<T>(key: string, fetch: () => Promise<T>): Promise<Cached<T>> {
  if (!(await cacheAvailable())) return { value: await fetch(), cache: "off" };
  let hit: { value: T; ageS: number } | null = null;
  try {
    const [rows] = await pool.query("SELECT v, TIMESTAMPDIFF(SECOND, fetched_at, NOW()) AS age FROM p5_cache WHERE k=?", [key]);
    const r = (rows as { v: string; age: number }[])[0];
    if (r) hit = { value: JSON.parse(r.v) as T, ageS: Number(r.age) };
  } catch {
    hit = null;
  }
  if (hit && hit.ageS < cfg.cacheTtlMinutes * 60) return { value: hit.value, cache: "hit", ageS: hit.ageS };
  try {
    const value = await fetch();
    try {
      await pool.query("INSERT INTO p5_cache(k, v, fetched_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE v=VALUES(v), fetched_at=NOW()", [key, JSON.stringify(value)]);
    } catch {
      /* cache write failed: still return the fresh value */
    }
    return { value, cache: "miss" };
  } catch (e) {
    if (hit) return { value: hit.value, cache: "stale", ageS: hit.ageS, error: (e as Error).message };
    throw e;
  }
}

// ---------------------------------------------------------------- helpers

const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const human = (b: number): string => (b >= 1024 ** 4 ? `${(b / 1024 ** 4).toFixed(2)} TiB` : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GiB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MiB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KiB` : `${b} B`);
const fmtTime = (v: unknown): string => (v instanceof Date ? v.toISOString().replace("T", " ").slice(0, 19) : String(v ?? ""));
const stamp = (unix: number): string => new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 16);
const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** Glob (* ?) or substring -> SQL LIKE pattern and column (same rules as catalog_search in archiware-mcp). */
export function likeFor(pattern: string): { column: "path" | "basename"; like: string } {
  const glob = /[*?]/.test(pattern);
  const e = pattern.replace(/[\\%_]/g, (c) => `\\${c}`);
  const like = glob ? e.replace(/\*/g, "%").replace(/\?/g, "_") : `%${e}%`;
  return { column: pattern.includes("/") || !glob ? "path" : "basename", like };
}

// ---------------------------------------------------------------- auth

function verifyLogin(user: string, pw: string): boolean {
  const parts = secrets.auth.hash.split("$");
  if (parts[0] !== "scrypt" || parts.length !== 4) return false;
  const want = Buffer.from(parts[3], "hex");
  const got = scryptSync(pw, Buffer.from(parts[2], "hex"), want.length, { N: Number(parts[1]) });
  const userOk = user.length === secrets.auth.user.length && timingSafeEqual(Buffer.from(user), Buffer.from(secrets.auth.user));
  return timingSafeEqual(got, want) && userOk;
}

// ponytail: without "sessionSecret" in the secrets file a random one is made at start, so every restart logs everyone out.
const sessionSecret = secrets.sessionSecret ?? randomBytes(32).toString("hex");
const SESSION_DAYS = 30;
const COOKIE = "catalog_session";

function sign(expiry: string): string {
  return createHmac("sha256", sessionSecret).update(expiry).digest("hex");
}

function makeSession(): string {
  const expiry = String(Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400);
  return `${expiry}.${sign(expiry)}`;
}

function validSession(value: string): boolean {
  const [expiry, mac, ...extra] = value.split(".");
  if (!expiry || !mac || extra.length || !/^\d+$/.test(expiry)) return false;
  const want = Buffer.from(sign(expiry));
  const got = Buffer.from(mac);
  return got.length === want.length && timingSafeEqual(got, want) && Number(expiry) > Date.now() / 1000;
}

function hasSession(req: IncomingMessage): boolean {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return validSession(part.slice(i + 1).trim());
  }
  return false;
}

/** Only a relative path+query without scheme, "//" or backslash is accepted; anything else becomes "./". */
function safeNext(v: string | null | undefined): string {
  if (!v || v.startsWith("/") || v.includes("//") || v.includes("\\") || /^[a-z][a-z0-9+.-]*:/i.test(v) || /[\x00-\x1f]/.test(v)) return "./";
  return v;
}

function loginPage(next: string, error = ""): string {
  return page("Login", `<div class="card" style="max-width:24rem;margin:2rem auto"><h1>Log in</h1>${error ? `<p><span class="tag bad">${esc(error)}</span></p>` : ""}<form class="login" method="post" action="login"><input type="hidden" name="next" value="${esc(next)}"><label>User<input type="text" name="username" autocomplete="username" autofocus required></label><label>Password<input type="password" name="password" autocomplete="current-password" required></label><button type="submit">Log in</button></form></div>`, false);
}

function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c;
      if (body.length > 8192) { req.destroy(); reject(new Error("too large")); }
    });
    req.on("end", () => resolve(new URLSearchParams(body)));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------- P5 REST (volumes)

interface Vol {
  id: string;
  label: string;
  barcode: string;
  online: boolean;
  location: string;
}
// short in-process memo on top of p5_cache: one search page asks for the volumes once per tar
let volMemo: { at: number; vols: Map<string, Vol>; stale: boolean } | null = null;

function p5Get(path: string): Promise<unknown> {
  const u = new URL(`${cfg.p5RestUrl}/rest/v1/${path}`);
  return new Promise((resolve, reject) => {
    const r = httpsRequest({ host: u.hostname, port: u.port, path: u.pathname, method: "GET", rejectUnauthorized: false, auth: `${secrets.p5.user}:${secrets.p5.password}`, timeout: 15000 }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => {
        try {
          resolve(JSON.parse(b));
        } catch {
          reject(new Error(`P5 REST ${path}: HTTP ${res.statusCode}, not JSON`));
        }
      });
    });
    r.on("timeout", () => r.destroy(new Error("P5 REST timeout")));
    r.on("error", reject);
    r.end();
  });
}

async function volumes(): Promise<{ vols: Map<string, Vol>; stale: boolean }> {
  if (volMemo && Date.now() - volMemo.at < 120_000) return volMemo;
  const r = await getOrFetch<Vol[]>("web:volumes", async () => {
    const list = (await p5Get("general/volumes")) as { volumes?: { ID: string }[] };
    const out: Vol[] = [];
    for (const { ID } of list.volumes ?? []) {
      const d = (await p5Get(`general/volumes/${ID}`)) as Record<string, unknown>;
      out.push({ id: ID, label: String(d.label ?? ""), barcode: String(d.barcode ?? ""), online: d.isonline === true, location: String(d.location ?? "") });
    }
    return out;
  });
  volMemo = { at: Date.now(), vols: new Map(r.value.map((v) => [v.id, v])), stale: r.cache === "stale" };
  return volMemo;
}

function whereText(v: Vol | undefined): string {
  if (!v) return "volume unknown to P5 (recycled?)";
  if (!v.online) return "not in the library";
  const slot = v.location.match(/slot\s+(\d+)/i);
  if (slot) return cfg.mailSlots.includes(Number(slot[1])) ? `mail slot ${slot[1]}` : `library slot ${slot[1]}`;
  if (/drive/i.test(v.location)) return "in a drive";
  return v.location.replace(/<empty>/, "") || "online";
}

// ---------------------------------------------------------------- P5 backup index (read-only SQLite)
// Same lookup as indexVersions() in archiware-mcp src/p5db.ts, here with node:sqlite on a read-only mount.

const q1 = (s: string): string => `'${s.replaceAll("'", "''")}'`;
function pathEidSql(path: string): string {
  let sql = "select 1";
  for (const p of path.split("/").filter((x) => x !== "")) sql = `select distinct eid from elements where peid in (${sql}) and name=${q1(p)}`;
  return sql;
}
interface TapeVersion {
  date: string;
  level: string;
  volumes: { label: string; barcode: string; where: string }[];
}
interface TapeResult {
  versions: TapeVersion[];
  error?: string;
  /** served from an expired cache entry because P5 could not be asked; minutes since it was fetched */
  staleMinutes?: number;
}

/** Which tape holds this tar (index + volumes), cached; an expired entry is served, marked stale, when P5 fails. */
async function tapeVersions(tarHostPath: string): Promise<TapeResult> {
  const p5Path = cfg.packRootP5 && tarHostPath.startsWith(`${cfg.packRoot}/`) ? cfg.packRootP5 + tarHostPath.slice(cfg.packRoot.length) : tarHostPath;
  try {
    const r = await getOrFetch<{ versions: TapeVersion[]; stale: boolean }>(`web:tape:${createHash("sha1").update(p5Path).digest("hex")}`, () => tapeLookup(p5Path));
    const stale = r.cache === "stale" || r.value.stale;
    return { versions: r.value.versions, ...(stale ? { staleMinutes: Math.round((r.ageS ?? 0) / 60) } : {}) };
  } catch (e) {
    return { versions: [], error: (e as Error).message };
  }
}

/** The uncached lookup; throws when the index or P5 cannot be read. */
async function tapeLookup(p5Path: string): Promise<{ versions: TapeVersion[]; stale: boolean }> {
  {
    const filesDb = `${cfg.indexDir}/bsx_${cfg.p5Client}/files.db`;
    const addrDb = `${cfg.indexDir}/bsx_${cfg.p5Client}/addrs.db`;
    if (!existsSync(filesDb)) throw new Error("P5 backup index not mounted");
    const f = new DatabaseSync(`file:${filesDb}?immutable=1`, { readOnly: true });
    let rows: { id: number; btime: number; level: number | null }[];
    try {
      rows = f.prepare(`select e.id as id, e.btime as btime, s.level as level from elements e left join snapshots s on s.btime=e.btime where e.eid in (${pathEidSql(p5Path)}) order by e.btime desc limit 20`).all() as never;
    } finally {
      f.close();
    }
    if (rows.length === 0) return { versions: [], stale: false };
    const { vols, stale } = await volumes();
    const a = new DatabaseSync(`file:${addrDb}?immutable=1`, { readOnly: true });
    try {
      const out: TapeVersion[] = [];
      const seen = new Set<number>();
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        const ids = (a.prepare("select distinct volid from addresses where id=? and etime=2147483647").all(r.id) as { volid: number | string }[]).map((x) => String(x.volid));
        out.push({ date: stamp(r.btime), level: r.level === null ? "" : r.level === 1 ? "full" : "incremental", volumes: ids.map((id) => ({ label: vols.get(id)?.label ?? id, barcode: vols.get(id)?.barcode ?? "", where: whereText(vols.get(id)) })) });
      }
      return { versions: out, stale };
    } finally {
      a.close();
    }
  }
}

function onDisk(tarHostPath: string): boolean {
  const p = cfg.packRoot && tarHostPath.startsWith(`${cfg.packRoot}/`) ? cfg.packRootMount + tarHostPath.slice(cfg.packRoot.length) : tarHostPath;
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- HTML

const CSS = `
:root{--bg:#eceff1;--card:#fff;--bar:#3b4a57;--blue:#1f6fb2;--blue2:#e3f0fa;--line:#cfd8dc;--txt:#263238;--mut:#607d8b;--ok:#2e7d32;--warn:#b26a00;--bad:#c62828}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:15px/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
header{background:var(--bar);color:#fff;padding:.6rem 1rem;display:flex;flex-wrap:wrap;gap:.5rem 1.5rem;align-items:center}
header b{font-size:1.1rem}header a{color:#cfe3f3;text-decoration:none}header a:hover{color:#fff}header .sp{flex:1}
main{max-width:1100px;margin:1rem auto;padding:0 .75rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:.8rem 1rem;margin-bottom:1rem;overflow-x:auto}
form.s{display:flex;flex-wrap:wrap;gap:.5rem}form.s input[type=text]{flex:1 1 16rem;padding:.55rem;border:1px solid var(--line);border-radius:4px;font-size:1rem}
form.s select,form.s button{padding:.55rem .8rem;border:1px solid var(--line);border-radius:4px;font-size:1rem;background:#fff}
form.s button{background:var(--blue);color:#fff;border-color:var(--blue);cursor:pointer}
form.login{display:grid;gap:.6rem}form.login label{display:grid;gap:.25rem;font-size:.9rem}form.login input[type=text],form.login input[type=password]{width:100%;box-sizing:border-box;padding:.55rem;border:1px solid var(--line);border-radius:4px;font-size:1rem}
form.login button{width:100%;padding:.55rem .8rem;border:1px solid var(--blue);border-radius:4px;font-size:1rem;background:var(--blue);color:#fff;cursor:pointer}
table{border-collapse:collapse;width:100%}th{background:var(--blue2);text-align:left;font-weight:600}th,td{padding:.4rem .55rem;border-bottom:1px solid var(--line);vertical-align:top}
td.n,th.n{text-align:right;white-space:nowrap}a{color:var(--blue)}code,pre{font:13px/1.4 ui-monospace,Menlo,Consolas,monospace}
pre{background:#263238;color:#eceff1;padding:.7rem;border-radius:4px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
.tag{display:inline-block;padding:0 .45rem;border-radius:9px;font-size:.8rem;border:1px solid}.ok{color:var(--ok);border-color:var(--ok)}.warn{color:var(--warn);border-color:var(--warn)}.bad{color:var(--bad);border-color:var(--bad)}
.mut{color:var(--mut)}h1{font-size:1.2rem;margin:.2rem 0 .6rem}h2{font-size:1.05rem;margin:.2rem 0 .5rem}.path{word-break:break-all}
@media(max-width:640px){th.h,td.h{display:none}body{font-size:14px}}`;

function page(title: string, body: string, authed = true): string {
  const p5 = cfg.p5BaseUrl ? `<a href="${esc(cfg.p5BaseUrl)}" target="_blank" rel="noopener">P5 web UI</a>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} - Catalogue</title><style>${CSS}</style></head><body><header><b>Archive catalogue</b>${authed ? '<a href="./">Search</a><a href="sets">Sets</a>' : ""}<span class="sp"></span>${p5}${authed ? '<a href="logout">Log out</a>' : ""}</header><main>${body}</main></body></html>`;
}

const tarTag = (d: boolean) => (d ? `<span class="tag ok">tar on disk</span>` : `<span class="tag warn">tar not on disk</span>`);
const hitUrl = (set: string, path: string) => `hit?set=${encodeURIComponent(set)}&path=${encodeURIComponent(path)}`;

function tapeHtml(t: TapeResult): string {
  if (t.error) return `<span class="tag bad">tape lookup failed</span> <span class="mut">${esc(t.error)}</span>`;
  const stale = t.staleMinutes === undefined ? "" : `<div><span class="tag warn">stale</span> <span class="mut">P5 could not be asked; answer from ${t.staleMinutes} min ago</span></div>`;
  if (t.versions.length === 0) return `${stale}<span class="tag warn">not on tape</span>`;
  return stale + t.versions
    .map((v) => `<div><span class="mut">${esc(v.date)} ${esc(v.level)}</span> ${v.volumes.map((x) => `${esc(x.label)} <code>${esc(x.barcode)}</code> <span class="tag ${/slot|drive/.test(x.where) && !/not in/.test(x.where) ? "ok" : "warn"}">${esc(x.where)}</span>`).join(" &middot; ")}</div>`)
    .join("");
}

// ---------------------------------------------------------------- unified file search (same model as findFile() in archiware-mcp src/findfile.ts)
// Names first (table names), then the version rows of the matches (p5_files, filled by index_sync) and the tar catalogue;
// versions are (mtime, size) per path, locations cheapest first: 1 on disk (tar), 2 tape in library, 3 tape offline.

interface WLoc {
  rank: number;
  badge: string;
  cls: "ok" | "warn" | "bad";
}
interface WVersion {
  key: string;
  mtime: number;
  size: number;
  locs: WLoc[];
}
const escLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const likeOf = (p: string): string => (/[*?]/.test(p) ? escLike(p).replace(/\*/g, "%").replace(/\?/g, "_") : `%${escLike(p)}%`);

async function findFileWeb(pattern: string, under: string, limit: number): Promise<{ hits: { path: string; versions: WVersion[] }[]; limited: boolean; notes: string[] }> {
  const notes: string[] = [];
  const slash = pattern.lastIndexOf("/");
  const base = slash >= 0 ? pattern.slice(slash + 1) : pattern;
  if (!base) return { hits: [], limited: false, notes: ["The pattern needs a file name part."] };
  const fullLike = slash >= 0 ? likeOf(pattern) : "%";
  const underClause = (expr: string): [string, string[]] => {
    const u = under.replace(/\/+$/, "");
    return u ? [`(${expr} = ? OR ${expr} LIKE ?)`, [u, `${escLike(u)}/%`]] : ["1=1", []];
  };
  const byPath = new Map<string, Map<string, WVersion>>();
  const add = (path: string, mtime: number, size: number, loc: WLoc | null) => {
    const vs = byPath.get(path) ?? new Map<string, WVersion>();
    byPath.set(path, vs);
    const key = `${mtime}-${size}`;
    const v = vs.get(key) ?? { key, mtime, size, locs: [] };
    vs.set(key, v);
    if (loc && !v.locs.some((l) => l.badge === loc.badge)) v.locs.push(loc);
  };

  // P5 backup index copy
  try {
    const [nr] = await pool.query("SELECT id FROM names WHERE name LIKE ? LIMIT 5000", [likeOf(base)]);
    const ids = (nr as { id: number }[]).map((r) => r.id);
    if (ids.length === 5000) notes.push("More than 5000 distinct names match; narrow the pattern.");
    if (ids.length) {
      const pathExpr = "CONCAT(IF(d.path='/','',d.path),'/',n.name)";
      const [uc, up] = underClause("d.path");
      const [fr] = await pool.query(`SELECT f.client, f.dir_id, f.name_id, MIN(${pathExpr}) AS p FROM p5_files f JOIN names n ON n.id=f.name_id JOIN dirs d ON d.id=f.dir_id WHERE f.name_id IN (?) AND f.type<>1 AND ${uc} AND ${pathExpr} LIKE ? GROUP BY f.client, f.dir_id, f.name_id ORDER BY p LIMIT ${limit}`, [ids, ...up, fullLike]);
      const files = fr as { client: string; dir_id: number; name_id: number; p: string }[];
      if (files.length) {
        const paths = new Map(files.map((f) => [`${f.client}|${f.dir_id}|${f.name_id}`, f.p]));
        const [vr] = await pool.query(`SELECT client, dir_id, name_id, btime, mtime, size, pid FROM p5_files WHERE (client,dir_id,name_id) IN (?) ORDER BY btime DESC`, [files.map((f) => [f.client, f.dir_id, f.name_id])]);
        const rows = vr as { client: string; dir_id: number; name_id: number; btime: number; mtime: number; size: number; pid: number }[];
        let vols: Map<string, Vol> | null = null;
        let volErr = "";
        try {
          vols = (await volumes()).vols;
        } catch (e) {
          volErr = (e as Error).message;
          notes.push(`Tape locations unknown (${volErr}); versions shown as offline.`);
        }
        for (const r of rows) {
          const path = paths.get(`${r.client}|${r.dir_id}|${r.name_id}`)!;
          let volIds: string[] = [];
          const addrDb = `${cfg.indexDir}/bsx_${r.client}/addrs.db`;
          if (existsSync(addrDb)) {
            const a = new DatabaseSync(`file:${addrDb}?immutable=1`, { readOnly: true });
            try {
              volIds = (a.prepare("select distinct volid from addresses where id=? and etime=2147483647").all(Number(r.pid)) as { volid: number | string }[]).map((x) => String(x.volid));
            } finally {
              a.close();
            }
          }
          if (volIds.length === 0) add(path, Number(r.mtime), Number(r.size), null);
          for (const id of volIds) {
            const v = vols?.get(id);
            const inLib = !!v && v.online;
            add(path, Number(r.mtime), Number(r.size), inLib ? { rank: 2, badge: `tape in library: ${v!.barcode || v!.label} (${whereText(v)})`, cls: "ok" } : { rank: 3, badge: `tape offline: ${v?.barcode || v?.label || `volume ${id}`}`, cls: "bad" });
          }
        }
      }
    }
  } catch (e) {
    notes.push(`P5 index copy not searchable (${(e as Error).message}); run index_sync.`);
  }

  // tar catalogue
  const fullExpr = "CONCAT('/', TRIM(BOTH '/' FROM s.source_root), '/', e.path)";
  const [uc2, up2] = underClause(fullExpr);
  const [tr] = await pool.query(`SELECT ${fullExpr} AS full, e.size, UNIX_TIMESTAMP(e.mtime) AS mt, t.name AS tname, t.path AS tpath FROM entries e JOIN sets s ON s.id=e.set_id JOIN tars t ON t.id=e.tar_id WHERE e.basename LIKE ? AND ${uc2} AND ${fullExpr} LIKE ? ORDER BY full LIMIT ${limit * 10}`, [likeOf(base), ...up2, fullLike]);
  const tarRows = tr as { full: string; size: number; mt: number | null; tname: string; tpath: string }[];
  const tape = new Map<string, TapeResult>();
  for (const tp of [...new Set(tarRows.map((r) => r.tpath))].filter((p) => !onDisk(p)).slice(0, 30)) tape.set(tp, await tapeVersions(tp));
  for (const r of tarRows) {
    const path = r.full.replace(/\/{2,}/g, "/");
    if (byPath.size >= limit && !byPath.has(path)) continue;
    const mtime = Number(r.mt) || 0;
    if (onDisk(r.tpath)) {
      add(path, mtime, Number(r.size), { rank: 1, badge: `on disk (${r.tname})`, cls: "ok" });
      continue;
    }
    const t = tape.get(r.tpath);
    const vs = t?.versions.flatMap((v) => v.volumes) ?? [];
    if (!t || vs.length === 0) {
      add(path, mtime, Number(r.size), null);
      continue;
    }
    const inLib = vs.some((x) => /slot|drive/.test(x.where) && !/not in/.test(x.where));
    const codes = [...new Set(vs.map((x) => x.barcode || x.label))].join(", ");
    add(path, mtime, Number(r.size), inLib ? { rank: 2, badge: `tar on tape in library: ${codes}`, cls: "ok" } : { rank: 3, badge: `tar on tape offline: ${codes}`, cls: "bad" });
  }
  const hits = [...byPath.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([path, vs]) => ({ path, versions: [...vs.values()].map((v) => ({ ...v, locs: v.locs.sort((a, b) => a.rank - b.rank) })).sort((a, b) => b.mtime - a.mtime || b.size - a.size) }));
  return { hits, limited: byPath.size > limit, notes };
}

// ---------------------------------------------------------------- routes

async function searchPage(u: URL): Promise<string> {
  const pattern = (u.searchParams.get("q") ?? "").trim();
  const under = (u.searchParams.get("under") ?? "").trim();
  let result = "";
  if (pattern) {
    const limit = 50;
    const r = await findFileWeb(pattern, under, limit);
    const cli = (path: string, key: string) => `${cfg.cliName} restore_version ${shq(path)} ${shq(key)}\n# lands in ${destText(path)} (default restore folder)\n# then: ${cfg.cliName} restore_version ${shq(path)} ${shq(key)} --yes --plan <planId>`;
    result = `<div class="card"><h2>${r.hits.length}${r.limited ? "+" : ""} file(s)</h2>${r.notes.map((n) => `<p><span class="tag warn">note</span> ${esc(n)}</p>`).join("")}${
      r.hits.length === 0
        ? `<p class="mut">Nothing found.</p>`
        : r.hits
            .map(
              (h) => `<h2 class="path" style="margin-top:1rem">${esc(h.path)}</h2><table><tr><th>Modified</th><th class="n">Size</th><th>Where to get it (cheapest first)</th><th class="h">Restore (copy; the first run only prints the plan)</th></tr>${h.versions
                .map((v) => `<tr><td>${esc(stamp(v.mtime))}</td><td class="n">${human(v.size)}</td><td>${v.locs.length ? v.locs.map((l) => `<span class="tag ${l.cls}">${esc(l.badge)}</span>`).join(" ") : '<span class="tag warn">no known copy</span>'}</td><td class="h"><pre style="margin:0;white-space:pre-wrap">${esc(cli(h.path, v.key))}</pre></td></tr>`)
                .join("")}</table>`,
            )
            .join("")
    }${r.hits.length ? `<p class="mut">${esc(planNote)}</p>` : ""}${cfg.p5BaseUrl ? `<p><a href="${esc(cfg.p5BaseUrl)}" target="_blank" rel="noopener">Open the P5 web UI</a></p>` : ""}</div>`;
  }
  return page("Search", `<div class="card"><form class="s" method="get" action="./"><input type="text" name="q" value="${esc(pattern)}" placeholder="file name, or a glob like *.pdf" autofocus><input type="text" name="under" value="${esc(under)}" placeholder="only below path (optional)" style="flex:0 1 14rem;padding:.55rem;border:1px solid var(--line);border-radius:4px;font-size:1rem"><button>Search</button></form><p class="mut" style="margin:.5rem 0 0">Searches file names in every backup (P5 backup index and tars): substring, or glob with <code>*</code> and <code>?</code>; a pattern with a <code>/</code> also matches the directory. Each version (modification time + size) lists every place it can be fetched from, cheapest first.</p></div>${result}`);
}

async function hitPage(u: URL): Promise<string> {
  const set = u.searchParams.get("set") ?? "";
  const path = u.searchParams.get("path") ?? "";
  const [rows] = await pool.query("SELECT s.name AS sname, s.source_root, e.path, e.size, e.mtime, t.name AS tname, t.path AS tpath, t.sha256, t.bytes AS tbytes FROM entries e JOIN sets s ON s.id=e.set_id JOIN tars t ON t.id=e.tar_id WHERE s.name=? AND e.path=? AND BINARY e.path=BINARY ?", [set, path, path]);
  const h = (rows as Record<string, unknown>[])[0];
  if (!h) return page("Not found", `<div class="card">Not in the catalogue.</div>`);
  const disk = onDisk(String(h.tpath));
  const tape = await tapeVersions(String(h.tpath));
  const origAbs = `/${String(h.source_root).replace(/^\/+|\/+$/g, "")}/${String(h.path)}`.replace(/^\/\//, "/");
  const cli = `${cfg.cliName} catalog_restore ${shq(String(h.path))} --set ${shq(set)}\n# lands in ${destText(origAbs)} (default restore folder)\n# then: ${cfg.cliName} catalog_restore ${shq(String(h.path))} --set ${shq(set)} --yes --plan <planId>`;
  const mcp = `catalog_restore {"path": ${JSON.stringify(h.path)}, "set": ${JSON.stringify(set)}}   then   {"path": ..., "set": ..., "confirm": true, "planId": "<planId>"}`;
  return page(String(h.path), `<div class="card"><h1 class="path">${esc(h.path)}</h1><table>
<tr><th>Set</th><td>${esc(set)} <span class="mut">(source ${esc(h.source_root)})</span></td></tr>
<tr><th>Size</th><td>${human(Number(h.size))} (${esc(h.size)} bytes)</td></tr>
<tr><th>Modified</th><td>${esc(fmtTime(h.mtime))}</td></tr>
<tr><th>Tar</th><td>${esc(h.tname)} (${human(Number(h.tbytes))}) ${tarTag(disk)}<br><code class="path">${esc(h.tpath)}</code><br><span class="mut">sha256 <code>${esc(h.sha256)}</code></span></td></tr>
<tr><th>Tape</th><td>${tapeHtml(tape)}</td></tr></table></div>
<div class="card"><h2>Restore</h2><p>This page only reads. Restores are confirm-gated in the MCP server / CLI. ${disk ? "The tar is on disk, so the file is extracted from it." : "The tar is not on disk: the command restores it from tape first (a tape in the library is needed; see Tape above)."}</p>
<p class="mut">CLI (the first run only prints the plan: ${esc(planNote)}):</p><pre>${esc(cli)}</pre><p class="mut">MCP tool (first without <code>confirm</code>):</p><pre>${esc(mcp)}</pre>
${cfg.p5BaseUrl ? `<p><a href="${esc(cfg.p5BaseUrl)}" target="_blank" rel="noopener">Open the P5 web UI</a></p>` : ""}</div>`);
}

async function setsPage(): Promise<string> {
  const [rows] = await pool.query("SELECT s.name, s.status, COUNT(t.id) AS tars, COALESCE(SUM(t.files),0) AS files, COALESCE(SUM(t.bytes),0) AS bytes, s.source_root, s.created FROM sets s LEFT JOIN tars t ON t.set_id=s.id GROUP BY s.id ORDER BY s.name");
  const sets = rows as Record<string, unknown>[];
  return page("Sets", `<div class="card"><h1>Sets</h1>${sets.length === 0 ? `<p class="mut">No sets.</p>` : `<table><tr><th>Set</th><th>Status</th><th class="n">Tars</th><th class="n">Files</th><th class="n">Size</th><th class="h">Source</th><th class="h">Created</th></tr>${sets.map((s) => `<tr><td><a href="set?set=${encodeURIComponent(String(s.name))}">${esc(s.name)}</a></td><td>${esc(s.status)}</td><td class="n">${esc(s.tars)}</td><td class="n">${esc(s.files)}</td><td class="n">${human(Number(s.bytes))}</td><td class="h path">${esc(s.source_root)}</td><td class="h">${esc(fmtTime(s.created))}</td></tr>`).join("")}</table>`}</div>`);
}

async function browsePage(u: URL): Promise<string> {
  const set = u.searchParams.get("set") ?? "";
  const dir = (u.searchParams.get("dir") ?? "").replace(/^\/+|\/+$/g, "");
  const [sr] = await pool.query("SELECT id, source_root FROM sets WHERE name=?", [set]);
  const s = (sr as { id: number; source_root: string }[])[0];
  if (!s) return page("Not found", `<div class="card">No such set.</div>`);
  const prefix = dir ? `${dir}/` : "";
  const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const [rows] = await pool.query("SELECT SUBSTRING_INDEX(SUBSTR(path, ?), '/', 1) AS name, LOCATE('/', SUBSTR(path, ?)) > 0 AS isdir, COUNT(*) AS files, SUM(size) AS bytes FROM entries WHERE set_id=? AND path LIKE ? GROUP BY name, isdir ORDER BY isdir DESC, name LIMIT 1000", [prefix.length + 1, prefix.length + 1, s.id, like]);
  const kids = rows as { name: string; isdir: number; files: number; bytes: number }[];
  const [fr] = await pool.query("SELECT e.path, e.size, e.mtime, t.name AS tname, t.path AS tpath FROM entries e JOIN tars t ON t.id=e.tar_id WHERE e.set_id=? AND e.path LIKE ? AND LOCATE('/', SUBSTR(e.path, ?)) = 0 ORDER BY e.path LIMIT 500", [s.id, like, prefix.length + 1]);
  const files = fr as { path: string; size: number; mtime: Date | null; tname: string; tpath: string }[];
  const crumbs = [`<a href="browse?set=${encodeURIComponent(set)}">${esc(set)}</a>`];
  let acc = "";
  for (const part of dir ? dir.split("/") : []) {
    acc = acc ? `${acc}/${part}` : part;
    crumbs.push(`<a href="browse?set=${encodeURIComponent(set)}&dir=${encodeURIComponent(acc)}">${esc(part)}</a>`);
  }
  const dirs = kids.filter((k) => k.isdir);
  const diskCache = new Map<string, boolean>();
  const disk = (p: string) => (diskCache.has(p) ? diskCache.get(p)! : (diskCache.set(p, onDisk(p)), diskCache.get(p)!));
  return page(set, `<div class="card"><h1>${crumbs.join(" / ")}</h1><p class="mut">Source ${esc(s.source_root)}</p><table><tr><th>Name</th><th class="n">Files</th><th class="n">Size</th><th class="h">Modified</th><th>Tar</th></tr>${
    dir ? `<tr><td colspan="5"><a href="browse?set=${encodeURIComponent(set)}&dir=${encodeURIComponent(dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "")}">..</a></td></tr>` : ""
  }${dirs.map((k) => `<tr><td><a href="browse?set=${encodeURIComponent(set)}&dir=${encodeURIComponent(prefix + k.name)}">${esc(k.name)}/</a></td><td class="n">${esc(k.files)}</td><td class="n">${human(Number(k.bytes))}</td><td class="h"></td><td></td></tr>`).join("")}${files
    .map((f) => `<tr><td class="path"><a href="${hitUrl(set, f.path)}">${esc(f.path.slice(prefix.length))}</a></td><td class="n">1</td><td class="n">${human(Number(f.size))}</td><td class="h">${esc(fmtTime(f.mtime))}</td><td>${esc(f.tname)} ${tarTag(disk(f.tpath))}</td></tr>`)
    .join("")}</table>${files.length === 500 ? `<p class="mut">First 500 files shown.</p>` : ""}</div>`);
}

// ---------------------------------------------------------------- server

function send(res: ServerResponse, code: number, body: string, headers: Record<string, string> = {}) {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "referrer-policy": "no-referrer", ...headers });
  res.end(body);
}

createServer(async (req, res) => {
  try {
    const u = new URL(req.url ?? "/", "http://x");
    const route = u.pathname;
    if (route === "/login") {
      if (req.method === "POST") {
        const f = await readForm(req);
        const next = safeNext(f.get("next"));
        if (verifyLogin(f.get("username") ?? "", f.get("password") ?? "")) {
          return send(res, 303, "", { location: next, "set-cookie": `${COOKIE}=${makeSession()}; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}` });
        }
        await new Promise((r) => setTimeout(r, 1000));
        return send(res, 401, loginPage(next, "Wrong user or password"));
      }
      if (req.method === "GET" || req.method === "HEAD") return send(res, 200, loginPage(safeNext(u.searchParams.get("next"))));
      return send(res, 405, page("Method", "<div class=card>Not allowed.</div>", false), { allow: "GET, HEAD, POST" });
    }
    if (route === "/logout") return send(res, 303, "", { location: "login", "set-cookie": `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
    if (!hasSession(req)) return send(res, 303, "", { location: `login?next=${encodeURIComponent(safeNext(u.pathname.slice(1) + u.search))}` });
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, page("Method", "<div class=card>Read-only.</div>"), { allow: "GET, HEAD" });
    if (route === "/") return send(res, 200, await searchPage(u));
    if (route === "/hit") return send(res, 200, await hitPage(u));
    if (route === "/sets") return send(res, 200, await setsPage());
    if (route === "/set" || route === "/browse") return send(res, 200, await browsePage(u));
    return send(res, 404, page("Not found", "<div class=card>Not found.</div>"));
  } catch (e) {
    console.error(e);
    send(res, 500, page("Error", `<div class="card"><span class="tag bad">error</span> ${esc((e as Error).message)}</div>`));
  }
}).listen(cfg.listen, () => console.log(`catalogue web on :${cfg.listen}`));
