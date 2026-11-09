/**
 * Transport: run nsdchat on the P5 host (docker exec in a container, native
 * install over ssh, or locally) and read the tape library via mtx on the host.
 *
 * Three modes (cfg.mode): "docker" = ssh <host> docker exec <container> nsdchat;
 * "ssh" = ssh <host> <p5Home>/bin/nsdchat; "local" = sh -c <p5Home>/bin/nsdchat.
 * Every remote command is one shell string; launch() decides ssh or local sh.
 *
 * ssh joins its argv into ONE string that the remote login shell (zsh, say)
 * re-parses, so every argument is single-quoted for a POSIX/zsh shell
 * (shellQuote) and the remote command is passed as a single execFile argument.
 *
 * `nsdchat -f <file>` and stdin are never used: they hang and wedge the P5
 * CLI server. Only non-interactive `nsdchat -c` calls are made.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ArchiwareConfig } from "./config.js";

const execFileAsync = promisify(execFile);

/** Quote one argument for a POSIX/zsh shell (single quotes, escape embedded '). */
export function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** Process to start for one shell string on the P5 host: ssh <host> '<cmd>' or, in local mode, sh -c '<cmd>'. */
export function launch(cfg: Pick<ArchiwareConfig, "mode" | "sshHost">, remote: string): { cmd: string; args: string[] } {
  return cfg.mode === "local" ? { cmd: "sh", args: ["-c", remote] } : { cmd: "ssh", args: [cfg.sshHost, remote] };
}

/** Text form of launch() for "would run" output. */
export function describeRemote(cfg: Pick<ArchiwareConfig, "mode" | "sshHost">, remote: string): string {
  return cfg.mode === "local" ? remote : `ssh ${cfg.sshHost} ${remote}`;
}

/** argv to run a command in P5's own filesystem: inside the container in docker mode, directly on the host otherwise. */
export function p5Exec(cfg: Pick<ArchiwareConfig, "mode" | "container">, argv: string[]): string[] {
  return cfg.mode === "docker" ? ["docker", "exec", cfg.container, ...argv] : argv;
}

export class P5Error extends Error {
  constructor(
    message: string,
    readonly stderr?: string,
  ) {
    super(message);
    this.name = "P5Error";
  }
}

/** Remote command string for one nsdchat call: [docker exec <c>] <nsdchat> -c <args...>. */
export function buildRemoteCommand(cfg: ArchiwareConfig, args: string[]): string {
  return p5Exec(cfg, [cfg.nsdchat, "-c", ...args]).map(shellQuote).join(" ");
}

/**
 * Parse a Tcl list: whitespace-separated elements, {braced} elements (nesting
 * kept inside, outer braces stripped), "quoted" elements, backslash escapes.
 * "<empty>" and "" parse to [].
 */
export function parseTclList(s: string | null | undefined): string[] {
  if (s == null) return [];
  const t = s.trim();
  if (t === "" || t === "<empty>") return [];
  const out: string[] = [];
  let i = 0;
  const n = t.length;
  while (i < n) {
    while (i < n && /\s/.test(t[i])) i++;
    if (i >= n) break;
    let el = "";
    if (t[i] === "{") {
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const c = t[i];
        if (c === "\\" && i + 1 < n) {
          el += c + t[i + 1];
          i += 2;
          continue;
        }
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        el += c;
        i++;
      }
    } else if (t[i] === '"') {
      i++;
      while (i < n && t[i] !== '"') {
        if (t[i] === "\\" && i + 1 < n) {
          el += t[i + 1];
          i += 2;
        } else el += t[i++];
      }
      i++;
    } else {
      while (i < n && !/\s/.test(t[i])) {
        if (t[i] === "\\" && i + 1 < n) {
          el += t[i + 1];
          i += 2;
        } else el += t[i++];
      }
    }
    out.push(el);
  }
  return out;
}

export interface CallResult {
  rc: number;
  out: string;
}

const RECORD = /\x1e(\d+)\x1e\n/;
const MAX_BATCH = 40;

/**
 * nsdchat is not safe for concurrent use (two simultaneous calls fail with
 * "can't create communication pipes ... .rcli.0: file already exists", exit 10).
 * Every call therefore runs under an exclusive flock on the P5 host, so separate
 * CLI/MCP processes and sessions serialise. Without flock on the host the call runs unlocked.
 */
export const LOCK_FILE = "/tmp/archiware-mcp-nsdchat.lock";
export const LOCK_WAIT_S = 120;
export const LOCK_TIMEOUT_RC = 99;
const lockFn = (waitS: number) => `l(){ if command -v flock >/dev/null 2>&1; then flock -w ${waitS} -E ${LOCK_TIMEOUT_RC} ${LOCK_FILE} "$@"; else "$@"; fi; }`;
/** Lock wait in seconds: config `lockWaitS`, default LOCK_WAIT_S. */
export const lockWait = (cfg: ArchiwareConfig): number => (cfg.lockWaitS > 0 ? cfg.lockWaitS : LOCK_WAIT_S);

/** Remote shell string for a batch: one non-interactive `nsdchat -c` per command (under the host lock), each followed by a record carrying its exit code. */
export function buildBatchCommand(cfg: ArchiwareConfig, commands: string[][]): string {
  return (
    lockFn(lockWait(cfg)) +
    "; " +
    commands.map((c) => `l ${buildRemoteCommand(cfg, c)} 2>&1; printf '\\036%s\\036\\n' "$?"`).join("; ")
  );
}

/** exit 10 with P5's pipe-collision message: another nsdchat ran at the same moment. */
export const isPipeCollision = (r: CallResult): boolean => r.rc === 10 && /communication pipes/.test(r.out);
const RETRY_BACKOFF_MS = [500, 1500, 3000, 6000];

/** Split batch stdout on the \x1e<rc>\x1e records into one { out, rc } per command. */
export function parseRecords(stdout: string, expected: number): CallResult[] {
  const results: CallResult[] = [];
  let rest = stdout;
  for (let i = 0; i < expected; i++) {
    const m = RECORD.exec(rest);
    if (!m) throw new P5Error(`nsdchat batch: ${results.length} of ${expected} results`, stdout.trim());
    results.push({ rc: Number(m[1]), out: rest.slice(0, m.index).replace(/\n$/, "") });
    rest = rest.slice(m.index + m[0].length);
  }
  return results;
}

/**
 * Run nsdchat -c calls, at most MAX_BATCH per ssh call (P5's sshd drops
 * connections when hammered). No tty, no stdin: nsdchat is never fed input.
 */
export async function nsdchatCalls(
  cfg: ArchiwareConfig,
  commands: string[][],
  timeoutMs = cfg.timeoutMs,
): Promise<CallResult[]> {
  const all: CallResult[] = [];
  for (let i = 0; i < commands.length; i += MAX_BATCH) {
    const chunk = commands.slice(i, i + MAX_BATCH);
    const remote = buildBatchCommand(cfg, chunk);
    try {
      const l = launch(cfg, remote);
      const { stdout } = await execFileAsync(l.cmd, l.args, {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      });
      const res = parseRecords(stdout, chunk.length);
      for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt++) {
        const bad = res.map((r, k) => (isPipeCollision(r) ? k : -1)).filter((k) => k >= 0);
        if (bad.length === 0) break;
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt]));
        const l2 = launch(cfg, buildBatchCommand(cfg, bad.map((k) => chunk[k])));
        const again = parseRecords((await execFileAsync(l2.cmd, l2.args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 })).stdout, bad.length);
        bad.forEach((k, j) => (res[k] = again[j]));
      }
      all.push(...res);
    } catch (e) {
      if (e instanceof P5Error) throw e;
      const err = e as { killed?: boolean; stderr?: string; message?: string };
      const label = chunk.map((c) => c.join(" ")).join("; ");
      if (err.killed) throw new P5Error(`nsdchat timed out after ${Math.round(timeoutMs / 1000)}s: ${label}`);
      throw new P5Error(`${cfg.mode === "local" ? "command" : "ssh"} failed: ${err.message ?? "unknown error"}`, err.stderr?.trim());
    }
  }
  return all;
}

/**
 * "Long" mode for calls that legitimately take minutes (index lookups on big
 * volumes, inventories): same call, but the timeout is config `longTimeoutMs`
 * (default 600 s). One long call holds the host lock, so every other nsdchat
 * call (other sessions, the MCP) waits behind it by design: P5's CLI cannot
 * run in parallel. Keep normal calls short; use this only where needed.
 */
export async function nsdchatLong(cfg: ArchiwareConfig, args: string[]): Promise<string> {
  return nsdchat(cfg, args, cfg.longTimeoutMs);
}

/** Run a single nsdchat command; returns trimmed output, "" for empty results. Throws on error. */
export async function nsdchat(cfg: ArchiwareConfig, args: string[], timeoutMs = cfg.timeoutMs): Promise<string> {
  const [r] = await nsdchatCalls(cfg, [args], timeoutMs);
  return checked(args, r) ?? "";
}

function checked(args: string[], r: CallResult): string | null {
  const out = r.out.trim();
  if (r.rc === LOCK_TIMEOUT_RC && out === "") throw new P5Error(`nsdchat: gave up waiting ${LOCK_WAIT_S}s for the host lock ${LOCK_FILE} (another nsdchat session is busy): ${args.join(" ")}`);
  if (isPipeCollision(r)) throw new P5Error(`nsdchat kept colliding with another concurrent nsdchat call (exit 10) after retries: ${args.join(" ")}\n${out}`, out);
  if (r.rc !== 0) throw new P5Error(`nsdchat failed (exit ${r.rc}): ${args.join(" ")}\n${out}`, out);
  return out === "" || out === "<empty>" ? null : out;
}

export interface ChatRequest {
  args: string[];
  /** Result is a Tcl list; returned as string[] ([] for "<empty>"). */
  names?: boolean;
}

export type ChatResult = string | null | string[];

/** Run one batch and return raw results (multi-line output verbatim); throws on any failing command. */
export async function rawBatch(cfg: ArchiwareConfig, commands: string[][], timeoutMs = cfg.timeoutMs): Promise<(string | null)[]> {
  const rs = await nsdchatCalls(cfg, commands, timeoutMs);
  return rs.map((r, i) => checked(commands[i], r));
}

export async function chatBatch(cfg: ArchiwareConfig, requests: ChatRequest[], timeoutMs = cfg.timeoutMs): Promise<ChatResult[]> {
  const results = await rawBatch(cfg, requests.map((r) => r.args), timeoutMs);
  return requests.map((r, i): ChatResult => {
    const v = results[i];
    if (r.names) return parseTclList(v);
    return v;
  });
}

/** Run one CLI command and return its trimmed result ("<empty>" -> null). */
export async function chat(cfg: ArchiwareConfig, args: string[]): Promise<string | null> {
  const [v] = await chatBatch(cfg, [{ args }]);
  return v as string | null;
}

/** Tcl list of names, [] for "<empty>". */
export async function chatNames(cfg: ArchiwareConfig, args: string[]): Promise<string[]> {
  const [v] = await chatBatch(cfg, [{ args, names: true }]);
  return v as string[];
}

/** mtx talks to the robot and can take minutes while drives are busy. */
const MTX_TIMEOUT_MS = 240_000;

export interface HostResult {
  rc: number;
  stdout: string;
  stderr: string;
}

/**
 * Run one command on the P5 host (ssh, or sh locally; no docker): argv is shell-quoted and passed as
 * a single ssh argument, like every other remote call here. Never throws on a
 * non-zero exit — the caller decides what a failure means.
 */
export async function hostCommand(cfg: ArchiwareConfig, argv: string[], timeoutMs = MTX_TIMEOUT_MS): Promise<HostResult> {
  const remote = argv.map(shellQuote).join(" ");
  try {
    const l = launch(cfg, remote);
    const { stdout, stderr } = await execFileAsync(l.cmd, l.args, { timeout: timeoutMs });
    return { rc: 0, stdout, stderr: stderr ?? "" };
  } catch (e) {
    const err = e as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string; message?: string };
    if (err.killed) throw new P5Error(`host command timed out after ${Math.round(timeoutMs / 1000)}s: ${argv.join(" ")}`);
    const rc = typeof err.code === "number" ? err.code : 1;
    return { rc, stdout: err.stdout ?? "", stderr: (err.stderr ?? "").trim() || String(err.message ?? "unknown error") };
  }
}

/** Read tape library state via `sudo -n mtx -f <changer> status` on the host. */
export async function mtxStatus(cfg: ArchiwareConfig): Promise<string> {
  const r = await hostCommand(cfg, ["sudo", "-n", "mtx", "-f", cfg.changer, "status"]);
  if (r.rc !== 0) throw new P5Error(`mtx failed (exit ${r.rc}): sudo -n mtx -f ${cfg.changer} status`, r.stderr);
  return r.stdout;
}

/** Read the lexxsrv log block of a job ("Job          : <id>") from the host. */
export async function jobLogBlock(cfg: ArchiwareConfig, id: string, logPath: string): Promise<string | null> {
  const remote = ["grep", "-A60", "-E", `^Job +: ${id}$`, logPath].map(shellQuote).join(" ");
  try {
    const l = launch(cfg, remote);
    const { stdout } = await execFileAsync(l.cmd, l.args, { timeout: 30_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
