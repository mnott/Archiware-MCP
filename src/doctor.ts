/**
 * archiware doctor — configuration and connectivity report.
 *
 * Each line is ok / warn / fail with a one-line fix hint. Read-only: only
 * `true`, `docker version`, `test -x`, GET requests and nsdchat reads are run.
 * `setup` ends with the same list.
 */

import { existsSync, statSync } from "node:fs";
import { MODES, missingKeys, type ArchiwareConfig } from "./config.js";
import { health, type HealthCheck } from "./restops.js";
import { hostCommand, mtxStatus } from "./transport.js";
import { parseMtx } from "./operations.js";

export type Level = "ok" | "warn" | "fail";
export interface DoctorLine {
  name: string;
  level: Level;
  reason: string;
  /** One-line hint, only for warn/fail. */
  fix?: string;
}

const line = (name: string, level: Level, reason: string, fix?: string): DoctorLine => ({ name, level, reason, ...(level === "ok" ? {} : { fix }) });

/** Fix hints for the checks that `health` reports. */
const HEALTH_FIX: Record<string, string> = {
  p5: "run `archiware p5_config_backup --yes` (schedule it daily, see docs/guides/p5-config-backup.md)",
  "p5 dr kit": "run `archiware p5_dr_kit --yes` (schedule it daily, see docs/guides/disaster-recovery.md)",
  container: "start it (docker start <container>) or fix `container` in the config",
  p5host: "check `p5Home` in the config: nsdchat must exist at <p5Home>/bin/nsdchat",
  rest: "check restUrl/containerIp, restUser and the password file; is the P5 web server up on port 8443?",
  version: "P5 does not answer: check the container / P5 service is running",
  nsdchat: "P5 CLI server does not answer: check the container / P5 service is running",
  jobs: "inspect with `archiware jobs`",
  drives: "run `archiware status`; check the drive/changer cabling",
  cleaning: "clean the drive: `archiware clean_drive <p5 device> --yes`",
  log: "check `logPath` in the config (host path of lexxsrv.log)",
  mail: "run `archiware notify_status`; fix the SMTP settings in the P5 GUI (Setup > Mail), then `archiware notify_test`; ensure_done --mail reports independently",
};

export function nodeMajor(version = process.versions.node): number {
  return Number(version.split(".")[0]);
}

export async function runDoctor(cfg: ArchiwareConfig, configFile: string): Promise<DoctorLine[]> {
  const out: DoctorLine[] = [];
  const nm = nodeMajor();
  out.push(nm >= 20 ? line("node", "ok", `v${process.versions.node}`) : line("node", "fail", `v${process.versions.node} is too old`, "install Node.js 20 or newer"));

  if (!existsSync(configFile)) {
    out.push(line("config", "fail", `${configFile} does not exist`, "run `archiware setup`"));
    return out;
  }
  if (!MODES.includes(cfg.mode)) {
    out.push(line("config", "fail", `unknown mode "${cfg.mode}"`, `set mode to one of ${MODES.join(", ")} (archiware setup --mode ...)`));
    return out;
  }
  const missing = missingKeys(cfg);
  out.push(
    missing.length
      ? line("config", "fail", `mode ${cfg.mode}: missing ${missing.join(", ")}`, "run `archiware setup` (or pass the missing keys as flags)")
      : line("config", "ok", `${configFile} (mode ${cfg.mode})`),
  );
  if (missing.length) return out;

  // password file
  if (!existsSync(cfg.restPasswordFile)) {
    out.push(line("password", "fail", `${cfg.restPasswordFile} does not exist`, "run `archiware setup` and enter the REST password at the prompt"));
  } else {
    const mode = statSync(cfg.restPasswordFile).mode & 0o777;
    out.push(
      mode & 0o077
        ? line("password", "warn", `${cfg.restPasswordFile} is mode ${mode.toString(8)}`, `chmod 600 ${cfg.restPasswordFile}`)
        : line("password", "ok", `${cfg.restPasswordFile} (mode 600)`),
    );
  }

  // transport prerequisites
  if (cfg.mode !== "local") {
    const ssh = await probeSsh(cfg);
    out.push(ssh);
    if (ssh.level === "fail") return out;
  }
  if (cfg.mode === "docker") {
    const d = await hostCommand(cfg, ["docker", "version", "--format", "{{.Server.Version}}"], 20_000).catch(() => null);
    out.push(
      d && d.rc === 0
        ? line("docker", "ok", `docker ${d.stdout.trim()} on ${cfg.sshHost}`)
        : line("docker", "fail", `docker not usable on ${cfg.sshHost}${d?.stderr ? `: ${d.stderr.split("\n")[0]}` : ""}`, "install docker there, or add the ssh user to the docker group"),
    );
  }

  // P5 itself: container/p5host, rest, version, nsdchat, jobs, drives, ...
  const h = await health(cfg);
  for (const c of h.checks as HealthCheck[]) out.push(line(c.name, c.level, c.reason, HEALTH_FIX[c.name.split(" ")[0]] ?? "see `archiware status`"));

  // tape changer (host-side tape operations)
  if (!cfg.changer) {
    out.push(line("changer", "warn", "no changer configured (tape_* tools and slots need it)", "run `archiware setup --changer /dev/sgN` (find it with `lsscsi -g`)"));
  } else {
    try {
      const m = parseMtx(await mtxStatus(cfg));
      out.push(line("changer", "ok", `${cfg.changer}: ${m.drives} drive(s), ${m.slots} slot(s)`));
      out.push(
        cfg.drives.length
          ? line("tape drives", "ok", `${cfg.drives.length} configured`)
          : line("tape drives", "warn", `${m.drives} drive(s) in changer, none in config`, 'add "drives": [{"element":0,"gen":"L6","nst":"/dev/nst0","p5":"sg7"}] to the config'),
      );
    } catch (e) {
      out.push(line("changer", "warn", (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 160), "check `changer`, that mtx is installed and `sudo -n mtx` works for the ssh user"));
    }
  }
  return out;
}

async function probeSsh(cfg: ArchiwareConfig): Promise<DoctorLine> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", cfg.sshHost, "true"], { timeout: 20_000 }, (e, _o, stderr) => {
      if (!e) resolve(line("ssh", "ok", `${cfg.sshHost} reachable`));
      else
        resolve(
          line("ssh", "fail", `cannot ssh to ${cfg.sshHost}: ${(String(stderr).trim() || e.message).split("\n")[0].slice(0, 160)}`, `make \`ssh ${cfg.sshHost} true\` work without a password prompt (ssh-copy-id, ~/.ssh/config)`),
        );
    });
  });
}

export function formatDoctor(lines: DoctorLine[]): string {
  const rows = lines.map((l) => `${l.level.toUpperCase().padEnd(4)}  ${l.name.padEnd(14)} ${l.reason}${l.fix ? `\n${" ".repeat(20)}fix: ${l.fix}` : ""}`);
  const worst: Level = lines.some((l) => l.level === "fail") ? "fail" : lines.some((l) => l.level === "warn") ? "warn" : "ok";
  return `${rows.join("\n")}\n\nOverall: ${worst.toUpperCase()}`;
}

export const doctorExitCode = (lines: DoctorLine[]) => (lines.some((l) => l.level === "fail") ? 1 : 0);
