/**
 * Container lifecycle for the P5 docker container: backup, stop, start, update.
 *
 * Mirrors the manual operator procedure. Every step is a host command built by
 * a pure function (unit tested), run via ssh with shell-quoted argv. Nothing
 * uses `docker exec -i` (it eats stdin on the host). All operations are
 * confirm-gated; without confirm they list the steps that WOULD run.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { ArchiwareConfig } from "./config.js";
import { preferRest, restJobs } from "./restops.js";
import { restGet } from "./rest.js";
import { chatNames, hostCommand, P5Error, shellQuote } from "./transport.js";

export type Progress = (msg: string) => void;
const noProgress: Progress = () => undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STOP_TIMEOUT_S = 120;
/** docker stop -t 120 plus margin. */
const STOP_MS = (STOP_TIMEOUT_S + 60) * 1000;
const COPY_MS = 30 * 60_000;
const MAX_BACKUP_AGE_MS = 24 * 3600_000;

export interface Step {
  label: string;
  argv: string[];
  timeoutMs?: number;
}

export const stepText = (s: Step) => `${s.label}: ${s.argv.map(shellQuote).join(" ")}`;

/** sh -c wrapper for steps that need redirection. */
const sh = (script: string): string[] => ["sh", "-c", script];

export function dateStamp(d = new Date()): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

export const backupDirFor = (cfg: Pick<ArchiwareConfig, "backupDir">, date = new Date()) => `${cfg.backupDir}/archiware-update-${dateStamp(date)}`;

/** "repo:tag" -> "repo:tag-pre-update"; an image without tag gets "<image>:pre-update". */
export function preUpdateTag(image: string): string {
  const last = image.slice(image.lastIndexOf("/") + 1);
  return last.includes(":") ? `${image}-pre-update` : `${image}:pre-update`;
}

/** Steps up to and including the stop (image = result of docker inspect). */
export function backupSteps(cfg: ArchiwareConfig, image: string, dir: string, restart: boolean): Step[] {
  const c = cfg.container;
  const tag = preUpdateTag(image);
  const compose = cfg.composeDir.replace(/\/+$/, "");
  const parent = compose.slice(0, compose.lastIndexOf("/")) || "/";
  const steps: Step[] = [
    { label: "mkdir backup dir", argv: ["mkdir", "-p", dir] },
    { label: "docker inspect", argv: sh(`docker inspect ${shellQuote(c)} > ${shellQuote(`${dir}/inspect.json`)}`) },
    { label: "docker diff", argv: sh(`docker diff ${shellQuote(c)} > ${shellQuote(`${dir}/diff.txt`)}`) },
    { label: "docker commit", argv: ["docker", "commit", c, tag], timeoutMs: COPY_MS },
    { label: "docker save", argv: ["docker", "save", "-o", `${dir}/image.tar`, tag], timeoutMs: COPY_MS },
    { label: "docker stop", argv: ["docker", "stop", "-t", String(STOP_TIMEOUT_S), c], timeoutMs: STOP_MS },
    { label: "tar compose dir (cold copy)", argv: ["tar", "-C", parent, "-cf", `${dir}/compose.tar`, basename(compose)], timeoutMs: COPY_MS },
    { label: "sha256sum", argv: sh(`cd ${shellQuote(dir)} && sha256sum image.tar compose.tar > SHA256SUMS`), timeoutMs: COPY_MS },
    { label: "verify checksums", argv: sh(`cd ${shellQuote(dir)} && sha256sum -c SHA256SUMS`), timeoutMs: COPY_MS },
    { label: "verify sizes", argv: sh(`cd ${shellQuote(dir)} && stat -c '%n %s' image.tar compose.tar inspect.json diff.txt`) },
  ];
  if (restart) steps.push({ label: "docker start", argv: ["docker", "start", c] });
  return steps;
}

/** Sizes from `stat -c '%n %s'` output; throws if a tar is missing or empty. */
export function checkSizes(out: string): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const l of out.trim().split("\n")) {
    const m = l.trim().match(/^(\S+) (\d+)$/);
    if (m) sizes[m[1]] = Number(m[2]);
  }
  for (const f of ["image.tar", "compose.tar"]) {
    if (!(sizes[f] > 0)) throw new P5Error(`backup verification failed: ${f} missing or empty`);
  }
  return sizes;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** Pure: ids of jobs in a running state (waiting/scheduled jobs do not block). */
export function runningJobIds(rows: Record<string, unknown>[]): string[] {
  return rows.filter((r) => String(r.status) === "running").map((r) => String(r.id));
}

export function refuseIfJobsRunning(ids: string[], force: boolean, what: string): void {
  if (ids.length > 0 && !force) {
    throw new P5Error(`refusing to ${what}: P5 job(s) ${ids.join(", ")} running; wait, cancel them (job_cancel) or pass force/--force`);
  }
}

async function runningJobs(cfg: ArchiwareConfig): Promise<string[]> {
  return preferRest(
    cfg,
    async (c) => runningJobIds(await restJobs(c)),
    async () => chatNames(cfg, ["Job", "running"]),
  );
}

export interface BackupStamp {
  name: string;
  mtimeMs: number;
  hasSums: boolean;
}

/** Pure: is there a backup dir (with SHA256SUMS) newer than 24 h? */
export function recentBackup(stamps: BackupStamp[], nowMs: number): BackupStamp | null {
  return stamps.filter((s) => s.hasSums && nowMs - s.mtimeMs <= MAX_BACKUP_AGE_MS).sort((a, b) => b.mtimeMs - a.mtimeMs)[0] ?? null;
}

/** Lists archiware-update-* dirs: `stat -c '%Y %n'` of the SHA256SUMS files. */
export function listBackupsArgv(cfg: Pick<ArchiwareConfig, "backupDir">): string[] {
  return sh(`stat -c '%Y %n' ${shellQuote(cfg.backupDir)}/archiware-update-*/SHA256SUMS 2>/dev/null || true`);
}

export function parseBackupStamps(out: string): BackupStamp[] {
  return out
    .trim()
    .split("\n")
    .map((l) => l.match(/^(\d+) (.+)\/SHA256SUMS$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => ({ name: m[2], mtimeMs: Number(m[1]) * 1000, hasSums: true }));
}

async function host(cfg: ArchiwareConfig, step: Step): Promise<string> {
  const r = await hostCommand(cfg, step.argv, step.timeoutMs ?? 60_000);
  if (r.rc !== 0) throw new P5Error(`step failed (exit ${r.rc}): ${step.label}`, r.stderr);
  return r.stdout;
}

async function srvinfoVersion(cfg: ArchiwareConfig): Promise<string | null> {
  try {
    return String(((await restGet({ ...cfg, restTimeoutMs: 5000 }, "/rest/v1/general/srvinfo")) as { lexxvers?: string }).lexxvers ?? "") || null;
  } catch {
    return null;
  }
}

/** Wait until srvinfo answers (REST); returns the version or null on timeout. */
export async function waitForSrvinfo(cfg: ArchiwareConfig, timeoutMs: number, progress: Progress = noProgress): Promise<string | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await srvinfoVersion(cfg);
    if (v) return v;
    progress(`waiting for P5 to answer (${Math.round((Date.now() - t0) / 1000)}s)`);
    await sleep(10_000);
  }
  return null;
}

/** container_* tools only apply when P5 runs in a docker container. */
export const notApplicable = (cfg: Pick<ArchiwareConfig, "mode">) => ({
  notApplicable: true as const,
  confirmationRequired: false as const,
  note: `container_* tools only apply in docker mode; this config uses mode "${cfg.mode}".`,
});
const dockerOnly = (cfg: Pick<ArchiwareConfig, "mode">) => cfg.mode !== "docker";

const dry = (steps: string[], note: string) => ({ confirmationRequired: true as const, wouldRun: steps, note });

// ---------------------------------------------------------------------------
// status / stop / start
// ---------------------------------------------------------------------------

export async function containerStatus(cfg: ArchiwareConfig) {
  if (dockerOnly(cfg)) return notApplicable(cfg);
  const r = await hostCommand(cfg, ["docker", "inspect", "-f", "{{.State.Status}}|{{.State.StartedAt}}|{{.Config.Image}}", cfg.container], 20_000);
  if (r.rc !== 0) throw new P5Error(`docker inspect ${cfg.container} failed`, r.stderr);
  const [state, startedAt, image] = r.stdout.trim().split("|");
  const lexxvers = state === "running" ? await srvinfoVersion(cfg) : null;
  const stamps = parseBackupStamps((await hostCommand(cfg, listBackupsArgv(cfg), 20_000)).stdout);
  const last = stamps.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  return {
    container: cfg.container,
    state,
    startedAt,
    image,
    p5Version: lexxvers,
    lastBackup: last ? { dir: last.name, at: new Date(last.mtimeMs).toISOString() } : null,
  };
}

export async function containerStop(cfg: ArchiwareConfig, confirm: boolean, force = false, progress: Progress = noProgress) {
  if (dockerOnly(cfg)) return notApplicable(cfg);
  const step: Step = { label: "docker stop", argv: ["docker", "stop", "-t", String(STOP_TIMEOUT_S), cfg.container], timeoutMs: STOP_MS };
  if (!confirm) return dry(["check no P5 job is running (REST general/jobs)", stepText(step)], `Stops container ${cfg.container}; refused while jobs run unless force.`);
  refuseIfJobsRunning(await runningJobs(cfg), force, "stop the container");
  progress("docker stop (up to 120 s)");
  await host(cfg, step);
  return { confirmationRequired: false as const, container: cfg.container, stopped: true };
}

export async function containerStart(cfg: ArchiwareConfig, confirm: boolean, progress: Progress = noProgress, waitMs = 300_000) {
  if (dockerOnly(cfg)) return notApplicable(cfg);
  const step: Step = { label: "docker start", argv: ["docker", "start", cfg.container] };
  if (!confirm) return dry([stepText(step), `wait up to ${waitMs / 1000}s for REST general/srvinfo`], `Starts container ${cfg.container} and waits until P5 answers.`);
  progress("docker start");
  await host(cfg, step);
  const v = await waitForSrvinfo(cfg, waitMs, progress);
  return { confirmationRequired: false as const, container: cfg.container, started: true, p5Version: v, answers: v !== null };
}

// ---------------------------------------------------------------------------
// backup
// ---------------------------------------------------------------------------

export async function containerBackup(cfg: ArchiwareConfig, confirm: boolean, opts: { force?: boolean; restart?: boolean } = {}, progress: Progress = noProgress) {
  if (dockerOnly(cfg)) return notApplicable(cfg);
  const dir = backupDirFor(cfg);
  if (!confirm) {
    const r = await hostCommand(cfg, ["docker", "inspect", "-f", "{{.Config.Image}}", cfg.container], 20_000).catch(() => null);
    const image = r && r.rc === 0 && r.stdout.trim() ? r.stdout.trim() : "<image from docker inspect>";
    return dry(
      ["check no P5 job is running", ...backupSteps(cfg, image, dir, Boolean(opts.restart)).map(stepText)],
      `Cold backup of container ${cfg.container} into ${dir}. The container is STOPPED by this and ${opts.restart ? "started again at the end" : "left stopped (use restart:true to start it again)"}.`,
    );
  }
  refuseIfJobsRunning(await runningJobs(cfg), Boolean(opts.force), "back up (stops the container)");
  const image = (await host(cfg, { label: "image name", argv: ["docker", "inspect", "-f", "{{.Config.Image}}", cfg.container] })).trim();
  if (!image) throw new P5Error("could not determine the container image");
  const steps = backupSteps(cfg, image, dir, Boolean(opts.restart));
  const done: string[] = [];
  let sizes: Record<string, number> = {};
  for (const [i, s] of steps.entries()) {
    progress(`[${i + 1}/${steps.length}] ${s.label}`);
    const out = await host(cfg, s);
    if (s.label === "verify sizes") sizes = checkSizes(out);
    done.push(s.label);
  }
  return {
    confirmationRequired: false as const,
    dir,
    image,
    committedTag: preUpdateTag(image),
    sizes,
    steps: done,
    containerState: opts.restart ? "started again" : "STOPPED (start with container_start)",
  };
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

export function sha256Local(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Remote paths used by update. */
export function updatePaths(debName: string) {
  return { hostDeb: `/tmp/${debName}`, containerDeb: `/tmp/${debName}` };
}

export function validDebName(name: string): boolean {
  return /^[A-Za-z0-9._+-]+\.deb$/.test(name);
}

export function updateSteps(cfg: ArchiwareConfig, debName: string): Step[] {
  const { hostDeb, containerDeb } = updatePaths(debName);
  const c = cfg.container;
  return [
    { label: "scp .deb to host", argv: ["scp", "<local .deb>", `${cfg.sshHost}:${hostDeb}`] },
    { label: "sha256 on host", argv: ["sha256sum", hostDeb] },
    { label: "docker cp into container", argv: ["docker", "cp", hostDeb, `${c}:${containerDeb}`] },
    { label: "show package version", argv: ["docker", "exec", c, "dpkg-deb", "-I", containerDeb] },
    { label: "install", argv: ["docker", "exec", c, "dpkg", "-i", containerDeb], timeoutMs: COPY_MS },
  ];
}

export async function containerUpdate(
  cfg: ArchiwareConfig,
  debPath: string,
  confirm: boolean,
  opts: { skipBackupCheck?: boolean; force?: boolean } = {},
  progress: Progress = noProgress,
) {
  if (dockerOnly(cfg)) return notApplicable(cfg);
  const debName = basename(debPath);
  if (!validDebName(debName)) throw new P5Error(`not a plain .deb file name: ${debName}`);
  const steps = updateSteps(cfg, debName);
  if (!confirm) {
    return dry(
      [
        opts.skipBackupCheck ? "(backup check skipped)" : `require a backup newer than 24 h with SHA256SUMS under ${cfg.backupDir}/archiware-update-*`,
        "check no P5 job is running",
        "compute local sha256 of the .deb",
        ...steps.map(stepText),
        "wait for P5 to answer, report new lexxvers and Error lines in the log after the install",
      ],
      `Installs ${debName} into container ${cfg.container}. The container must be running.`,
    );
  }
  try {
    statSync(debPath);
  } catch {
    throw new P5Error(`no such file: ${debPath}`);
  }
  if (!opts.skipBackupCheck) {
    const stamps = parseBackupStamps((await hostCommand(cfg, listBackupsArgv(cfg), 20_000)).stdout);
    if (!recentBackup(stamps, Date.now())) {
      throw new P5Error(`refusing to update: no backup newer than 24 h with SHA256SUMS in ${cfg.backupDir}; run container_backup first or pass skipBackupCheck`);
    }
  }
  refuseIfJobsRunning(await runningJobs(cfg), Boolean(opts.force), "update");
  const state = (await host(cfg, { label: "state", argv: ["docker", "inspect", "-f", "{{.State.Status}}", cfg.container] })).trim();
  if (state !== "running") throw new P5Error(`container ${cfg.container} is ${state}; start it first (container_start)`);
  const before = await srvinfoVersion(cfg);

  const { hostDeb, containerDeb } = updatePaths(debName);
  const localSum = sha256Local(debPath);
  progress(`[1/5] copying ${debName} to ${cfg.sshHost}`);
  const { execFile } = await import("node:child_process");
  await new Promise<void>((res, rej) =>
    execFile("scp", ["-q", debPath, `${cfg.sshHost}:${hostDeb}`], { timeout: COPY_MS }, (e) => (e ? rej(new P5Error(`scp failed: ${e.message}`)) : res())),
  );
  progress("[2/5] verifying sha256 on host");
  const remoteSum = (await host(cfg, steps[1])).trim().split(/\s+/)[0];
  if (remoteSum !== localSum) throw new P5Error(`sha256 mismatch after copy: local ${localSum}, host ${remoteSum}`);
  progress("[3/5] docker cp");
  await host(cfg, steps[2]);
  progress("[4/5] package info");
  const info = await host(cfg, steps[3]);
  const pkgVersion = info.match(/^\s*Version:\s*(\S+)/m)?.[1] ?? null;
  progress(`[5/5] dpkg -i (package version ${pkgVersion ?? "?"})`);
  const inst = await hostCommand(cfg, steps[4].argv, COPY_MS);
  progress("waiting for P5 to answer");
  const after = await waitForSrvinfo(cfg, 600_000, progress);
  const tail = cfg.logPath ? await hostCommand(cfg, ["tail", "-n", "300", cfg.logPath], 20_000) : { rc: 1, stdout: "", stderr: "" };
  const errors = tail.rc === 0 ? tail.stdout.split("\n").filter((l) => /\bError\b/.test(l)).slice(-10) : [];
  return {
    confirmationRequired: false as const,
    deb: debName,
    sha256: localSum,
    packageVersion: pkgVersion,
    versionBefore: before,
    versionAfter: after,
    dpkgExit: inst.rc,
    dpkgOutputTail: (inst.stdout + inst.stderr).trim().split("\n").slice(-8).join("\n"),
    logErrorLines: errors,
  };
}
