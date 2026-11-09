/**
 * archiware setup — write the config, create the REST password file,
 * register the MCP server with Claude Code, end with the doctor list.
 *
 * Idempotent: values come from flags, else from the existing config file,
 * else (on a TTY) from a prompt. Re-running rewrites the config only when it
 * changes, never overwrites an existing password file, and skips registration
 * when the server is already registered.
 *
 * The REST password is read from a hidden TTY prompt only; it is never taken
 * from argv or the environment and never echoed. The config file holds the
 * path of the password file, not the password.
 */

import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { buildConfig, configPath, MODES, readConfigFile, type ArchiwareConfig, type Mode } from "./config.js";
import { doctorExitCode, formatDoctor, nodeMajor, runDoctor, type DoctorLine } from "./doctor.js";
import { hostCommand, mtxStatus } from "./transport.js";
import { configDir } from "./p5db.js";
import { parseMtx } from "./operations.js";
import { viewerDeploy, viewerHost } from "./viewer.js";

export interface SetupOptions {
  config?: string;
  mode?: string;
  sshHost?: string;
  container?: string;
  containerIp?: string;
  composeDir?: string;
  backupDir?: string;
  p5Home?: string;
  restUrl?: string;
  changer?: string;
  restUser?: string;
  restPasswordFile?: string;
  yes?: boolean;
  /** Skip `claude mcp add` (used for dry runs into a temporary config). */
  noRegister?: boolean;
}

export const SETUP_FLAGS: Record<string, keyof SetupOptions> = {
  config: "config",
  mode: "mode",
  "ssh-host": "sshHost",
  container: "container",
  "container-ip": "containerIp",
  "compose-dir": "composeDir",
  "backup-dir": "backupDir",
  "p5-home": "p5Home",
  "rest-url": "restUrl",
  changer: "changer",
  "rest-user": "restUser",
  "rest-password-file": "restPasswordFile",
};

export const SETUP_USAGE = `archiware setup — configure archiware-mcp and register it with Claude Code

Usage: archiware setup [options]

Options (each missing value is asked for when stdin is a terminal):
  --mode docker|ssh|local   where Archiware P5 runs
                              docker: in a container on an ssh host
                              ssh:    installed natively on an ssh host
                              local:  on this machine
  --ssh-host <host>         ssh host (docker, ssh)
  --container <name>        docker container name (docker)
  --container-ip <ip>       IP of the container, for REST (docker)
  --compose-dir <dir>       host dir of the docker compose project (docker)
  --backup-dir <dir>        host dir for container_backup (docker)
  --p5-home <dir>           P5 install dir (ssh, local; default /usr/local/aw)
  --rest-url <url>          REST base URL (ssh, local; default https://localhost:8443)
  --rest-user <user>        REST user (default admin)
  --rest-password-file <f>  file holding the REST password (mode 600). Created from a
                            hidden prompt when missing. The password is never read from argv.
  --changer </dev/sgN>      tape changer device on the P5 host (detected when possible)
  --config <path>           config file to write (default ~/.config/archiware-mcp/config.json)
  --no-register             do not register with Claude Code
  --yes                     no confirmation questions; use defaults where there is one

Re-running only changes what is missing or wrong. Ends with the \`archiware doctor\` list.
`;

type Ask = (question: string, def?: string) => Promise<string>;

function makeAsk(): Ask | null {
  if (!process.stdin.isTTY) return null;
  return (question, def) =>
    new Promise((res) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      rl.question(`${question}${def ? ` [${def}]` : ""}: `, (a) => {
        rl.close();
        res(a.trim() || def || "");
      });
    });
}

/** Hidden prompt on the TTY: no echo, nothing logged. */
export function askSecret(question: string): Promise<string> {
  return new Promise((res, rej) => {
    if (!process.stdin.isTTY) return rej(new Error("no terminal for the password prompt"));
    process.stderr.write(`${question}: `);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let pw = "";
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n" || c === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stderr.write("\n");
          return res(pw);
        }
        if (c === "\u0003") {
          stdin.setRawMode(false);
          process.stderr.write("\n");
          return rej(new Error("cancelled"));
        }
        if (c === "\u007f" || c === "\b") pw = pw.slice(0, -1);
        else pw += c;
      }
    };
    stdin.on("data", onData);
  });
}

function sh(cmd: string, args: string[], timeout = 30_000): Promise<{ rc: number; out: string }> {
  return new Promise((res) => {
    execFile(cmd, args, { timeout }, (e, stdout, stderr) => {
      const code = e ? (typeof (e as { code?: unknown }).code === "number" ? ((e as { code: number }).code) : 1) : 0;
      res({ rc: code, out: `${stdout}${stderr}`.trim() });
    });
  });
}

const step = (msg: string) => console.error(`==> ${msg}`);

/** Find the medium changer's sg device on the P5 host via lsscsi (best effort). */
async function detectChanger(cfg: ArchiwareConfig): Promise<string | null> {
  const r = await hostCommand(cfg, ["lsscsi", "-g"], 20_000).catch(() => null);
  if (!r || r.rc !== 0) return null;
  const m = r.stdout.split("\n").find((l) => /\bmediumx\b/.test(l));
  return m?.match(/(\/dev\/sg\d+)\s*$/)?.[1] ?? null;
}

export async function runSetup(opts: SetupOptions): Promise<number> {
  const file = resolve(opts.config ?? configPath());
  const existing = readConfigFile(file);
  const ask = makeAsk();
  const lines: DoctorLine[] = [];

  step("prerequisites");
  if (nodeMajor() < 20) {
    console.error(`Node.js ${process.versions.node} is too old; install Node.js 20 or newer.`);
    return 1;
  }

  // ---- gather answers: flag > existing config > prompt > default ----
  const missing: string[] = [];
  const need = async (flag: string, flagVal: string | undefined, current: string | undefined, question: string, def?: string): Promise<string> => {
    const v = flagVal ?? (current || undefined);
    if (v) return v;
    if (ask) {
      const a = await ask(question, def);
      if (a) return a;
    }
    if (def !== undefined && (!ask || opts.yes)) return def;
    missing.push(`--${flag}`);
    return "";
  };

  let mode = (opts.mode ?? existing.mode) as string | undefined;
  if (!mode && ask) mode = await ask(`Where does Archiware P5 run? (${MODES.join(" / ")})`, "docker");
  mode = mode ?? (opts.yes ? "docker" : undefined);
  if (!mode || !MODES.includes(mode as Mode)) {
    console.error(`Missing or unknown --mode (${MODES.join(", ")}): docker = container on an ssh host, ssh = native install on an ssh host, local = this machine.`);
    return 1;
  }
  const raw: Partial<ArchiwareConfig> = { ...existing, mode: mode as Mode };
  if (mode !== "local") raw.sshHost = await need("ssh-host", opts.sshHost, existing.sshHost, "ssh host of the P5 machine (as in `ssh <host>`)");
  if (mode === "docker") {
    raw.container = await need("container", opts.container, existing.container, "docker container name");
    raw.containerIp = await need("container-ip", opts.containerIp, existing.containerIp, "container IP address (reachable from the docker host)");
    raw.composeDir = await need("compose-dir", opts.composeDir, existing.composeDir, "docker compose directory on the host");
    raw.backupDir = await need("backup-dir", opts.backupDir, existing.backupDir, "backup directory on the host (for container_backup)");
    if (opts.p5Home) raw.p5Home = opts.p5Home;
  } else {
    raw.p5Home = await need("p5-home", opts.p5Home, existing.p5Home, "P5 install directory", "/usr/local/aw");
    if (opts.restUrl) raw.restUrl = opts.restUrl;
  }
  if (opts.restUrl && mode === "docker") raw.restUrl = opts.restUrl;
  raw.restUser = opts.restUser ?? existing.restUser ?? "admin";
  raw.restPasswordFile = resolve(opts.restPasswordFile ?? existing.restPasswordFile ?? join(dirname(file), "rest.password"));
  if (opts.changer) raw.changer = opts.changer;
  if (missing.length) {
    console.error(`Missing values for mode ${mode}: ${missing.join(" ")}. Pass them as flags or run in a terminal to be asked.`);
    return 1;
  }

    const cfg = buildConfig(raw);

  // ---- detect changer and drives ----
  step("detect tape changer");
  if (!raw.changer) {
    const found = await detectChanger(cfg);
    if (found) {
      raw.changer = found;
      cfg.changer = found;
      console.error(`    changer found: ${found}`);
    } else {
      console.error("    no changer detected (lsscsi missing or no library); tape tools stay off. Set it later with --changer.");
      if (ask && !opts.yes) {
        const c = await ask("tape changer device (empty = none)", "");
        if (c) {
          raw.changer = c;
          cfg.changer = c;
        }
      }
    }
  }
  if (cfg.changer && (existing.drives ?? []).length === 0) {
    try {
      const m = parseMtx(await mtxStatus(cfg));
      console.error(`    changer ${cfg.changer}: ${m.drives} drive(s), ${m.slots} slot(s). Add "drives" (element, gen, nst, p5) to ${file} to enable tape_load/tape_erase/clean_drive.`);
    } catch {
      console.error(`    could not read ${cfg.changer} with sudo -n mtx (doctor will report).`);
    }
  }

  // ---- config file ----
  step(`config ${file}`);
  const text = JSON.stringify(raw, null, 2) + "\n";
  let current = "";
  try {
    current = readFileSync(file, "utf8");
  } catch {
    // new file
  }
  if (current === text) console.error("    unchanged");
  else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    console.error(current ? "    updated" : "    written");
  }

  // ---- password file ----
  step(`REST password file ${cfg.restPasswordFile}`);
  const pwf = cfg.restPasswordFile;
  if (existsSync(pwf)) {
    if (statSync(pwf).mode & 0o077) {
      chmodSync(pwf, 0o600);
      console.error("    exists; permissions tightened to 600");
    } else console.error("    exists, mode 600");
  } else if (ask) {
    const pw = await askSecret(`REST password for user ${cfg.restUser} (input hidden)`);
    if (!pw) {
      console.error("    empty password; not written");
    } else {
      mkdirSync(dirname(pwf), { recursive: true });
      writeFileSync(pwf, pw + "\n", { mode: 0o600 });
      chmodSync(pwf, 0o600);
      console.error("    written, mode 600");
    }
  } else {
    console.error(`    missing and no terminal to ask on. Create it yourself:\n      umask 077; read -rs PW && printf '%s\\n' "$PW" > ${pwf}\n    or re-run \`archiware setup\` in a terminal.`);
  }

  // ---- optional: catalogue viewer ----
  if (ask && !opts.yes && existsSync(cfg.restPasswordFile)) await offerViewer(cfg, file, ask);

  // ---- register with Claude Code ----
  step("register with Claude Code");
  if (opts.noRegister) console.error("    skipped (--no-register)");
  else await registerClaude(file);

  // ---- doctor ----
  step("doctor");
  lines.push(...(await runDoctor(cfg, file)));
  console.log(formatDoctor(lines));
  return doctorExitCode(lines);
}

/** Optional step after the P5 connection: deploy the catalogue viewer (web page + its own database) on a docker host. */
async function offerViewer(cfg: ArchiwareConfig, file: string, ask: Ask): Promise<void> {
  step("catalogue viewer (optional)");
  const yn = (await ask("Deploy the catalogue viewer (web page + its own database) on the docker host? [y/N]", "N")).trim().toLowerCase();
  if (yn !== "y" && yn !== "yes") {
    console.error("    skipped; later run `archiware viewer_deploy --network N --catalog-ip IP --db-ip IP` (plan without --yes)");
    return;
  }
  const host = await ask("docker host (ssh target)", viewerHost(cfg));
  const dir = await ask("install dir on that host", cfg.viewerDir || "/opt/catalog-viewer");
  const dataDir = await ask("database data dir on that host", `${dir}/data/db`);
  const network = await ask("docker network name (external, must exist)", "dockernet");
  const catalogIp = await ask("fixed IP of the web page on that network");
  const dbIp = await ask("fixed IP of the database on that network");
  let p5Index = "";
  try {
    p5Index = `${configDir(cfg)}/index/backup`;
  } catch {
    p5Index = "";
  }
  p5Index = await ask("P5 backup index dir on the host (config/index/backup)", p5Index);
  const packRoot = await ask("pack root on the host", cfg.packRoot);
  const subpath = await ask("reverse-proxy sub-path (informational, empty = none)", "");
  const o = { host, dir, dataDir, network, catalogIp, dbIp, p5Index, packRoot, subpath: subpath || undefined };
  process.env.ARCHIWARE_CONFIG = file;
  try {
    console.error(JSON.stringify(await viewerDeploy(cfg, { ...o, confirm: false }), null, 2));
    const go = (await ask("Deploy this now? [y/N]", "N")).trim().toLowerCase();
    if (go !== "y" && go !== "yes") {
      console.error("    not deployed");
      return;
    }
    const r = await viewerDeploy(cfg, { ...o, confirm: true });
    console.error(JSON.stringify(r, null, 2));
  } catch (e) {
    console.error(`    viewer deploy failed: ${(e as Error).message}`);
  }
}

/** Absolute path of dist/index.js next to this module. */
export function serverEntry(): string {
  return realpathSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"));
}

async function registerClaude(file: string): Promise<void> {
  const entry = serverEntry();
  const env = file === join(homedir(), ".config", "archiware-mcp", "config.json") ? [] : ["-e", `ARCHIWARE_CONFIG=${file}`];
  const add = ["mcp", "add", "archiware", "-s", "user", ...env, "--", "node", entry];
  const shown = `claude ${add.map((a) => (/[^\w@%+=:,./-]/.test(a) ? `'${a}'` : a)).join(" ")}`;
  const have = await sh("claude", ["--version"], 10_000);
  if (have.rc !== 0) {
    console.error(`    the \`claude\` CLI was not found. Register the server yourself once Claude Code is installed:\n      ${shown}`);
    return;
  }
  const get = await sh("claude", ["mcp", "get", "archiware"], 20_000);
  if (get.rc === 0 && get.out.includes(entry)) {
    console.error("    already registered");
    return;
  }
  if (get.rc === 0) {
    console.error("    registered with a different command; replacing");
    await sh("claude", ["mcp", "remove", "archiware", "-s", "user"], 20_000);
  }
  console.error(`    ${shown}`);
  const r = await sh("claude", add, 30_000);
  console.error(r.rc === 0 ? "    registered (restart Claude Code to load it)" : `    failed: ${r.out.split("\n")[0]}\n    run the command above yourself`);
}
