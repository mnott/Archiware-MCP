/**
 * P5 REST client (P5 8.x): https://<container>:8443/rest/v1/...
 *
 * curl runs on the P5 host (over ssh, or locally in local mode; in docker
 * mode the container IP is reachable from the docker host). The credentials and the request body travel on curl's stdin as a
 * curl config (`curl -K -`), never in argv, so they show up in no process list
 * and no log. The password file is read locally at call time only.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ArchiwareConfig } from "./config.js";
import { launch, P5Error, shellQuote } from "./transport.js";

export type RestMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface RestResponse {
  status: number;
  /** Parsed JSON, or the raw text when the body is not JSON, or null when empty. */
  body: unknown;
}

/** Escape a value for a curl config file double-quoted string. */
export function curlConfigQuote(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

/**
 * Validate and normalise a user-supplied REST path. Accepts "general/jobs",
 * "/general/jobs" or "/rest/v1/general/jobs" (+ optional ?query). Anything that
 * would leave /rest/v1 is rejected.
 */
export function normalizeRestPath(input: string): string {
  const raw = input.trim();
  if (raw === "") throw new P5Error("REST path is empty");
  if (/[\s\x00-\x1f\x7f#\\]/.test(raw)) throw new P5Error(`REST path has forbidden characters: ${JSON.stringify(raw)}`);
  const qi = raw.indexOf("?");
  const pathPart = qi === -1 ? raw : raw.slice(0, qi);
  const query = qi === -1 ? "" : raw.slice(qi);
  if (/%2e|%2f|%5c/i.test(pathPart)) throw new P5Error(`REST path has encoded dot/slash: ${raw}`);
  const segs = pathPart.split("/").filter((s, i, a) => !(s === "" && (i === 0 || i === a.length - 1)));
  if (segs.some((s) => s === "" || s === "." || s === "..")) throw new P5Error(`REST path must not contain empty, "." or ".." segments: ${raw}`);
  let rest = segs;
  if (segs[0] === "rest") {
    if (segs[1] !== "v1") throw new P5Error(`REST path must be under /rest/v1: ${raw}`);
    rest = segs.slice(2);
  } else if (/^v\d+$/.test(segs[0] ?? "") && segs[0] !== "v1") {
    throw new P5Error(`REST path must be under /rest/v1: ${raw}`);
  } else if (segs[0] === "v1") {
    rest = segs.slice(1);
  }
  if (rest.length === 0) throw new P5Error("REST path names no resource below /rest/v1 (use rest_resources to list them)");
  if (query.includes("..")) throw new P5Error(`REST query must not contain "..": ${raw}`);
  return `/rest/v1/${rest.join("/")}${query}`;
}

export interface CurlRequest {
  /** Arguments after `curl`; contains no credentials and no body. */
  argv: string[];
  /** curl config fed on stdin: credentials, headers, body. */
  stdin: string;
}

const STATUS_MARK = "\n\x1e";

/** Pure: build the curl invocation. `password` goes to stdin only. */
export function buildCurl(
  cfg: Pick<ArchiwareConfig, "restUrl" | "restUser" | "restTimeoutMs">,
  method: RestMethod,
  path: string,
  password: string,
  body?: unknown,
): CurlRequest {
  const secs = Math.max(1, Math.ceil(cfg.restTimeoutMs / 1000));
  const url = path === "/rest" ? `${cfg.restUrl}/rest` : `${cfg.restUrl}${path}`;
  const argv = [
    "-sS",
    "-k",
    "--connect-timeout",
    String(Math.min(secs, 10)),
    "--max-time",
    String(secs),
    "-X",
    method,
    "-w",
    `${STATUS_MARK}%{http_code}`,
    "-K",
    "-",
    url,
  ];
  const lines = [`user = ${curlConfigQuote(`${cfg.restUser}:${password}`)}`, `header = ${curlConfigQuote("Accept: application/json")}`];
  if (body !== undefined) {
    lines.push(`header = ${curlConfigQuote("Content-Type: application/json")}`);
    lines.push(`data = ${curlConfigQuote(typeof body === "string" ? body : JSON.stringify(body))}`);
  }
  return { argv, stdin: lines.join("\n") + "\n" };
}

/** Remote shell string for ssh: curl with every argument quoted. */
export function buildRemoteCurl(argv: string[]): string {
  return ["curl", ...argv].map(shellQuote).join(" ");
}

/** Human-readable description of a request, with no credentials. */
export function describeRequest(cfg: Pick<ArchiwareConfig, "restUrl" | "restUser">, method: RestMethod, path: string, body?: unknown): string {
  return `${method} ${cfg.restUrl}${path}${body !== undefined ? ` body=${typeof body === "string" ? body : JSON.stringify(body)}` : ""}`;
}

export function readPassword(file: string): string {
  let pw: string;
  try {
    pw = readFileSync(file, "utf8").replace(/\r?\n$/, "");
  } catch {
    throw new P5Error(`cannot read REST password file ${file}`);
  }
  if (pw === "") throw new P5Error(`REST password file ${file} is empty`);
  return pw;
}

/** Split curl output into body and the trailing HTTP status. */
export function parseCurlOutput(stdout: string): RestResponse {
  const i = stdout.lastIndexOf(STATUS_MARK);
  if (i === -1) throw new P5Error("REST: no HTTP status in curl output");
  const status = Number(stdout.slice(i + STATUS_MARK.length).trim());
  const text = stdout.slice(0, i);
  let body: unknown = null;
  if (text.trim() !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status, body };
}

/** Log of every request actually sent (method + path), for audit in tests/proofs. */
export const restLog: string[] = [];

/** Run one REST request. Throws P5Error on transport failure, timeout or HTTP >= 400. */
export async function restCall(
  cfg: ArchiwareConfig,
  method: RestMethod,
  path: string,
  body?: unknown,
  opts: { allowHttpError?: boolean } = {},
): Promise<RestResponse> {
  const pw = readPassword(cfg.restPasswordFile);
  const req = buildCurl(cfg, method, path, pw, body);
  const remote = buildRemoteCurl(req.argv);
  const hardMs = cfg.restTimeoutMs + 10_000;
  restLog.push(`${method} ${path}`);
  const stdout = await new Promise<string>((resolve, reject) => {
    const l = launch(cfg, remote);
    const child = spawn(l.cmd, l.args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let errText = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new P5Error(`REST ${method} ${path} timed out after ${Math.round(hardMs / 1000)}s`));
    }, hardMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errText += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new P5Error(`${l.cmd} failed: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.includes(STATUS_MARK)) {
        const msg = errText.replaceAll(pw, "***").trim();
        reject(new P5Error(`REST ${method} ${path} failed (curl/ssh exit ${code})`, msg));
      } else resolve(out);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(req.stdin);
  });
  const res = parseCurlOutput(stdout);
  if (res.status >= 400 && !opts.allowHttpError) {
    const detail = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
    throw new P5Error(`REST ${method} ${path} -> HTTP ${res.status}`, detail?.slice(0, 500));
  }
  return res;
}

export const restGet = (cfg: ArchiwareConfig, path: string) => restCall(cfg, "GET", path).then((r) => r.body);
export const restPost = (cfg: ArchiwareConfig, path: string, body?: unknown) => restCall(cfg, "POST", path, body);
export const restPut = (cfg: ArchiwareConfig, path: string, body?: unknown) => restCall(cfg, "PUT", path, body);
export const restDelete = (cfg: ArchiwareConfig, path: string) => restCall(cfg, "DELETE", path);

// ---------------------------------------------------------------------------
// Tool-level operations
// ---------------------------------------------------------------------------

export const restResources = (cfg: ArchiwareConfig) => restCall(cfg, "GET", "/rest").then((r) => r.body);

/**
 * `rest` tool: GET runs directly; POST/PUT/DELETE only run with confirm,
 * otherwise the request that WOULD be sent is returned.
 */
export async function restRequest(cfg: ArchiwareConfig, method: RestMethod, rawPath: string, body: unknown, confirm: boolean) {
  const path = normalizeRestPath(rawPath);
  if (method === "GET") {
    const r = await restCall(cfg, "GET", path);
    return { status: r.status, body: r.body };
  }
  if (!confirm) {
    return {
      confirmationRequired: true as const,
      wouldRun: [describeRequest(cfg, method, path, body)],
      note: `Sends a ${method} to the P5 REST API; nothing was sent.`,
    };
  }
  const r = await restCall(cfg, method, path, body);
  return { confirmationRequired: false as const, status: r.status, body: r.body };
}
