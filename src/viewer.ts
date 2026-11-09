/**
 * The catalogue viewer as an optional, self-contained part of the MCP: a compose
 * project (web page "catalog", its own MariaDB "catalog-db", nightly dump
 * "catalog-dump") deployed from web/ to a docker host over ssh.
 *
 *   viewer_deploy    plan without confirm; with confirm: generate secrets, copy web/, compose up, wait for health,
 *                    catalog_init against the new database, point the MCP config at it
 *   viewer_status    containers, health, database size, last dump, cache entries
 *   catalog_migrate  copy archive_catalog from an existing MySQL into catalog-db (plan without confirm)
 *
 * Secrets are generated here and written to <dir>/secrets on the host with mode 600 through stdin; they never
 * appear on a command line. The viewer password is returned once by a confirmed deploy.
 */

import { randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { catalogInit, runRemote, sql } from "./catalog.js";
import { configPath, readConfigFile, type ArchiwareConfig } from "./config.js";
import { configDir } from "./p5db.js";
import { readPassword } from "./rest.js";
import { launch, P5Error, shellQuote } from "./transport.js";

const DEFAULT_DIR = "/opt/catalog-viewer";
const NAME_RE = /^[A-Za-z0-9._-]+$/;
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const ABS_RE = /^\/[^\0\n']*$/;

export interface DeployOptions {
  host?: string;
  dir?: string;
  dataDir?: string;
  network?: string;
  catalogIp?: string;
  dbIp?: string;
  p5Index?: string;
  packRoot?: string;
  subpath?: string;
  viewerUser?: string;
  p5BaseUrl?: string;
  tz?: string;
  confirm: boolean;
}

/** Docker host of the viewer: explicit, else the configured one, else the P5 host ("" = this machine in local mode). */
export function viewerHost(cfg: ArchiwareConfig, host?: string): string {
  return host ?? (cfg.viewerHost || (cfg.mode === "local" ? "" : cfg.sshHost));
}

/** A config that runs host commands on the viewer's docker host. */
function onHost(cfg: ArchiwareConfig, host: string): ArchiwareConfig {
  return { ...cfg, mode: host ? "ssh" : "local", sshHost: host };
}

/** A config whose catalogue SQL goes to the viewer's catalog-db (client credentials: <dir>/secrets/catalog.cnf). */
function viewerSqlCfg(cfg: ArchiwareConfig, host: string, dir: string): ArchiwareConfig {
  return { ...onHost(cfg, host), catalogMysqlContainer: "catalog-db", catalogDbCnf: `${dir}/secrets/catalog.cnf` };
}

/** Where web/ lives: next to dist/ in the package and in the clone. */
export function webSourceDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "web");
}

/** scrypt hash in the format web/src/hashpw.ts prints and the web page verifies. */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const N = 16384;
  return `scrypt$${N}$${salt.toString("hex")}$${scryptSync(pw, salt, 32, { N }).toString("hex")}`;
}

const hex = (n: number) => randomBytes(n).toString("hex");

/** Apache snippet for a reverse-proxy sub-path (informational; placeholder host). */
export function apacheSnippet(subpath: string, catalogIp: string): string {
  const p = `/${subpath.replace(/^\/+|\/+$/g, "")}`;
  return [
    `# inside the <VirtualHost *:443> of https://www.example.org`,
    `ProxyPass ${p}/ http://${catalogIp}:8080/`,
    `ProxyPassReverse ${p}/ http://${catalogIp}:8080/`,
    `# ${p} without the slash must not reach a catch-all proxy rule: send it to the slash form`,
    `ProxyPass ${p} !`,
    `RedirectMatch ^${p}$ https://www.example.org${p}/`,
  ].join("\n");
}

interface Resolved {
  host: string;
  dir: string;
  dataDir: string;
  network: string;
  catalogIp: string;
  dbIp: string;
  p5Index: string;
  packRoot: string;
  subpath: string;
  viewerUser: string;
  p5BaseUrl: string;
  tz: string;
}

function resolveDeploy(cfg: ArchiwareConfig, o: DeployOptions): Resolved {
  const dir = (o.dir ?? (cfg.viewerDir || DEFAULT_DIR)).replace(/\/+$/, "");
  let p5Index = o.p5Index ?? "";
  if (!p5Index) {
    try {
      p5Index = `${configDir(cfg)}/index/backup`;
    } catch {
      p5Index = "";
    }
  }
  const r: Resolved = {
    host: viewerHost(cfg, o.host),
    dir,
    dataDir: (o.dataDir ?? `${dir}/data/db`).replace(/\/+$/, ""),
    network: o.network ?? "",
    catalogIp: o.catalogIp ?? "",
    dbIp: o.dbIp ?? "",
    p5Index,
    packRoot: (o.packRoot ?? cfg.packRoot).replace(/\/+$/, ""),
    subpath: o.subpath ?? "",
    viewerUser: o.viewerUser ?? "viewer",
    p5BaseUrl: o.p5BaseUrl ?? "",
    tz: o.tz ?? "UTC",
  };
  const missing: string[] = [];
  if (!r.network) missing.push("--network");
  if (!r.catalogIp) missing.push("--catalog-ip");
  if (!r.dbIp) missing.push("--db-ip");
  if (!r.p5Index) missing.push("--p5-index");
  if (missing.length) throw new P5Error(`viewer_deploy needs ${missing.join(", ")} (docker network name, free addresses on it for the web page and the database, P5 backup index dir on the docker host)`);
  if (!NAME_RE.test(r.network)) throw new P5Error(`invalid docker network name "${r.network}"`);
  for (const [k, v] of [["--catalog-ip", r.catalogIp], ["--db-ip", r.dbIp]] as const) if (!IP_RE.test(v)) throw new P5Error(`${k} must be an IPv4 address, got "${v}"`);
  if (r.catalogIp === r.dbIp) throw new P5Error("--catalog-ip and --db-ip must differ");
  for (const [k, v] of [["--dir", r.dir], ["--data-dir", r.dataDir], ["--p5-index", r.p5Index], ["--pack-root", r.packRoot]] as const) if (!ABS_RE.test(v)) throw new P5Error(`${k} must be an absolute path without quotes, got "${v}"`);
  if (!NAME_RE.test(r.viewerUser)) throw new P5Error(`invalid viewer user name "${r.viewerUser}" (letters, digits, . _ -)`);
  if (!/^[A-Za-z0-9_/+-]+$/.test(r.tz)) throw new P5Error(`invalid time zone "${r.tz}"`);
  return r;
}

const sameHostAsP5 = (cfg: ArchiwareConfig, host: string): boolean => (cfg.mode === "local" ? host === "" : host === cfg.sshHost);

// ---------------------------------------------------------------------------
// deploy
// ---------------------------------------------------------------------------

/** Copy web/ (without secrets, state and build output) to <dir> on the host: tar | ssh tar. */
function copyWeb(cfg: ArchiwareConfig, dir: string): Promise<void> {
  const src = webSourceDir();
  const l = launch(cfg, `mkdir -p ${shellQuote(dir)} && tar --no-same-owner -C ${shellQuote(dir)} -xf -`);
  return new Promise((resolve, reject) => {
    const excl = ["node_modules", "dist", "secrets", "data", "dumps", ".env", "config/config.json"].flatMap((x) => ["--exclude", `./${x}`]);
    const t = spawn("tar", ["-C", src, ...excl, "-cf", "-", "."], { stdio: ["ignore", "pipe", "pipe"] });
    const r = spawn(l.cmd, l.args, { stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    t.stderr.on("data", (d: Buffer) => (err += d));
    r.stderr.on("data", (d: Buffer) => (err += d));
    t.stdout.pipe(r.stdin);
    t.on("error", reject);
    r.on("error", reject);
    r.on("close", (rc) => (rc === 0 ? resolve() : reject(new P5Error(`copying web/ to ${dir} failed: ${err.trim().split("\n")[0]}`))));
  });
}

const DB_FILES = ["db_root_password", "db_catalog_password", "db_catalog_ro_password", "catalog.cnf"] as const;

export interface SecretsState {
  /** db_* files already present */
  haveFiles: string[];
  /** parsed existing secrets.json (null = absent or unreadable) */
  secrets: Record<string, unknown> | null;
  /** parsed existing config/config.json */
  config: Record<string, unknown> | null;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** What an install dir already holds: db_* files, secrets.json, config/config.json (read on the host). */
export async function inspectInstall(h: ArchiwareConfig, dir: string): Promise<SecretsState> {
  const q = (f: string) => shellQuote(`${dir}/${f}`);
  const probe = await runRemote(h, DB_FILES.map((f) => `[ -f ${q(`secrets/${f}`)} ] && echo have:${f}`).join("; ") + "; true");
  const haveFiles = probe.stdout.split("\n").filter((l) => l.startsWith("have:")).map((l) => l.slice(5).trim());
  const rd = async (f: string) => {
    const x = await runRemote(h, `cat ${q(f)} 2>/dev/null`);
    return x.rc === 0 && x.stdout.trim() ? parseObject(x.stdout) : null;
  };
  return { haveFiles, secrets: await rd("secrets/secrets.json"), config: await rd("config/config.json") };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const authOk = (v: unknown) => isObj(v) && typeof v.user === "string" && typeof v.hash === "string" && v.hash !== "";

/** Which secrets an existing install lets us keep, which must be generated. */
export function secretsPlan(st: SecretsState): { kept: string[]; generated: string[] } {
  const kept: string[] = [];
  const generated: string[] = [];
  for (const f of DB_FILES) (st.haveFiles.includes(f) ? kept : generated).push(f);
  (authOk(st.secrets?.auth) ? kept : generated).push("viewer login (auth)");
  (typeof st.secrets?.sessionSecret === "string" && st.secrets.sessionSecret ? kept : generated).push("sessionSecret");
  return { kept, generated };
}

/** Create missing secrets, keep the rest. Returns the viewer password only if a new login was generated. */
export async function provisionSecrets(h: ArchiwareConfig, dir: string, viewerUser: string, cfg: ArchiwareConfig, restPw: string, st: SecretsState): Promise<{ viewerPassword: string | null; kept: string[]; generated: string[] }> {
  const plan = secretsPlan(st);
  const mk = await runRemote(h, `umask 077; mkdir -p ${shellQuote(`${dir}/config`)} ${shellQuote(`${dir}/dumps`)} && { [ -d ${shellQuote(`${dir}/secrets`)} ] || mkdir -m 700 ${shellQuote(`${dir}/secrets`)}; }`);
  if (mk.rc !== 0) throw new P5Error(`cannot create ${dir}/secrets: ${mk.stderr}`);
  const have = (f: string) => st.haveFiles.includes(f);
  const readTrim = async (f: string) => (await runRemote(h, `cat ${shellQuote(`${dir}/secrets/${f}`)}`)).stdout.trim();
  // The catalog passwords are needed for catalog.cnf and secrets.json even when only some files exist.
  const dbCatalog = have("db_catalog_password") ? await readTrim("db_catalog_password") : hex(24);
  const dbRo = have("db_catalog_ro_password") ? await readTrim("db_catalog_ro_password") : hex(24);
  if (!have("db_root_password")) await put(h, `${dir}/secrets/db_root_password`, `${hex(24)}\n`);
  if (!have("db_catalog_password")) await put(h, `${dir}/secrets/db_catalog_password`, `${dbCatalog}\n`);
  if (!have("db_catalog_ro_password")) await put(h, `${dir}/secrets/db_catalog_ro_password`, `${dbRo}\n`);
  if (!have("catalog.cnf")) await put(h, `${dir}/secrets/catalog.cnf`, `[client]\nuser=catalog\npassword=${dbCatalog}\n`);
  let viewerPassword: string | null = null;
  const next: Record<string, unknown> = { ...(st.secrets ?? {}) };
  if (!authOk(next.auth)) {
    viewerPassword = randomBytes(12).toString("base64url");
    next.auth = { user: viewerUser, hash: hashPassword(viewerPassword) };
  }
  if (!(typeof next.sessionSecret === "string" && next.sessionSecret)) next.sessionSecret = hex(32);
  next.mysql = { user: "catalog_ro", password: dbRo };
  next.p5 = { user: cfg.restUser, password: restPw };
  const text = JSON.stringify(next, null, 2) + "\n";
  // rewrite only when something changed (keeps an untouched install byte-identical)
  if (!st.secrets || JSON.stringify(st.secrets) !== JSON.stringify(next)) await put(h, `${dir}/secrets/secrets.json`, text);
  return { viewerPassword, ...plan };
}

/** Idempotent SQL run as root inside catalog-db: reads /secrets there, so file ownership on the host does not matter. */
const USERS_SCRIPT = String.raw`set -e
R=$(cat /secrets/db_root_password); C=$(cat /secrets/db_catalog_password); O=$(cat /secrets/db_catalog_ro_password)
case "$C$O" in ""|*[!A-Za-z0-9_-]*) echo "db_catalog_password / db_catalog_ro_password must be non-empty and only [A-Za-z0-9_-]" >&2; exit 3;; esac
mariadb --protocol=socket -uroot -p"$R" <<SQL
CREATE DATABASE IF NOT EXISTS archive_catalog CHARACTER SET utf8mb4;
CREATE TABLE IF NOT EXISTS archive_catalog.p5_cache (
  k VARCHAR(255) NOT NULL PRIMARY KEY,
  v LONGTEXT NULL,
  fetched_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE USER IF NOT EXISTS 'catalog'@'%' IDENTIFIED BY '$C';
ALTER USER 'catalog'@'%' IDENTIFIED BY '$C';
GRANT ALL PRIVILEGES ON archive_catalog.* TO 'catalog'@'%';
CREATE USER IF NOT EXISTS 'catalog_ro'@'%' IDENTIFIED BY '$O';
ALTER USER 'catalog_ro'@'%' IDENTIFIED BY '$O';
GRANT SELECT ON archive_catalog.* TO 'catalog_ro'@'%';
GRANT INSERT, UPDATE ON archive_catalog.p5_cache TO 'catalog_ro'@'%';
FLUSH PRIVILEGES;
SQL
`;

/** Create/update the database users in a running catalog-db and verify the catalog.cnf login. */
export async function ensureDbUsers(h: ArchiwareConfig, container = "catalog-db"): Promise<void> {
  const c = shellQuote(container);
  const mk = await runRemote(h, `docker exec -i ${c} sh -s`, { input: USERS_SCRIPT });
  if (mk.rc !== 0) throw new P5Error(`creating the database users in ${container} failed: ${(mk.stderr || mk.stdout).trim().split("\n")[0]}`);
  const chk = await runRemote(h, `docker exec ${c} mariadb --defaults-extra-file=/secrets/catalog.cnf -h 127.0.0.1 -N -B -e 'select current_user()'`);
  if (chk.rc !== 0 || !chk.stdout.trim().startsWith("catalog@")) throw new P5Error(`database user "catalog" cannot log in to ${container} with secrets/catalog.cnf: ${(chk.stderr || chk.stdout).trim().split("\n")[0]}`);
}

async function put(cfg: ArchiwareConfig, path: string, content: string, mode = "600"): Promise<void> {
  const r = await runRemote(cfg, `umask 077; cat > ${shellQuote(path)} && chmod ${mode} ${shellQuote(path)}`, { input: content });
  if (r.rc !== 0) throw new P5Error(`cannot write ${path}: ${r.stderr}`);
}

export async function viewerDeploy(cfg: ArchiwareConfig, o: DeployOptions) {
  const r = resolveDeploy(cfg, o);
  const rewire = sameHostAsP5(cfg, r.host);
  const hostName = r.host || "(this machine)";
  let planSecrets = "unknown (host not reachable for the check)";
  try {
    const sp = secretsPlan(await inspectInstall(onHost(cfg, r.host), r.dir));
    planSecrets = `kept: ${sp.kept.join(", ") || "none"}; generated: ${sp.generated.join(", ") || "none"}`;
  } catch { /* plan stays informational */ }
  const plan = {
    host: hostName,
    installDir: r.dir,
    dataDir: r.dataDir,
    dumpsDir: `${r.dir}/dumps`,
    dockerNetwork: r.network,
    addresses: { catalog: `${r.catalogIp}:8080`, "catalog-db": `${r.dbIp}:3306` },
    mounts: { "P5 backup index (read-only)": r.p5Index, "pack root (read-only)": r.packRoot },
    steps: [
      `copy web/ to ${hostName}:${r.dir} (compose file, Dockerfile, sources, dump.sh; never touches secrets/)`,
      `generate random passwords for the database root, catalog (read/write, used by the MCP) and catalog_ro (SELECT + cache table, used by the web page), the viewer login (user ${r.viewerUser}, scrypt hash) and the session secret; write them to ${r.dir}/secrets (mode 600); existing secrets are kept, only missing ones are generated: ${planSecrets}`,
      `write ${r.dir}/.env and ${r.dir}/config/config.json (keys of an existing config.json that viewer_deploy does not own are kept; P5 REST ${cfg.restUrl || "?"}, mysqlHost ${r.dbIp}, packRoot ${r.packRoot})`,
      `cd ${r.dir} && docker compose up -d --build   (catalog, catalog-db: mariadb:11.4, catalog-dump)`,
      "wait for catalog-db to be healthy",
      "create/update the database users inside catalog-db (docker exec as root: database, p5_cache, users catalog and catalog_ro with the passwords from secrets/, grants), then verify the login with catalog.cnf; idempotent, also repairs an initialised data dir",
      "catalog_init against the new database (schema + p5_cache)",
      rewire
        ? `write catalogMysqlContainer=catalog-db, catalogDbCnf=${r.dir}/secrets/catalog.cnf, viewerHost, viewerDir into ${configPath()}; pack/catalog_* then use the new database`
        : `${hostName} is not the P5 host: the MCP config is NOT rewired (pack and the catalog_* tools run on the P5 host and need catalog-db there); only viewerHost/viewerDir are recorded`,
    ],
    note: "Existing catalogue data stays where it is: copy it over with catalog_migrate. The viewer password is printed once at the end.",
    ...(r.subpath ? { reverseProxy: apacheSnippet(r.subpath, r.catalogIp) } : {}),
  };
  if (!o.confirm) return { confirmationRequired: true as const, plan };

  const web = webSourceDir();
  if (!existsSync(join(web, "docker-compose.yaml"))) throw new P5Error(`web/ not found next to the package (${web})`);
  const h = onHost(cfg, r.host);
  const restPw = readPassword(cfg.restPasswordFile);
  const pre = await runRemote(h, `docker network inspect ${shellQuote(r.network)} >/dev/null 2>&1 && echo net-ok; docker compose version >/dev/null 2>&1 && echo compose-ok`);
  if (!pre.stdout.includes("net-ok")) throw new P5Error(`docker network "${r.network}" does not exist on ${hostName} (docker network ls)`);
  if (!pre.stdout.includes("compose-ok")) throw new P5Error(`docker compose is not available on ${hostName}`);
  const state = await inspectInstall(h, r.dir);

  await copyWeb(h, r.dir);
  const prov = await provisionSecrets(h, r.dir, r.viewerUser, cfg, restPw, state);
  const viewerPassword = prov.viewerPassword;
  const reuse = viewerPassword === null;
  const owned = { listen: 8080, p5BaseUrl: r.p5BaseUrl, p5RestUrl: cfg.restUrl, p5Client: "localhost", indexDir: "/p5index", mysqlHost: r.dbIp, mysqlPort: 3306, mysqlDatabase: "archive_catalog", packRoot: cfg.packRoot, packRootMount: "/packroot", packRootP5: cfg.packRootP5, mailSlots: cfg.mailSlots, cliName: "archiware", cacheTtlMinutes: cfg.cacheTtlMinutes };
  const webCfg = { ...(state.config ?? {}), ...owned };
  await put(h, `${r.dir}/config/config.json`, JSON.stringify(webCfg, null, 2) + "\n", "644");
  const env = [`DOCKER_NETWORK=${r.network}`, `CATALOG_IP=${r.catalogIp}`, `CATALOG_DB_IP=${r.dbIp}`, `P5_INDEX_DIR=${r.p5Index}`, `PACK_ROOT=${r.packRoot}`, `DB_DATA_DIR=${r.dataDir}`, `TZ=${r.tz}`].join("\n") + "\n";
  const wr = await runRemote(h, `cd ${shellQuote(r.dir)} && { cat; printf 'CATALOG_UID=%s\\nCATALOG_GID=%s\\n' "$(id -u)" "$(id -g)"; } > .env`, { input: env });
  if (wr.rc !== 0) throw new P5Error(`cannot write ${r.dir}/.env: ${wr.stderr}`);
  const up = await runRemote(h, `cd ${shellQuote(r.dir)} && docker compose up -d --build 2>&1 | tail -n 15`, { timeoutMs: 1_200_000 });
  if (up.rc !== 0) throw new P5Error(`docker compose up failed: ${up.stdout}${up.stderr}`);
  let health = "";
  for (let i = 0; i < 36; i++) {
    health = (await runRemote(h, "docker inspect -f '{{.State.Health.Status}}' catalog-db 2>&1")).stdout.trim();
    if (health === "healthy") break;
    await new Promise((res) => setTimeout(res, 5000));
  }
  if (health !== "healthy") throw new P5Error(`catalog-db is "${health}" after 3 minutes; look at: docker logs catalog-db (on ${hostName})`);
  await ensureDbUsers(h);
  const init = await catalogInit(viewerSqlCfg(cfg, r.host, r.dir));

  const file = configPath();
  const raw = readConfigFile(file);
  const next: Partial<ArchiwareConfig> = { ...raw, viewerHost: r.host, viewerDir: r.dir };
  if (rewire) Object.assign(next, { catalogMysqlContainer: "catalog-db", catalogDbCnf: `${r.dir}/secrets/catalog.cnf` });
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n");

  return {
    confirmationRequired: false as const,
    deployed: true,
    host: hostName,
    installDir: r.dir,
    url: `http://${r.catalogIp}:8080/`,
    database: { host: r.dbIp, port: 3306, tables: init.tables.map((t) => t.name), mcpConfigRewired: rewire },
    secretsKept: prov.kept, secretsGenerated: prov.generated,
    ...(viewerPassword ? { viewerLogin: { user: r.viewerUser, password: viewerPassword, note: "shown once; it is not stored in clear text anywhere (only its hash is in secrets.json)" } } : { viewerLogin: "unchanged (existing login kept)" }),
    note: "The login cookie is Secure: the login only sticks behind HTTPS, i.e. through the reverse proxy.",
    ...(r.subpath ? { reverseProxy: apacheSnippet(r.subpath, r.catalogIp) } : {}),
  };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function viewerWhere(cfg: ArchiwareConfig) {
  if (!cfg.viewerDir) throw new P5Error("no viewer deployed (viewerDir is not set); run viewer_deploy");
  return { host: viewerHost(cfg), dir: cfg.viewerDir };
}

export async function viewerStatus(cfg: ArchiwareConfig) {
  const { host, dir } = viewerWhere(cfg);
  const h = onHost(cfg, host);
  const ps = await runRemote(h, `docker inspect -f '{{.Name}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}|{{.State.StartedAt}}' catalog catalog-db catalog-dump 2>&1; echo "DUMPUSER|$(docker inspect -f '{{.Config.User}}' catalog-dump 2>/dev/null)"; ls -1t ${shellQuote(`${dir}/dumps`)}/archive_catalog-*.sql.gz 2>/dev/null | head -1 | while read f; do echo "DUMP|$f|$(stat -c '%s|%y' "$f")"; done; ls ${shellQuote(`${dir}/dumps`)}/archive_catalog-*.sql.gz 2>/dev/null | wc -l | sed 's/^/DUMPS|/'`);
  const containers: { name: string; state: string; health: string; since: string }[] = [];
  let lastDump: { file: string; bytes: number; modified: string } | null = null;
  let dumps = 0;
  let dumpUser = "";
  for (const l of ps.stdout.split("\n")) {
    const f = l.split("|");
    if (f[0] === "DUMP") lastDump = { file: f[1], bytes: Number(f[2]), modified: f[3]?.slice(0, 19) ?? "" };
    else if (f[0] === "DUMPUSER") dumpUser = f[1] || "root (image default)";
    else if (f[0] === "DUMPS") dumps = Number(f[1]);
    else if (f.length === 4) containers.push({ name: f[0].replace(/^\//, ""), state: f[1], health: f[2], since: f[3] });
  }
  const out: Record<string, unknown> = { host: host || "(this machine)", installDir: dir, containers, lastDump, dumpsKept: dumps, ...(dumpUser ? { dumpRunsAs: dumpUser } : {}) };
  try {
    const v = viewerSqlCfg(cfg, host, dir);
    const size = await sql(v, "SELECT ROUND(COALESCE(SUM(data_length+index_length),0)/1048576,1) FROM information_schema.tables WHERE table_schema='archive_catalog'");
    const rows = await sql(v, "SELECT (SELECT COUNT(*) FROM sets), (SELECT COUNT(*) FROM tars), (SELECT COUNT(*) FROM entries)");
    const cache = await sql(v, "SELECT COUNT(*), COALESCE(MAX(fetched_at),'') FROM p5_cache");
    out.database = { sizeMiB: Number(size[0]?.[0] ?? 0), sets: Number(rows[0]?.[0]), tars: Number(rows[0]?.[1]), entries: Number(rows[0]?.[2]) };
    out.cache = { entries: Number(cache[0]?.[0] ?? 0), newest: cache[0]?.[1] || null, ttlMinutes: cfg.cacheTtlMinutes };
  } catch (e) {
    out.database = { error: (e as Error).message };
  }
  return out;
}

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------

export interface MigrateOptions {
  from: string;
  user: string;
  passwordFile: string;
  confirm: boolean;
  force?: boolean;
  sourceTls?: "verify" | "skip-verify" | "off";
}

/** ERROR 2026 = the client refused the source's TLS certificate. */
const tlsHint = (stderr: string): string => (/\b2026\b|SSL|TLS/.test(stderr) ? "\nhint: the source's certificate was rejected; retry with --source-tls skip-verify (encrypted, certificate not checked) or --source-tls off" : "");

const COUNT_SQL = "SELECT 'sets', COUNT(*) FROM sets UNION ALL SELECT 'tars', COUNT(*) FROM tars UNION ALL SELECT 'entries', COUNT(*) FROM entries";

export async function catalogMigrate(cfg: ArchiwareConfig, o: MigrateOptions) {
  const m = o.from.match(/^([A-Za-z0-9._-]+)(?::(\d{1,5}))?$/);
  if (!m) throw new P5Error(`--from must be host[:port], got "${o.from}"`);
  if (!NAME_RE.test(o.user)) throw new P5Error(`invalid --user "${o.user}"`);
  const tls = o.sourceTls ?? "verify";
  if (!["verify", "skip-verify", "off"].includes(tls)) throw new P5Error(`--source-tls must be verify, skip-verify or off, got "${tls}"`);
  const tlsArgs = tls === "skip-verify" ? ["--ssl-verify-server-cert=0"] : tls === "off" ? ["--skip-ssl"] : [];
  const { host, dir } = viewerWhere(cfg);
  const srcHost = m[1];
  const srcPort = m[2] ?? "3306";
  const where = host || "(this machine)";
  if (!o.confirm) {
    return {
      confirmationRequired: true as const,
      plan: {
        runsOn: `${where}, inside the catalog-db container (${dir})`,
        source: `${srcHost}:${srcPort} database archive_catalog as user ${o.user} (password read from ${o.passwordFile} on the machine running the MCP, sent over stdin into a temporary 0600 client file in the container, removed afterwards)`,
        target: "catalog-db, database archive_catalog, as user catalog",
        steps: [
          "catalog_init on the target (schema, idempotent)",
          `source TLS: ${tls}${tlsArgs.length ? ` (client flag ${tlsArgs[0]})` : ""}`,
          "count rows of sets, tars, entries on source and target; refuse when the target already holds rows (override: --force; the dump then DROPs and recreates sets, tars, entries)",
          "mariadb-dump --single-transaction archive_catalog (without p5_cache) from the source | mariadb archive_catalog on the target",
          "count again and compare source against target; report match or mismatch",
        ],
        note: "Read-only on the source. Needs a MySQL/MariaDB user with SELECT on archive_catalog that may connect from the docker host. Afterwards `viewer_status` shows the sizes.",
      },
    };
  }
  const pw = readFileSync(o.passwordFile, "utf8").replace(/\r?\n$/, "");
  if (!pw) throw new P5Error(`${o.passwordFile} is empty`);
  const h = onHost(cfg, host);
  await catalogInit(viewerSqlCfg(cfg, host, dir));
  const C = "catalog-db";
  const dx = (args: string[]) => `docker exec ${C} ${args.map(shellQuote).join(" ")}`;
  const cleanup = () => runRemote(h, dx(["rm", "-f", "/tmp/src.cnf", "/tmp/dst.cnf"]));
  try {
    const a = await runRemote(h, `docker exec -i ${C} sh -c 'umask 077; cat > /tmp/src.cnf'`, { input: `[client]\nuser=${o.user}\npassword="${pw.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"\n` });
    const b = await runRemote(h, `docker exec -i ${C} sh -c 'umask 077; cat > /tmp/dst.cnf' < ${shellQuote(`${dir}/secrets/catalog.cnf`)}`);
    if (a.rc !== 0 || b.rc !== 0) throw new P5Error(`cannot prepare the client files in ${C}: ${a.stderr || b.stderr}`);
    const count = async (cnf: "src" | "dst") => {
      const r = await runRemote(h, dx(["mariadb", `--defaults-extra-file=/tmp/${cnf}.cnf`, ...(cnf === "src" ? ["-h", srcHost, "-P", srcPort, ...tlsArgs] : []), "-N", "-B", "archive_catalog", "-e", COUNT_SQL]));
      if (r.rc !== 0) throw new P5Error(`counting rows on the ${cnf === "src" ? `source ${srcHost}:${srcPort}` : "target"} failed: ${r.stderr.split("\n")[0]}${tlsHint(r.stderr)}`);
      return Object.fromEntries(r.stdout.trim().split("\n").map((l) => l.split("\t")).map(([k, v]) => [k, Number(v)])) as Record<string, number>;
    };
    const source = await count("src");
    const before = await count("dst");
    const have = Object.values(before).reduce((x, y) => x + y, 0);
    if (have > 0 && !o.force) throw new P5Error(`the target catalogue already holds rows (${JSON.stringify(before)}); nothing was changed. Use --force to replace sets, tars and entries with the source's copy`);
    const copy = await runRemote(h, dx(["bash", "-c", 'set -o pipefail; mariadb-dump --defaults-extra-file=/tmp/src.cnf -h "$0" -P "$1" $2 --single-transaction --skip-lock-tables --ignore-table=archive_catalog.p5_cache archive_catalog | mariadb --defaults-extra-file=/tmp/dst.cnf archive_catalog', srcHost, srcPort, tlsArgs.join(" ")]), { timeoutMs: 6 * 3600_000 });
    if (copy.rc !== 0) throw new P5Error(`dump/load failed: ${copy.stderr.split("\n").slice(0, 3).join(" | ")}${tlsHint(copy.stderr)}`);
    const after = await count("dst");
    const match = ["sets", "tars", "entries"].every((k) => source[k] === after[k]);
    return { confirmationRequired: false as const, migrated: true, source, targetBefore: before, targetAfter: after, match, note: match ? "row counts match" : "ROW COUNTS DIFFER: the source changed during the copy, or the load was incomplete; rerun with --force after pausing writers" };
  } finally {
    await cleanup().catch(() => undefined);
  }
}
