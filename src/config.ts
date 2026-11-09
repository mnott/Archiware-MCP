/**
 * Configuration for archiware-mcp.
 *
 * Read from ~/.config/archiware-mcp/config.json (or the file named by
 * ARCHIWARE_CONFIG), overridable by the environment variables ARCHIWARE_MODE,
 * ARCHIWARE_SSH_HOST, ARCHIWARE_CONTAINER, ARCHIWARE_CONTAINER_IP,
 * ARCHIWARE_REST_URL, ARCHIWARE_REST_USER, ARCHIWARE_REST_PASSWORD_FILE, ARCHIWARE_BACKUP_DIR.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One tape drive: mtx element number, generation, host nst device, P5 device name. */
export interface DriveConfig {
  /** Data Transfer Element number in the changer (mtx element). */
  element: number;
  /** Tape generation: "L6" = LTO-6, "L9" = LTO-9. Barcode suffix decides it. */
  gen: string;
  /** Host tape device, e.g. /dev/nst1 (mt / dd talk to this). */
  nst: string;
  /** P5 device name, e.g. sg7. */
  p5: string;
}

/** Where P5 runs: docker (container on an ssh host), ssh (native on an ssh host), local (this machine). */
export type Mode = "docker" | "ssh" | "local";
export const MODES: Mode[] = ["docker", "ssh", "local"];

export interface ArchiwareConfig {
  /** Where Archiware P5 runs. */
  mode: Mode;
  /** Host reachable via plain `ssh <sshHost>` (docker and ssh mode; unused in local mode). */
  sshHost: string;
  /** Docker container name running P5 (docker mode). */
  container: string;
  /** P5 install directory of a native install (ssh and local mode). */
  p5Home: string;
  /** Path to nsdchat (inside the container in docker mode). Default <p5Home>/bin/nsdchat. */
  nsdchat: string;
  /** Medium changer device on the P5 host, for `sudo -n mtx -f <changer> status`. */
  changer: string;
  /** lexxsrv log on the P5 host (holds the job report blocks). Native modes default to <p5Home>/log/lexxsrv.log; docker mode: host path of the mounted log, "" = not available. */
  logPath: string;
  /** Command timeout in milliseconds. */
  timeoutMs: number;
  /** Timeout for "long" nsdchat calls (index lookups, inventories), milliseconds. Default 600000. */
  longTimeoutMs: number;
  /** Seconds a call waits for the host-side nsdchat lock held by another call. Default 120. */
  lockWaitS: number;
  /** Library layout: pool name -> slot range/list ("9-12", "14-22" or [9,10,11]). */
  slotLayout: Record<string, string | number[]>;
  /** Import/export (mail slot) element ids; empty = take them from mtx. */
  mailSlots: number[];
  /** Tape drives, for host-side tape operations (mtx/mt). */
  drives: DriveConfig[];
  /** Slot holding the cleaning tape (barcode CLN*); 0 = none. */
  cleaningSlot: number;
  /** P5 container IP, used for the REST URL (docker mode; reachable from the docker host). */
  containerIp: string;
  /** REST base URL (no trailing slash). Default https://<containerIp>:8443 (docker) or https://localhost:8443 (ssh, local); curl runs on the P5 host. */
  restUrl: string;
  /** REST basic-auth user. */
  restUser: string;
  /** File (local, mode 600) holding the REST password; read at call time only. */
  restPasswordFile: string;
  /** REST call timeout in milliseconds. */
  restTimeoutMs: number;
  /** Host paths whose free space `health` checks (df -P). */
  healthPaths: string[];
  /** Host dir (docker mode) under which container_backup creates archiware-update-<YYYYMMDD>. */
  backupDir: string;
  /** Host dir (docker mode) of the docker compose project (cold copy source). */
  composeDir: string;
  /** Host path of P5's config folder (holds customerconfig/ and index/backup/). Default: derived from logPath (<logdir>/../config) or <p5Home>/config. Used read-only. */
  p5ConfigDir: string;
  /** Operator mail address for ensure_done --mail and notify_test (sent by the host MTA, independent of P5's own mail). Empty = none. */
  operatorMail: string;
  /** Days without a sent P5 mail (while jobs ran) before doctor/health warn. Default 3. */
  mailSilenceDays: number;
  /** Months back governance_report looks for runs when judging plans. Default 3. */
  governanceMonths: number;
  /** Days a plan may stay disabled before governance_report flags it. Default 60. */
  disabledDays: number;
  /** Docker container on the P5 host running the MySQL file catalogue. Default "mysql". */
  catalogMysqlContainer: string;
  /** File on the P5 host (mode 600) with the MySQL client credentials of the catalogue user. Default /root/.mysql-catalog.cnf. Never printed. */
  catalogDbCnf: string;
  /** Host directory under which pack writes its tar sets. Default /srv/archive/pack (placeholder). */
  packRoot: string;
  /** The same directory as P5 sees it (docker mount point); "" = same as packRoot. Used to look tars up in P5's backup index. */
  packRootP5: string;
  /** Assumed tar write throughput in MB/s for the pack time estimate. Default 150. */
  packMBps: number;
}

/**
 * Defaults carry no site-specific values: host, container, container IP,
 * compose dir and backup dir are required keys that `archiware setup` fills in.
 */
export const DEFAULT_CONFIG: ArchiwareConfig = {
  mode: "docker",
  sshHost: "",
  container: "",
  p5Home: "/usr/local/aw",
  nsdchat: "",
  changer: "",
  logPath: "",
  timeoutMs: 60_000,
  longTimeoutMs: 600_000,
  lockWaitS: 120,
  slotLayout: {},
  mailSlots: [],
  drives: [],
  cleaningSlot: 0,
  containerIp: "",
  restUrl: "",
  restUser: "admin",
  restPasswordFile: join(homedir(), ".config", "archiware-mcp", "rest.password"),
  restTimeoutMs: 20_000,
  healthPaths: [],
  backupDir: "",
  composeDir: "",
  p5ConfigDir: "",
  operatorMail: "",
  mailSilenceDays: 3,
  governanceMonths: 3,
  disabledDays: 60,
  catalogMysqlContainer: "mysql",
  catalogDbCnf: "/root/.mysql-catalog.cnf",
  packRoot: "/srv/archive/pack",
  packRootP5: "",
  packMBps: 150,
};

export function configPath(): string {
  return process.env.ARCHIWARE_CONFIG || join(homedir(), ".config", "archiware-mcp", "config.json");
}

/** Read the raw config file (empty object when missing or unreadable). */
export function readConfigFile(path = configPath()): Partial<ArchiwareConfig> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);
const trimSlash = (p: string) => p.replace(/\/+$/, "") || (p ? "/" : "");

export function loadConfig(path = configPath()): ArchiwareConfig {
  return buildConfig(readConfigFile(path));
}

/** Resolve a raw config object (file contents) plus environment overrides into a full config. */
export function buildConfig(file: Partial<ArchiwareConfig>): ArchiwareConfig {
  const mode = (process.env.ARCHIWARE_MODE ?? file.mode ?? DEFAULT_CONFIG.mode) as Mode;
  const p5Home = trimSlash(file.p5Home ?? DEFAULT_CONFIG.p5Home);
  const containerIp = process.env.ARCHIWARE_CONTAINER_IP ?? file.containerIp ?? DEFAULT_CONFIG.containerIp;
  const defaultRest = mode === "docker" ? (containerIp ? `https://${containerIp}:8443` : "") : "https://localhost:8443";
  return {
    mode,
    sshHost: process.env.ARCHIWARE_SSH_HOST ?? file.sshHost ?? DEFAULT_CONFIG.sshHost,
    container: process.env.ARCHIWARE_CONTAINER ?? file.container ?? DEFAULT_CONFIG.container,
    p5Home,
    nsdchat: file.nsdchat ?? `${p5Home}/bin/nsdchat`,
    changer: file.changer ?? DEFAULT_CONFIG.changer,
    logPath: file.logPath ?? (mode === "docker" ? "" : `${p5Home}/log/lexxsrv.log`),
    timeoutMs: file.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
    longTimeoutMs: file.longTimeoutMs ?? DEFAULT_CONFIG.longTimeoutMs,
    lockWaitS: file.lockWaitS ?? DEFAULT_CONFIG.lockWaitS,
    slotLayout: file.slotLayout && typeof file.slotLayout === "object" ? file.slotLayout : DEFAULT_CONFIG.slotLayout,
    mailSlots: Array.isArray(file.mailSlots) ? file.mailSlots.map(Number) : DEFAULT_CONFIG.mailSlots,
    drives: Array.isArray(file.drives) ? file.drives : DEFAULT_CONFIG.drives,
    cleaningSlot: file.cleaningSlot ?? DEFAULT_CONFIG.cleaningSlot,
    containerIp,
    restUrl: (process.env.ARCHIWARE_REST_URL ?? file.restUrl ?? defaultRest).replace(/\/+$/, ""),
    restUser: process.env.ARCHIWARE_REST_USER ?? file.restUser ?? DEFAULT_CONFIG.restUser,
    restPasswordFile: expandHome(process.env.ARCHIWARE_REST_PASSWORD_FILE ?? file.restPasswordFile ?? DEFAULT_CONFIG.restPasswordFile),
    restTimeoutMs: file.restTimeoutMs ?? DEFAULT_CONFIG.restTimeoutMs,
    healthPaths: Array.isArray(file.healthPaths) ? file.healthPaths : DEFAULT_CONFIG.healthPaths,
    backupDir: trimSlash(process.env.ARCHIWARE_BACKUP_DIR ?? file.backupDir ?? DEFAULT_CONFIG.backupDir),
    composeDir: trimSlash(file.composeDir ?? DEFAULT_CONFIG.composeDir),
    p5ConfigDir: trimSlash(file.p5ConfigDir ?? DEFAULT_CONFIG.p5ConfigDir),
    operatorMail: file.operatorMail ?? DEFAULT_CONFIG.operatorMail,
    mailSilenceDays: file.mailSilenceDays ?? DEFAULT_CONFIG.mailSilenceDays,
    governanceMonths: file.governanceMonths ?? DEFAULT_CONFIG.governanceMonths,
    disabledDays: file.disabledDays ?? DEFAULT_CONFIG.disabledDays,
    catalogMysqlContainer: file.catalogMysqlContainer ?? DEFAULT_CONFIG.catalogMysqlContainer,
    catalogDbCnf: file.catalogDbCnf ?? DEFAULT_CONFIG.catalogDbCnf,
    packRoot: trimSlash(file.packRoot ?? DEFAULT_CONFIG.packRoot),
    packRootP5: trimSlash(file.packRootP5 ?? DEFAULT_CONFIG.packRootP5),
    packMBps: file.packMBps ?? DEFAULT_CONFIG.packMBps,
  };
}

/** Keys the chosen mode cannot work without but that are not set. */
export function missingKeys(cfg: ArchiwareConfig): string[] {
  const need: (keyof ArchiwareConfig)[] = ["restUrl", "restUser", "restPasswordFile"];
  if (cfg.mode === "docker") need.push("sshHost", "container", "containerIp", "composeDir", "backupDir");
  if (cfg.mode === "ssh") need.push("sshHost", "p5Home");
  return need.filter((k) => !cfg[k]);
}
