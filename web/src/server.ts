/**
 * Read-only web page for the archiware-mcp tar catalogue.
 * Data: MySQL (SELECT only, user catalog_ro), P5 REST (volume label/barcode/location),
 * P5's backup index (SQLite, mounted read-only). Nothing is written, nothing is restored here:
 * restores stay confirm-gated in the MCP/CLI; the detail view shows the command.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { timingSafeEqual, scryptSync } from "node:crypto";
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
  packRootMount: string;
  packRootP5: string;
  mailSlots: number[];
  cliName: string;
}
interface Secrets {
  mysql: { user: string; password: string };
  p5: { user: string; password: string };
  auth: { user: string; hash: string };
}

const cfg: Config = { listen: 8080, p5Client: "localhost", indexDir: "/p5index", mysqlPort: 3306, mysqlDatabase: "archive_catalog", packRootMount: "/packroot", packRootP5: "", mailSlots: [], cliName: "archiware", p5BaseUrl: "", p5RestUrl: "", mysqlHost: "", packRoot: "", ...JSON.parse(readFileSync(process.env.CONFIG_FILE ?? "/config/config.json", "utf8")) };
const secrets: Secrets = JSON.parse(readFileSync(process.env.SECRETS_FILE ?? "/secrets/secrets.json", "utf8"));

const pool = mysql.createPool({ host: cfg.mysqlHost, port: cfg.mysqlPort, user: secrets.mysql.user, password: secrets.mysql.password, database: cfg.mysqlDatabase, connectionLimit: 4, charset: "utf8mb4" });

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

function checkAuth(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? "";
  if (!h.startsWith("Basic ")) return false;
  const [user, ...rest] = Buffer.from(h.slice(6), "base64").toString("utf8").split(":");
  const pw = rest.join(":");
  const parts = secrets.auth.hash.split("$");
  if (parts[0] !== "scrypt" || parts.length !== 4) return false;
  const want = Buffer.from(parts[3], "hex");
  const got = scryptSync(pw, Buffer.from(parts[2], "hex"), want.length, { N: Number(parts[1]) });
  const userOk = user.length === secrets.auth.user.length && timingSafeEqual(Buffer.from(user), Buffer.from(secrets.auth.user));
  return timingSafeEqual(got, want) && userOk;
}

// ---------------------------------------------------------------- P5 REST (volumes)

interface Vol {
  id: string;
  label: string;
  barcode: string;
  online: boolean;
  location: string;
}
let volCache: { at: number; vols: Map<string, Vol> } | null = null;

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

async function volumes(): Promise<Map<string, Vol>> {
  if (volCache && Date.now() - volCache.at < 120_000) return volCache.vols;
  const list = (await p5Get("general/volumes")) as { volumes?: { ID: string }[] };
  const vols = new Map<string, Vol>();
  for (const { ID } of list.volumes ?? []) {
    const d = (await p5Get(`general/volumes/${ID}`)) as Record<string, unknown>;
    vols.set(ID, { id: ID, label: String(d.label ?? ""), barcode: String(d.barcode ?? ""), online: d.isonline === true, location: String(d.location ?? "") });
  }
  volCache = { at: Date.now(), vols };
  return vols;
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

async function tapeVersions(tarHostPath: string): Promise<{ versions: TapeVersion[]; error?: string }> {
  const p5Path = cfg.packRootP5 && tarHostPath.startsWith(`${cfg.packRoot}/`) ? cfg.packRootP5 + tarHostPath.slice(cfg.packRoot.length) : tarHostPath;
  try {
    const filesDb = `${cfg.indexDir}/bsx_${cfg.p5Client}/files.db`;
    const addrDb = `${cfg.indexDir}/bsx_${cfg.p5Client}/addrs.db`;
    if (!existsSync(filesDb)) return { versions: [], error: "P5 backup index not mounted" };
    const f = new DatabaseSync(`file:${filesDb}?immutable=1`, { readOnly: true });
    let rows: { id: number; btime: number; level: number | null }[];
    try {
      rows = f.prepare(`select e.id as id, e.btime as btime, s.level as level from elements e left join snapshots s on s.btime=e.btime where e.eid in (${pathEidSql(p5Path)}) order by e.btime desc limit 20`).all() as never;
    } finally {
      f.close();
    }
    if (rows.length === 0) return { versions: [] };
    const a = new DatabaseSync(`file:${addrDb}?immutable=1`, { readOnly: true });
    const vols = await volumes();
    try {
      const out: TapeVersion[] = [];
      const seen = new Set<number>();
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        const ids = (a.prepare("select distinct volid from addresses where id=? and etime=2147483647").all(r.id) as { volid: number | string }[]).map((x) => String(x.volid));
        out.push({ date: stamp(r.btime), level: r.level === null ? "" : r.level === 1 ? "full" : "incremental", volumes: ids.map((id) => ({ label: vols.get(id)?.label ?? id, barcode: vols.get(id)?.barcode ?? "", where: whereText(vols.get(id)) })) });
      }
      return { versions: out };
    } finally {
      a.close();
    }
  } catch (e) {
    return { versions: [], error: (e as Error).message };
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
table{border-collapse:collapse;width:100%}th{background:var(--blue2);text-align:left;font-weight:600}th,td{padding:.4rem .55rem;border-bottom:1px solid var(--line);vertical-align:top}
td.n,th.n{text-align:right;white-space:nowrap}a{color:var(--blue)}code,pre{font:13px/1.4 ui-monospace,Menlo,Consolas,monospace}
pre{background:#263238;color:#eceff1;padding:.7rem;border-radius:4px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
.tag{display:inline-block;padding:0 .45rem;border-radius:9px;font-size:.8rem;border:1px solid}.ok{color:var(--ok);border-color:var(--ok)}.warn{color:var(--warn);border-color:var(--warn)}.bad{color:var(--bad);border-color:var(--bad)}
.mut{color:var(--mut)}h1{font-size:1.2rem;margin:.2rem 0 .6rem}h2{font-size:1.05rem;margin:.2rem 0 .5rem}.path{word-break:break-all}
@media(max-width:640px){th.h,td.h{display:none}body{font-size:14px}}`;

function page(title: string, body: string): string {
  const p5 = cfg.p5BaseUrl ? `<a href="${esc(cfg.p5BaseUrl)}" target="_blank" rel="noopener">P5 web UI</a>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} - Catalogue</title><style>${CSS}</style></head><body><header><b>Archive catalogue</b><a href="/">Search</a><a href="/sets">Sets</a><span class="sp"></span>${p5}</header><main>${body}</main></body></html>`;
}

const tarTag = (d: boolean) => (d ? `<span class="tag ok">tar on disk</span>` : `<span class="tag warn">tar not on disk</span>`);
const hitUrl = (set: string, path: string) => `/hit?set=${encodeURIComponent(set)}&path=${encodeURIComponent(path)}`;

function tapeHtml(t: { versions: TapeVersion[]; error?: string }): string {
  if (t.error) return `<span class="tag bad">tape lookup failed</span> <span class="mut">${esc(t.error)}</span>`;
  if (t.versions.length === 0) return `<span class="tag warn">not on tape</span>`;
  return t.versions
    .map((v) => `<div><span class="mut">${esc(v.date)} ${esc(v.level)}</span> ${v.volumes.map((x) => `${esc(x.label)} <code>${esc(x.barcode)}</code> <span class="tag ${/slot|drive/.test(x.where) && !/not in/.test(x.where) ? "ok" : "warn"}">${esc(x.where)}</span>`).join(" &middot; ")}</div>`)
    .join("");
}

// ---------------------------------------------------------------- routes

async function searchPage(u: URL): Promise<string> {
  const pattern = (u.searchParams.get("q") ?? "").trim();
  const set = u.searchParams.get("set") ?? "";
  const [sets] = await pool.query("SELECT name FROM sets ORDER BY name");
  const opts = (sets as { name: string }[]).map((s) => `<option${s.name === set ? " selected" : ""}>${esc(s.name)}</option>`).join("");
  let result = "";
  if (pattern) {
    const { column, like } = likeFor(pattern);
    const limit = 100;
    const [rows] = await pool.query(`SELECT s.name AS sname, e.path, e.size, e.mtime, t.name AS tname, t.path AS tpath FROM entries e JOIN sets s ON s.id=e.set_id JOIN tars t ON t.id=e.tar_id WHERE e.${column} LIKE ?${set ? " AND s.name=?" : ""} ORDER BY s.name, e.path LIMIT ${limit}`, set ? [like, set] : [like]);
    const hits = rows as { sname: string; path: string; size: number; mtime: Date | null; tname: string; tpath: string }[];
    const tars = [...new Set(hits.map((h) => h.tpath))];
    const tape = new Map<string, Awaited<ReturnType<typeof tapeVersions>>>();
    for (const tp of tars.slice(0, 40)) tape.set(tp, await tapeVersions(tp));
    result = `<div class="card"><h2>${hits.length}${hits.length === limit ? "+" : ""} result(s)</h2>${
      hits.length === 0
        ? `<p class="mut">Nothing found.</p>`
        : `<table><tr><th>Set</th><th>Path</th><th class="n">Size</th><th class="h">Modified</th><th>Tar</th><th>Tape</th></tr>${hits
            .map((h) => `<tr><td>${esc(h.sname)}</td><td class="path"><a href="${hitUrl(h.sname, h.path)}">${esc(h.path)}</a></td><td class="n">${human(Number(h.size))}</td><td class="h">${esc(fmtTime(h.mtime))}</td><td>${esc(h.tname)}<br>${tarTag(onDisk(h.tpath))}</td><td>${tape.has(h.tpath) ? tapeHtml(tape.get(h.tpath)!) : '<span class="mut">(open the file)</span>'}</td></tr>`)
            .join("")}</table>`
    }</div>`;
  }
  return page("Search", `<div class="card"><form class="s" method="get" action="/"><input type="text" name="q" value="${esc(pattern)}" placeholder="file name, part of a path, or a glob like *.pdf" autofocus><select name="set"><option value="">all sets</option>${opts}</select><button>Search</button></form><p class="mut" style="margin:.5rem 0 0">Substring, or glob with <code>*</code> and <code>?</code>. A pattern with a <code>/</code> matches the whole path.</p></div>${result}`);
}

async function hitPage(u: URL): Promise<string> {
  const set = u.searchParams.get("set") ?? "";
  const path = u.searchParams.get("path") ?? "";
  const [rows] = await pool.query("SELECT s.name AS sname, s.source_root, e.path, e.size, e.mtime, t.name AS tname, t.path AS tpath, t.sha256, t.bytes AS tbytes FROM entries e JOIN sets s ON s.id=e.set_id JOIN tars t ON t.id=e.tar_id WHERE s.name=? AND e.path=? AND BINARY e.path=BINARY ?", [set, path, path]);
  const h = (rows as Record<string, unknown>[])[0];
  if (!h) return page("Not found", `<div class="card">Not in the catalogue.</div>`);
  const disk = onDisk(String(h.tpath));
  const tape = await tapeVersions(String(h.tpath));
  const cli = `${cfg.cliName} catalog_restore ${shq(String(h.path))} --set ${shq(set)} --to ${shq("/path/on/the/p5/host")} --yes`;
  const mcp = `catalog_restore {"path": ${JSON.stringify(h.path)}, "set": ${JSON.stringify(set)}, "to": "/path/on/the/p5/host", "confirm": true}`;
  return page(String(h.path), `<div class="card"><h1 class="path">${esc(h.path)}</h1><table>
<tr><th>Set</th><td>${esc(set)} <span class="mut">(source ${esc(h.source_root)})</span></td></tr>
<tr><th>Size</th><td>${human(Number(h.size))} (${esc(h.size)} bytes)</td></tr>
<tr><th>Modified</th><td>${esc(fmtTime(h.mtime))}</td></tr>
<tr><th>Tar</th><td>${esc(h.tname)} (${human(Number(h.tbytes))}) ${tarTag(disk)}<br><code class="path">${esc(h.tpath)}</code><br><span class="mut">sha256 <code>${esc(h.sha256)}</code></span></td></tr>
<tr><th>Tape</th><td>${tapeHtml(tape)}</td></tr></table></div>
<div class="card"><h2>Restore</h2><p>This page only reads. Restores are confirm-gated in the MCP server / CLI. ${disk ? "The tar is on disk, so the file is extracted from it." : "The tar is not on disk: the command restores it from tape first (a tape in the library is needed; see Tape above)."}</p>
<p class="mut">CLI (run without <code>--yes</code> first to see the plan):</p><pre>${esc(cli)}</pre><p class="mut">MCP tool (first without <code>confirm</code>):</p><pre>${esc(mcp)}</pre>
${cfg.p5BaseUrl ? `<p><a href="${esc(cfg.p5BaseUrl)}" target="_blank" rel="noopener">Open the P5 web UI</a></p>` : ""}</div>`);
}

async function setsPage(): Promise<string> {
  const [rows] = await pool.query("SELECT s.name, s.status, COUNT(t.id) AS tars, COALESCE(SUM(t.files),0) AS files, COALESCE(SUM(t.bytes),0) AS bytes, s.source_root, s.created FROM sets s LEFT JOIN tars t ON t.set_id=s.id GROUP BY s.id ORDER BY s.name");
  const sets = rows as Record<string, unknown>[];
  return page("Sets", `<div class="card"><h1>Sets</h1>${sets.length === 0 ? `<p class="mut">No sets.</p>` : `<table><tr><th>Set</th><th>Status</th><th class="n">Tars</th><th class="n">Files</th><th class="n">Size</th><th class="h">Source</th><th class="h">Created</th></tr>${sets.map((s) => `<tr><td><a href="/set?set=${encodeURIComponent(String(s.name))}">${esc(s.name)}</a></td><td>${esc(s.status)}</td><td class="n">${esc(s.tars)}</td><td class="n">${esc(s.files)}</td><td class="n">${human(Number(s.bytes))}</td><td class="h path">${esc(s.source_root)}</td><td class="h">${esc(fmtTime(s.created))}</td></tr>`).join("")}</table>`}</div>`);
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
  const crumbs = [`<a href="/browse?set=${encodeURIComponent(set)}">${esc(set)}</a>`];
  let acc = "";
  for (const part of dir ? dir.split("/") : []) {
    acc = acc ? `${acc}/${part}` : part;
    crumbs.push(`<a href="/browse?set=${encodeURIComponent(set)}&dir=${encodeURIComponent(acc)}">${esc(part)}</a>`);
  }
  const dirs = kids.filter((k) => k.isdir);
  const diskCache = new Map<string, boolean>();
  const disk = (p: string) => (diskCache.has(p) ? diskCache.get(p)! : (diskCache.set(p, onDisk(p)), diskCache.get(p)!));
  return page(set, `<div class="card"><h1>${crumbs.join(" / ")}</h1><p class="mut">Source ${esc(s.source_root)}</p><table><tr><th>Name</th><th class="n">Files</th><th class="n">Size</th><th class="h">Modified</th><th>Tar</th></tr>${
    dir ? `<tr><td colspan="5"><a href="/browse?set=${encodeURIComponent(set)}&dir=${encodeURIComponent(dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "")}">..</a></td></tr>` : ""
  }${dirs.map((k) => `<tr><td><a href="/browse?set=${encodeURIComponent(set)}&dir=${encodeURIComponent(prefix + k.name)}">${esc(k.name)}/</a></td><td class="n">${esc(k.files)}</td><td class="n">${human(Number(k.bytes))}</td><td class="h"></td><td></td></tr>`).join("")}${files
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
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, page("Method", "<div class=card>Read-only.</div>"), { allow: "GET, HEAD" });
    if (!checkAuth(req)) return send(res, 401, page("Login", "<div class=card>Authentication required.</div>"), { "www-authenticate": 'Basic realm="Catalogue", charset="UTF-8"' });
    const u = new URL(req.url ?? "/", "http://x");
    const route = u.pathname;
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
