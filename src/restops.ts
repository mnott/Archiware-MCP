/**
 * REST-backed operations: REST-preferred reads (fallback nsdchat), job_cancel
 * and the `health` aggregate. See REST.md for the API findings.
 */

import type { ArchiwareConfig } from "./config.js";
import * as ops from "./operations.js";
import { restCall, restGet } from "./rest.js";
import { hostCommand, mtxStatus, nsdchat, P5Error } from "./transport.js";

const SHORT_REST_MS = 8_000;
/** Job states that are still active (not finished). */
export const ACTIVE_STATES = new Set(["running", "waiting", "pending", "scheduled"]);

type Obj = Record<string, any>;
const quick = (cfg: ArchiwareConfig): ArchiwareConfig => ({ ...cfg, restTimeoutMs: Math.min(cfg.restTimeoutMs, SHORT_REST_MS) });
const idsOf = (body: unknown, key: string): string[] => (((body as Obj)?.[key] ?? []) as Obj[]).map((x) => String(x.ID));
const enc = (s: string) => encodeURIComponent(s);

/** Run the REST variant; on any failure fall back to the nsdchat variant. */
export async function preferRest<T>(cfg: ArchiwareConfig, viaRest: (c: ArchiwareConfig) => Promise<T>, viaChat: () => Promise<T>): Promise<T> {
  try {
    return await viaRest(quick(cfg));
  } catch {
    return viaChat();
  }
}

async function restJobRow(cfg: ArchiwareConfig, id: string) {
  const j = (await restGet(cfg, `/rest/v1/general/jobs/${enc(id)}`)) as Obj;
  if (!j || j.status === undefined) throw new P5Error(`job ${id} unknown to REST`);
  return j;
}

export async function restStatus(cfg: ArchiwareConfig) {
  const get = (p: string) => restGet(cfg, `/rest/v1/${p}`);
  const [info, devs, jbs, poolList, jobList] = await Promise.all([get("general/srvinfo"), get("general/devices"), get("general/jukeboxes"), get("general/pools"), get("general/jobs")]);
  const poolNames = idsOf(poolList, "pools");
  const pools = await Promise.all(
    poolNames.map(async (name) => {
      const p = (await get(`general/pools/${enc(name)}`)) as Obj;
      const total = Number(p.totalsize ?? 0);
      const used = Number(p.usedsize ?? 0);
      return {
        name,
        usage: p.usage ?? null,
        mediatype: p.mediatype ?? null,
        usedsize_kb: used,
        totalsize_kb: total,
        usedsize_human: ops.kbToHuman(used),
        totalsize_human: total > 0 ? ops.kbToHuman(total) : "unlimited/unknown",
        usedPercent: total > 0 ? Math.round((used / total) * 100) : null,
      };
    }),
  );
  const jobs: Obj[] = [];
  for (const id of idsOf(jobList, "jobs")) {
    const j = await restJobRow(cfg, id);
    jobs.push({ id, status: j.status ?? null, label: j.label ?? null, resource: j.resourcename ?? null });
  }
  return { server: { version: (info as Obj).lexxvers ?? null }, devices: idsOf(devs, "devices"), jukeboxes: idsOf(jbs, "jukeboxes"), pools, jobs };
}

export const status = (cfg: ArchiwareConfig) => preferRest(cfg, restStatus, () => ops.status(cfg));

/** Jobs from REST (active ones). all=true needs the 7-day completed list, which only nsdchat has. */
export async function restJobs(cfg: ArchiwareConfig) {
  const list = await restGet(cfg, "/rest/v1/general/jobs");
  const rows: Obj[] = [];
  for (const id of idsOf(list, "jobs")) {
    const j = await restJobRow(cfg, id);
    rows.push({ id, label: j.label ?? null, status: j.status ?? null, completion: j.completion ?? null, report_last_lines: null });
  }
  return rows;
}

export const jobs = (cfg: ArchiwareConfig, all = false) => (all ? ops.jobs(cfg, true) : preferRest(cfg, restJobs, () => ops.jobs(cfg, false)));

/** One job: fields from REST; report/protocol are not in the REST job and come from nsdchat/log (best effort). */
export async function job(cfg: ArchiwareConfig, id: string) {
  let j: Obj;
  try {
    j = await restJobRow(quick(cfg), id);
  } catch {
    return ops.job(cfg, id);
  }
  const base = await ops.job(cfg, id).catch(() => null);
  const kb = j.totalkbytes === undefined ? null : Number(j.totalkbytes);
  return {
    id,
    label: j.label ?? null,
    status: j.status ?? null,
    completion: j.completion ?? null,
    describe: j.description ?? null,
    resourcegroup: j.resourcegroup ?? null,
    resourcename: j.resourcename ?? null,
    runat: j.runat ?? null,
    totalkbytes: kb,
    totalkbytes_human: kb ? ops.kbToHuman(kb) : null,
    totalfiles: j.totalfiles === undefined ? null : Number(j.totalfiles),
    report: base?.report ?? null,
    protocol: base?.protocol ?? null,
  };
}

// ---------------------------------------------------------------------------
// job_cancel
// ---------------------------------------------------------------------------

export function assertJobId(id: string): void {
  if (!/^\d+$/.test(id)) throw new P5Error("job id must be numeric");
}

/**
 * Cancel a running or waiting job. Primary: DELETE /rest/v1/general/jobs/<id>.
 * If the job is still active afterwards, fall back to nsdchat (`Job <id> cancel`
 * for a running job, `Job <id> stop` for a waiting/scheduled one). The state is
 * re-read via REST and reported either way.
 */
export function cancelPlan(cfg: ArchiwareConfig, id: string): string[] {
  assertJobId(id);
  return [
    `GET ${cfg.restUrl}/rest/v1/general/jobs/${id}  (state before)`,
    `DELETE ${cfg.restUrl}/rest/v1/general/jobs/${id}`,
    `GET ${cfg.restUrl}/rest/v1/general/jobs/${id}  (verify, up to 3 polls)`,
    `if still active: nsdchat Job ${id} cancel (running) | Job ${id} stop (waiting/scheduled)`,
  ];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * State of a job after a cancel. REST answers 404 for a job that is no longer active
 * (a canceled job disappears from /general/jobs), so then the authoritative state is
 * nsdchat `Job <id> status` ("cancelled") and `completion` ("exception").
 */
async function stateAfter(cfg: ArchiwareConfig, id: string): Promise<{ status: string; completion: string | null }> {
  try {
    const r = await restJobRow(cfg, id);
    return { status: String(r.status), completion: r.completion === undefined ? null : String(r.completion) };
  } catch {
    const [st, co] = await Promise.all([nsdchat(cfg, ["Job", id, "status"]).catch(() => "unknown"), nsdchat(cfg, ["Job", id, "completion"]).catch(() => "")]);
    return { status: st || "unknown", completion: co || null };
  }
}

export async function jobCancel(cfg: ArchiwareConfig, id: string, confirm: boolean) {
  assertJobId(id);
  if (!confirm) {
    return { confirmationRequired: true as const, wouldRun: cancelPlan(cfg, id), note: `Cancels job ${id} (running or waiting); the state is verified afterwards.` };
  }
  const before = await restJobRow(cfg, id);
  if (!ACTIVE_STATES.has(String(before.status))) {
    return { confirmationRequired: false as const, job: id, before: before.status, after: before.status, via: "none", note: "job is not active; nothing to cancel" };
  }
  let via = "rest";
  let restError: string | null = null;
  try {
    await restCall(cfg, "DELETE", `/rest/v1/general/jobs/${enc(id)}`);
  } catch (e) {
    restError = e instanceof Error ? e.message : String(e);
  }
  let after = before.status as string;
  let completion: string | null = null;
  for (let i = 0; i < 3; i++) {
    await sleep(i === 0 ? 1000 : 3000);
    ({ status: after, completion } = await stateAfter(cfg, id));
    if (!ACTIVE_STATES.has(after)) break;
  }
  if (ACTIVE_STATES.has(after) || after === "unknown") {
    const verb = before.status === "running" ? "cancel" : "stop";
    via = `nsdchat Job ${id} ${verb}`;
    await nsdchat(cfg, ["Job", id, verb]).catch((e) => {
      restError = `${restError ?? ""}; nsdchat: ${(e as Error).message}`;
    });
    await sleep(3000);
    ({ status: after, completion } = await stateAfter(cfg, id));
  }
  return { confirmationRequired: false as const, job: id, before: before.status, after, completion, via, canceled: !ACTIVE_STATES.has(after) && after !== "unknown", restError };
}

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

export type Level = "ok" | "warn" | "fail";
export interface HealthCheck {
  name: string;
  level: Level;
  reason: string;
}

export const worst = (checks: HealthCheck[]): Level => (checks.some((c) => c.level === "fail") ? "fail" : checks.some((c) => c.level === "warn") ? "warn" : "ok");
/** CLI exit code: non-zero on any fail (warn is exit 0). */
export const healthExitCode = (checks: HealthCheck[]): number => (checks.some((c) => c.level === "fail") ? 1 : 0);

/** df -P line -> { mount, freePercent }. */
export function parseDf(out: string): { mount: string; freePercent: number } | null {
  const line = out.trim().split("\n").pop() ?? "";
  const f = line.trim().split(/\s+/);
  if (f.length < 6) return null;
  const total = Number(f[1]);
  const avail = Number(f[3]);
  if (!(total > 0)) return null;
  return { mount: f[5], freePercent: Math.round((avail / total) * 100) };
}

export function dfLevel(freePercent: number): Level {
  return freePercent < 5 ? "fail" : freePercent < 15 ? "warn" : "ok";
}

export function logErrorLines(tail: string): string[] {
  return tail.split("\n").filter((l) => /\bError\b/.test(l));
}

async function check(name: string, fn: () => Promise<{ level: Level; reason: string }>): Promise<HealthCheck> {
  try {
    return { name, ...(await fn()) };
  } catch (e) {
    return { name, level: "fail", reason: (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200) };
  }
}

export async function health(cfg: ArchiwareConfig): Promise<{ overall: Level; checks: HealthCheck[] }> {
  const q = quick(cfg);
  const checks: HealthCheck[] = [];
  let srv: Obj | null = null;

  checks.push(
    await check(cfg.mode === "docker" ? "container" : "p5host", async () => {
      if (cfg.mode !== "docker") {
        const t = await hostCommand(cfg, ["test", "-x", cfg.nsdchat], 20_000);
        return t.rc === 0 ? { level: "ok", reason: `${cfg.nsdchat} present (${cfg.mode} mode)` } : { level: "fail", reason: `${cfg.nsdchat} not executable on the P5 host${t.stderr ? `: ${t.stderr.split("\n")[0]}` : ""}` };
      }
      const r = await hostCommand(cfg, ["docker", "inspect", "-f", "{{.State.Status}} {{.State.StartedAt}}", cfg.container], 20_000);
      if (r.rc !== 0) return { level: "fail", reason: `docker inspect failed: ${r.stderr.split("\n")[0]}` };
      const [state, since] = r.stdout.trim().split(" ");
      return state === "running" ? { level: "ok", reason: `running since ${since}` } : { level: "fail", reason: `container state ${state}` };
    }),
  );
  checks.push(
    await check("rest", async () => {
      srv = (await restGet(q, "/rest/v1/general/srvinfo")) as Obj;
      return { level: "ok", reason: `REST answers at ${cfg.restUrl}` };
    }),
  );
  checks.push(
    await check("version", async () => {
      if (!srv) {
        const v = await nsdchat(cfg, ["srvinfo", "lexxvers"], 15_000);
        return { level: "warn", reason: `P5 ${v} (via nsdchat; REST down)` };
      }
      const s = Number(srv.uptime);
      const up = Number.isFinite(s) ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m` : "?";
      return { level: "ok", reason: `P5 ${srv.lexxvers}, uptime ${up}` };
    }),
  );
  checks.push(
    await check("nsdchat", async () => {
      const t0 = Date.now();
      const v = await nsdchat(cfg, ["srvinfo", "lexxvers"], 15_000);
      return { level: "ok", reason: `answers in ${Date.now() - t0} ms (${v})` };
    }),
  );
  checks.push(
    await check("jobs", async () => {
      const rows = await restJobs(q);
      const by: Record<string, number> = {};
      for (const r of rows) by[String(r.status)] = (by[String(r.status)] ?? 0) + 1;
      const run = by.running ?? 0;
      const wait = (by.waiting ?? 0) + (by.pending ?? 0);
      const txt = `${run} running, ${wait} waiting, ${by.scheduled ?? 0} scheduled`;
      return { level: wait > 0 ? "warn" : "ok", reason: txt };
    }),
  );
  checks.push(
    await check("drives", async () => {
      const devs = idsOf(await restGet(q, "/rest/v1/general/devices"), "devices");
      const jbs = idsOf(await restGet(q, "/rest/v1/general/jukeboxes"), "jukeboxes");
      const mtx = ops.parseMtx(await mtxStatus(cfg).catch(() => ""));
      const mtxTxt = mtx.drives ? `, library ${mtx.drives} drives/${mtx.slots} slots, loaded: ${mtx.driveStates.filter((d) => d.full).length}` : ", mtx unavailable";
      if (jbs.length === 0) return { level: "fail", reason: "no jukebox known to P5" };
      return { level: "ok", reason: `${devs.length} devices, ${jbs.length} jukebox${mtxTxt}` };
    }),
  );
  checks.push(
    await check("cleaning", async () => {
      const devs = idsOf(await restGet(q, "/rest/v1/general/devices"), "devices");
      const flagged: string[] = [];
      for (const d of devs) {
        const x = (await restGet(q, `/rest/v1/general/devices/${enc(d)}`)) as Obj;
        if (x.cleaning === true || x.cleaning === 1 || x.cleaning === "1") flagged.push(d);
      }
      return flagged.length ? { level: "warn", reason: `cleaning flag set on ${flagged.join(", ")}` } : { level: "ok", reason: "no drive flagged for cleaning" };
    }),
  );
  for (const p of cfg.healthPaths) {
    checks.push(
      await check(`disk ${p}`, async () => {
        const r = await hostCommand(cfg, ["df", "-P", p], 20_000);
        const d = r.rc === 0 ? parseDf(r.stdout) : null;
        if (!d) return { level: "fail", reason: `df failed for ${p}` };
        return { level: dfLevel(d.freePercent), reason: `${d.freePercent}% free on ${d.mount}` };
      }),
    );
  }
  checks.push(
    await check("log", async () => {
      if (!cfg.logPath) return { level: "ok", reason: "no logPath configured (skipped)" };
      const r = await hostCommand(cfg, ["tail", "-n", "500", cfg.logPath], 20_000);
      if (r.rc !== 0) return { level: "warn", reason: `cannot read ${cfg.logPath}` };
      const errs = logErrorLines(r.stdout);
      return errs.length ? { level: "warn", reason: `${errs.length} Error line(s) in last 500, latest: ${errs[errs.length - 1].trim().slice(0, 120)}` } : { level: "ok", reason: "no Error lines in last 500" };
    }),
  );
  return { overall: worst(checks), checks };
}
