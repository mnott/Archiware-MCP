/**
 * Governance and "make sure it gets done": governance_report / governance_apply,
 * schedule_check, ensure_done, and P5 mail status (notify_*).
 *
 * Everything here is read-only except governance_apply, ensure_done --rerun
 * and notify_test --confirm (a host-MTA mail), all confirm-gated.
 */

import type { ArchiwareConfig } from "./config.js";
import { hostCommand, nsdchatCalls, P5Error, p5Exec, parseTclList } from "./transport.js";
import * as ops from "./operations.js";
import { jobHistory, runTasksOnce, taskSetEnabled } from "./taskops.js";
import { locate, snapshot, type Snapshot } from "./libops.js";
import { backupIndexDb, resourcesDb, sqliteQuery } from "./p5db.js";
import { existsSync } from "node:fs";

const clean = (v: string | undefined): string => (v === undefined || v === "<empty>" ? "" : v);
const DAY = 86_400_000;
/** P5's event names are internal ids; a readable label is level + pool. */
export const evLabel = (e: Pick<EventM, "level" | "pool">): string => `${e.level === "1" ? "full" : e.level === "0" ? "incremental" : `level ${e.level}`} to ${e.pool}`;

// ---------------------------------------------------------------------------
// model: plans, events, tasks
// ---------------------------------------------------------------------------

export interface EventM {
  name: string;
  describe: string;
  pool: string;
  level: string;
  frequency: string;
  exception: string;
  firstrun: number;
}
export interface TaskM {
  id: string;
  client: string;
  dirs: string[];
  enabled: boolean;
}
export interface PlanM {
  id: string;
  name: string;
  enabled: boolean;
  retention: string;
  stophours: string;
  canceltime: string;
  events: EventM[];
  tasks: TaskM[];
}

const MODEL_SCRIPT = [
  `proc g {args} {if {[catch {uplevel #0 $args} v]} {return ""}; return $v}`,
  `set r {}`,
  `foreach p [BackupPlan names] {`,
  `set ev {}; foreach e [g BackupPlan $p eventnames] {lappend ev [list $e [g CalendarEvent $e describe] [g CalendarEvent $e pool] [g CalendarEvent $e level] [g CalendarEvent $e frequency] [g CalendarEvent $e exception] [g CalendarEvent $e firstrun]]}`,
  `set tk {}; foreach t [g BackupPlan $p tasknames] {lappend tk [list $t [g BackupTask $t client] [g BackupTask $t dirlist] [g BackupTask $t enabled]]}`,
  `lappend r [list $p [g BackupPlan $p describe] [g BackupPlan $p enabled] [g BackupPlan $p retention] [g BackupPlan $p stophours] [g BackupPlan $p canceltime] $ev $tk]`,
  `}`,
  `set r`,
].join("\n");

export function parseModel(raw: string | null): PlanM[] {
  return parseTclList(raw).map((rec) => {
    const f = parseTclList(rec);
    const events = parseTclList(f[6]).map((e) => {
      const x = parseTclList(e).map(clean);
      return { name: x[0], describe: x[1], pool: x[2], level: x[3], frequency: x[4], exception: x[5], firstrun: Number(x[6]) || 0 };
    });
    const tasks = parseTclList(f[7]).map((t) => {
      const x = parseTclList(t);
      return { id: x[0], client: clean(x[1]) || "localhost", dirs: parseTclList(clean(x[2])), enabled: clean(x[3]) === "1" };
    });
    return { id: f[0], name: clean(f[1]), enabled: clean(f[2]) === "1", retention: clean(f[3]), stophours: clean(f[4]), canceltime: clean(f[5]), events, tasks };
  });
}

export async function loadPlans(cfg: ArchiwareConfig): Promise<PlanM[]> {
  const [r] = await nsdchatCalls(cfg, [[MODEL_SCRIPT]], 120_000);
  if (r.rc !== 0) throw new P5Error(`reading plans failed (exit ${r.rc}): ${r.out.slice(0, 200)}`);
  return parseModel(r.out.trim());
}

// ---------------------------------------------------------------------------
// frequency: words and occurrences
// ---------------------------------------------------------------------------

const WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const wdName = (n: number) => WD[n % 7];
const ORD = ["", "first", "second", "third", "fourth", "last"];
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** P5 event frequency ("D n", "W n d..", "M n nth weekday", "") in plain words. */
export function frequencyWords(freq: string, firstrun: number): string {
  const t = freq.trim().split(/\s+/).filter(Boolean);
  const at = firstrun ? ` at ${hhmm(new Date(firstrun * 1000))}` : "";
  if (t.length === 0) return `once${firstrun ? ` on ${new Date(firstrun * 1000).toLocaleDateString("en-CA")}` : ""}${at}`;
  const n = Number(t[1]);
  if (t[0] === "D") return `${n === 1 ? "every day" : `every ${n} days`}${at}`;
  if (t[0] === "W") {
    const days = t.slice(2).map(Number);
    const dd = days.length === 7 ? "every day of the week" : days.map((d) => wdName(d)).join(", ");
    return `${n === 1 ? "every week" : `every ${n} weeks`} on ${dd}${at}`;
  }
  if (t[0] === "M") {
    const nth = Number(t[2]);
    const wd = Number(t[3]);
    return `${n === 1 ? "every month" : n === 12 ? "every year" : `every ${n} months`} on the ${ORD[nth] ?? `${nth}.`} ${wdName(wd)}${at}`;
  }
  return `${freq} (unrecognised)${at}`;
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Occurrence start times of one frequency rule between from and to (local wall-clock times, anchored at firstrun). */
export function occurrences(freq: string, firstrun: number, from: Date, to: Date): Date[] {
  if (!firstrun) return [];
  const anchor = new Date(firstrun * 1000);
  const t = freq.trim().split(/\s+/).filter(Boolean);
  const out: Date[] = [];
  const at = (y: number, m: number, d: number) => new Date(y, m, d, anchor.getHours(), anchor.getMinutes(), anchor.getSeconds());
  const push = (d: Date) => {
    if (d >= anchor && d >= from && d <= to) out.push(d);
  };
  if (t.length === 0) {
    push(anchor);
    return out;
  }
  const n = Math.max(1, Number(t[1]) || 1);
  if (t[0] === "D") {
    for (let d = new Date(anchor); d <= to; d = at(d.getFullYear(), d.getMonth(), d.getDate() + n)) push(new Date(d));
  } else if (t[0] === "W") {
    const days = t.slice(2).map((x) => Number(x) % 7);
    const mon = at(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - ((anchor.getDay() + 6) % 7));
    for (let w = 0; ; w += n) {
      const ws = at(mon.getFullYear(), mon.getMonth(), mon.getDate() + 7 * w);
      if (ws > to) break;
      for (const wd of days) push(at(ws.getFullYear(), ws.getMonth(), ws.getDate() + ((wd + 6) % 7)));
    }
  } else if (t[0] === "M") {
    const nth = Number(t[2]);
    const wd = Number(t[3]) % 7;
    for (let k = 0; ; k += n) {
      const y = anchor.getFullYear() + Math.floor((anchor.getMonth() + k) / 12);
      const m = (anchor.getMonth() + k) % 12;
      if (at(y, m, 1) > to) break;
      const first = at(y, m, 1);
      let day = 1 + ((wd - first.getDay() + 7) % 7) + (Math.min(nth, 5) - 1) * 7;
      const dim = new Date(y, m + 1, 0).getDate();
      while (day > dim) day -= 7; // 5th (= last) weekday when a month has only four
      if (nth < 5 && day !== 1 + ((wd - first.getDay() + 7) % 7) + (nth - 1) * 7) continue;
      push(at(y, m, day));
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/** Event occurrences minus the days its exception rule fires on. */
export function eventRuns(ev: Pick<EventM, "frequency" | "exception" | "firstrun">, from: Date, to: Date): Date[] {
  const runs = occurrences(ev.frequency, ev.firstrun, from, to);
  if (!ev.exception.trim()) return runs;
  const ex = occurrences(ev.exception, ev.firstrun, new Date(from.getTime() - DAY), new Date(to.getTime() + DAY));
  return runs.filter((r) => !ex.some((e) => sameDay(e, r)));
}

/** Smallest gap in days between runs of the plan's events (for "runs rarely" judgement). */
function minIntervalDays(p: PlanM): number {
  let best = Infinity;
  for (const e of p.events) {
    const t = e.frequency.trim().split(/\s+/).filter(Boolean);
    const n = Number(t[1]) || 1;
    const d = t.length === 0 ? Infinity : t[0] === "D" ? n : t[0] === "W" ? 7 * n : 30 * n;
    best = Math.min(best, d);
  }
  return best;
}

// ---------------------------------------------------------------------------
// shared reads
// ---------------------------------------------------------------------------

/** Maintenance restart window(s) as P5 logs them at start: "Attempt restart on Sun, 04:00 - 07:00". */
export interface RestartWindow {
  days: number[];
  from: string;
  to: string;
}
export function parseRestartWindow(logText: string): RestartWindow | null {
  const lines = logText.split("\n").filter((l) => /Attempt restart on /.test(l));
  if (!lines.length) return null;
  const days: number[] = [];
  let from = "";
  let to = "";
  for (const l of lines.slice(-7)) {
    const m = l.match(/Attempt restart on (\w{3}), (\d{2}:\d{2}) - (\d{2}:\d{2})/);
    if (!m) continue;
    const d = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(m[1]);
    if (d >= 0) days.push(d);
    from = m[2];
    to = m[3];
  }
  return days.length ? { days: [...new Set(days)], from, to } : null;
}

export async function restartWindow(cfg: ArchiwareConfig): Promise<RestartWindow | null> {
  if (!cfg.logPath) return null;
  const r = await hostCommand(cfg, ["sh", "-c", 'grep -h "Attempt restart on" "$1" "$1".0* 2>/dev/null | tail -7', "sh", cfg.logPath], 30_000);
  return parseRestartWindow(r.stdout);
}

export function restartWindowWords(w: RestartWindow | null): string[] {
  if (!w) return ["P5's maintenance restart window was not found in the log (set logPath, or P5 has not been restarted since the log rotated)."];
  const d = w.days.length === 7 ? "every day" : w.days.map((x) => wdName(x)).join(", ");
  return [
    `P5 tries a maintenance restart of its server ${d} between ${w.from} and ${w.to} (server time).`,
    "From the start of the window it attempts a graceful restart every 10 minutes and only restarts when no session or job is active (log: \"Can't restart: have active sessions ... Next restart attempt in 10 minutes\"). At the end of the window it gives up for that day (log: \"Unable to perform graceful restart\"); it does not kill running jobs.",
    "Where it is configured: not available through nsdchat or REST (no Server/Config command, srvinfo has no such field); the window is printed in the log at every server start and is stored inside P5 (not in the readable config files). Check it in the P5 GUI under server maintenance/settings.",
  ];
}

interface Poolish {
  name: string;
  mediatype: string | null;
  gen: string | null;
  volumes: { id: string; barcode: string | null; label: string | null; mode: string | null; where: string }[];
  appendableInLibrary: number;
}

const genOf = (barcode: string | null): string | null => {
  const m = (barcode ?? "").toUpperCase().match(/L(\d)$/);
  return m ? `L${m[1]}` : null;
};
const APPENDABLE = /^(appendable|recyclable|blank)$/i;

async function loadPools(cfg: ArchiwareConfig, snap: Snapshot): Promise<Map<string, Poolish>> {
  const pools = await ops.pools(cfg);
  const byId = new Map(snap.vols.map((v) => [v.id, v]));
  const m = new Map<string, Poolish>();
  for (const p of pools) {
    const volumes = p.volumes.map((id) => {
      const v = byId.get(id);
      const w = locate(cfg, snap.mtx, v?.barcode ?? null);
      return { id, barcode: v?.barcode ?? null, label: v?.label ?? null, mode: v?.mode ?? null, where: /tape/i.test(p.mediatype ?? "tape") ? w.where : "disk" };
    });
    const gens = volumes.map((v) => genOf(v.barcode)).filter((x): x is string => !!x);
    const gen = gens.length ? ([...new Set(gens)].sort((a, b) => gens.filter((x) => x === b).length - gens.filter((x) => x === a).length)[0] ?? null) : null;
    m.set(p.name, { name: p.name, mediatype: p.mediatype, gen, volumes, appendableInLibrary: volumes.filter((v) => APPENDABLE.test(v.mode ?? "") && (v.where === "slot" || v.where === "drive" || v.where === "disk")).length });
  }
  return m;
}

async function folderExists(cfg: ArchiwareConfig, dirs: string[]): Promise<Map<string, boolean>> {
  const uniq = [...new Set(dirs)];
  const res = new Map<string, boolean>();
  if (!uniq.length) return res;
  const script = 'for d in "$@"; do if [ -e "$d" ]; then echo "1 $d"; else echo "0 $d"; fi; done';
  const r = await hostCommand(cfg, p5Exec(cfg, ["sh", "-c", script, "sh", ...uniq]), 60_000);
  for (const l of r.stdout.split("\n")) if (l.length > 2) res.set(l.slice(2), l[0] === "1");
  for (const d of uniq) if (!res.has(d)) res.set(d, true); // unknown: do not accuse
  return res;
}

interface JobRow {
  id: string;
  plan: string | null;
  task: string | null;
  status: string;
  completion: string | null;
  start: string | null;
}

async function loadJobs(cfg: ArchiwareConfig, sinceIso: string, limit = 4000): Promise<JobRow[]> {
  const h = await jobHistory(cfg, { since: sinceIso, limit, maxScan: 8000 });
  return (h.jobs as unknown as JobRow[]).map((j) => ({ id: String(j.id), plan: j.plan, task: j.task, status: String(j.status), completion: j.completion, start: j.start }));
}

const isOk = (j: JobRow) => /success|warning/i.test(j.completion ?? "") && j.status === "completed";
const isActive = (j: JobRow) => /running|pending|waiting/.test(j.status);
const dayStr = (d: Date) => d.toLocaleDateString("en-CA");
const dayAgo = (start: string | null, now: Date) => (start ? Math.floor((now.getTime() - new Date(start.replace(" ", "T")).getTime()) / DAY) : null);

// ---------------------------------------------------------------------------
// notify (mail) status
// ---------------------------------------------------------------------------

export interface MailLogEvidence {
  lastSent: string | null;
  lastFailed: string | null;
  failedLastDays: number;
  sentLastDays: number;
  lastError: string | null;
  jobsFinishedLastDays: number;
  days: number;
}

const LOGMON: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
/** "[09/Nov/2026:03:57:59]" -> Date (server-local) */
export function logTime(line: string): Date | null {
  const m = line.match(/^\[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\]/);
  return m && m[2] in LOGMON ? new Date(+m[3], LOGMON[m[2]], +m[1], +m[4], +m[5], +m[6]) : null;
}

export function mailEvidence(lines: string[], now: Date, days: number): MailLogEvidence {
  const cutoff = now.getTime() - days * DAY;
  let lastSent: Date | null = null;
  let lastFailed: Date | null = null;
  let failed = 0;
  let sent = 0;
  let jobs = 0;
  let lastError: string | null = null;
  for (const l of lines) {
    const t = logTime(l);
    if (!t) continue;
    if (/ MAIL SENT to /.test(l)) {
      if (!lastSent || t > lastSent) lastSent = t;
      if (t.getTime() >= cutoff) sent++;
    } else if (/ MAIL NOT SENT to /.test(l)) {
      if (!lastFailed || t > lastFailed) {
        lastFailed = t;
        lastError = l.replace(/^\[[^\]]*\]\[[^\]]*\]\[[^\]]*\]\s*\w+:\s*/, "").replace(/'[^']*@[^']*'/, "'<recipient>'").slice(0, 160);
      }
      if (t.getTime() >= cutoff) failed++;
    } else if (/notification options: -user/.test(l) && t.getTime() >= cutoff) jobs++;
  }
  const f = (d: Date | null) => (d ? `${dayStr(d)} ${hhmm(d)}` : null);
  return { lastSent: f(lastSent), lastFailed: f(lastFailed), failedLastDays: failed, sentLastDays: sent, lastError, jobsFinishedLastDays: jobs, days };
}

export async function mailLogEvidence(cfg: ArchiwareConfig, days = cfg.mailSilenceDays): Promise<MailLogEvidence | null> {
  if (!cfg.logPath) return null;
  const r = await hostCommand(cfg, ["sh", "-c", 'grep -h -E "MAIL (NOT )?SENT to |notification options: -user" "$1" "$1".0* 2>/dev/null | cut -c1-300', "sh", cfg.logPath], 60_000);
  return mailEvidence(r.stdout.split("\n"), new Date(), days);
}

export interface MailConfig {
  server: string | null;
  port: number | null;
  tls: string;
  sender: string | null;
  user: string | null;
  authentication: boolean;
  passwordStored: boolean;
  recipients: { user: string; email: string | null; notify: boolean; severity: string | null; include: string | null; exclude: string | null }[];
}

export async function readMailConfig(cfg: ArchiwareConfig): Promise<MailConfig> {
  const db = resourcesDb(cfg);
  const c = await sqliteQuery(cfg, db, "select mailServer,mailPort,mailSender,mailUser,encryptConn,length(mailPassword),length(mailPasswordEncrypted) from Client where name='localhost'");
  const u = await sqliteQuery(cfg, db, "select name,email,allowNotify,mailSeverity,mailSubsytemInclude,mailSubsystemExclude from UserPref where email is not null and email<>'' or allowNotify=1");
  const r = c[0] ?? [];
  const port = Number(r[1]) || null;
  const tls = r[4] === "1" ? "TLS on (encrypt connection set)" : port === 465 ? "implicit TLS (port 465)" : port === 587 ? "STARTTLS expected (port 587; the P5 flag is not set)" : "no TLS flag set";
  return {
    server: r[0] || null,
    port,
    tls,
    sender: r[2] || null,
    user: r[3] || null,
    authentication: !!r[3],
    passwordStored: Number(r[5]) > 0 || Number(r[6]) > 0,
    recipients: u.map((x) => ({ user: x[0], email: x[1] || null, notify: x[2] === "1", severity: x[3] || null, include: x[4] || null, exclude: x[5] || null })),
  };
}

export async function notifyStatus(cfg: ArchiwareConfig) {
  const mc = await readMailConfig(cfg);
  const ev = await mailLogEvidence(cfg, Math.max(cfg.mailSilenceDays, 7));
  const words: string[] = [];
  if (!mc.server) words.push("P5 mail is NOT configured: no SMTP server is set, so P5 cannot send any report or alert mail.");
  else {
    words.push(`P5 sends mail through ${mc.server}:${mc.port ?? "?"} (${mc.tls}), sender ${mc.sender ?? "not set (P5 default)"}, ${mc.authentication ? `logging in as ${mc.user}${mc.passwordStored ? " (password stored)" : " (NO password stored)"}` : "without login"}.`);
    for (const r of mc.recipients) words.push(`Recipient: P5 user "${r.user}" -> ${r.email ?? "no address"}; notifications ${r.notify ? "on" : "off"}${r.severity ? `, severity ${r.severity}` : ""}${r.include ? `, only ${r.include}` : ""}${r.exclude ? `, not ${r.exclude}` : ""}.`);
    words.push("P5 has no per-plan or per-event mail recipients: it mails the report of every finished job (and alerts) to the users with notifications on, filtered by the user's severity and subsystem settings.");
  }
  if (ev) {
    words.push(ev.lastSent ? `Last mail P5 reports as sent: ${ev.lastSent}.` : "P5's log shows no mail ever sent.");
    if (ev.failedLastDays && mc.server && (mc.port === 587 || mc.port === 465) && !mc.tls.startsWith("TLS on")) words.push(`Likely cause: port ${mc.port} needs an encrypted connection (${mc.port === 587 ? "STARTTLS" : "TLS"}) but P5's "encrypt connection" flag is not set; servers like this drop the plain connection ("connection abort").`);
    if (ev.failedLastDays) words.push(`In the last ${ev.days} days P5 failed to send ${ev.failedLastDays} mail(s); last failure ${ev.lastFailed}: ${ev.lastError}.`);
  }
  return {
    config: mc,
    log: ev,
    words,
    where: "P5 keeps these settings in its resource database (customerconfig/resources.db: Client 'localhost' mail* columns, UserPref notification columns); nsdchat and REST expose none of them. Read here read-only from the host copy; changed in the P5 GUI (Setup > Mail / Users).",
    problem: mailProblem(mc, ev, cfg.mailSilenceDays),
  };
}

/** One-line problem description or null. */
export function mailProblem(mc: MailConfig | null, ev: MailLogEvidence | null, days: number): string | null {
  if (mc && !mc.server) return "P5 mail is not configured (no SMTP server)";
  if (mc && !mc.recipients.some((r) => r.notify && r.email)) return "no P5 user has notifications on with an address";
  if (ev) {
    if (ev.failedLastDays > 0 && (!ev.lastSent || ev.sentLastDays === 0)) return `P5 failed to send ${ev.failedLastDays} mail(s) in ${ev.days} days and sent none (last error: ${ev.lastError})`;
    if (ev.jobsFinishedLastDays > 0 && ev.sentLastDays === 0) return `jobs finished in the last ${days} days but P5 sent no mail`;
  }
  return null;
}

/** P5 has no mail settings command; the setter is refused with the reason and the manual steps. */
export async function notifySet(cfg: ArchiwareConfig, a: { server?: string; port?: number; tls?: string; sender?: string; user?: string; passwordFile?: string; recipients?: string[] }, confirm: boolean) {
  const wanted = { ...a, passwordFile: a.passwordFile ? "(from file, never shown)" : undefined };
  if (a.passwordFile && !existsSync(a.passwordFile)) throw new P5Error(`password file ${a.passwordFile} does not exist`);
  void confirm;
  return {
    supported: false as const,
    changed: false as const,
    wanted,
    current: await readMailConfig(cfg),
    reason:
      "P5 offers no nsdchat or REST command to change its mail settings (Client has no mail attribute; REST general/clients exposes none), and the settings live in P5's own SQLite resource database, which must not be edited while the server runs (it caches resources in memory and would overwrite the change). Nothing was changed.",
    steps: [
      "P5 GUI > Setup > Mail (SMTP server, port, encryption, sender, user, password) and Setup > Users > the user's e-mail address and notification severity.",
      "Afterwards run notify_status to read the result back and notify_test to check the connection.",
    ],
  };
}

const SMTP_PROBE = 'timeout 10 bash -c \'exec 3<>"/dev/tcp/$0/$1"\' "$1" "$2" 2>&1 && echo OPEN || echo CLOSED';

/**
 * P5 has no "send test mail" command. The closest equivalents: (1) a TCP
 * connect from the P5 container to P5's configured SMTP server:port (the path
 * P5's own mail takes), (2) with confirm, a test mail through the HOST MTA to
 * the operator address from this tool's config (operatorMail only). (2) does
 * not prove P5's own mail works; (1) plus the log evidence do.
 */
export async function notifyTest(cfg: ArchiwareConfig, confirm: boolean) {
  const mc = await readMailConfig(cfg);
  const ev = await mailLogEvidence(cfg);
  const checks: Record<string, unknown> = { note: "P5 offers no command that sends a test mail; these are the closest checks." };
  if (!mc.server) checks.smtpReachable = "skipped: no SMTP server configured in P5";
  else {
    const r = await hostCommand(cfg, p5Exec(cfg, ["sh", "-c", SMTP_PROBE, "sh", mc.server, String(mc.port ?? 25)]), 30_000);
    checks.smtpReachable = `${mc.server}:${mc.port ?? 25} from the P5 ${cfg.mode === "docker" ? "container" : "host"}: ${r.stdout.includes("OPEN") ? "connection opens" : `connection FAILED (${(r.stdout + r.stderr).trim().split("\n")[0].slice(0, 120)})`}`;
  }
  checks.p5LogEvidence = ev ? { lastSent: ev.lastSent, lastFailed: ev.lastFailed, failedLastDays: ev.failedLastDays, lastError: ev.lastError } : "logPath not configured";
  const to = cfg.operatorMail;
  if (!to) return { ...checks, hostMtaTestMail: "skipped: set operatorMail in the config to enable it" };
  if (!confirm) return { confirmationRequired: true as const, ...checks, wouldRun: [`mail -s "archiware-mcp test" <operatorMail> via the host MTA on ${cfg.sshHost || "localhost"}`], note: "Sends one test mail to the operatorMail address from the config; independent of P5's own mail." };
  await sendHostMail(cfg, "archiware-mcp test mail", "Test mail from archiware-mcp via the P5 host's MTA. It does not exercise P5's own mail settings.");
  return { confirmationRequired: false as const, ...checks, hostMtaTestMail: "handed to the host MTA" };
}

/** Send through the host MTA (`mail`), to operatorMail from the config only. */
export async function sendHostMail(cfg: ArchiwareConfig, subject: string, body: string): Promise<void> {
  const to = cfg.operatorMail;
  if (!/^[^\s@<>;,"']+@[^\s@<>;,"']+$/.test(to)) throw new P5Error("operatorMail is not set (or not a plain address) in the config");
  const r = await hostCommand(cfg, ["sh", "-c", 'printf "%s\\n" "$1" | mail -s "$2" "$3"', "sh", body, subject, to], 60_000);
  if (r.rc !== 0) throw new P5Error(`host mail failed: ${r.stderr.split("\n")[0]}`);
}

// ---------------------------------------------------------------------------
// governance_report
// ---------------------------------------------------------------------------

export type Reco = "keep" | "merge" | "disable" | "delete";
export interface Flag {
  reason: string;
  recommendation: Reco;
  apply?: string;
}

export async function governanceReport(cfg: ArchiwareConfig) {
  const now = new Date();
  const months = cfg.governanceMonths;
  const since = new Date(now.getTime() - months * 30 * DAY);
  const sinceIso = since.toISOString().slice(0, 10);
  const plans = await loadPlans(cfg);
  const snap = await snapshot(cfg);
  const pools = await loadPools(cfg, snap);
  const jobs = await loadJobs(cfg, sinceIso);
  const exists = await folderExists(cfg, plans.flatMap((p) => p.tasks.flatMap((t) => t.dirs)));

  const byPlan = new Map<string, JobRow[]>();
  for (const j of jobs) byPlan.set(j.plan ?? "", [...(byPlan.get(j.plan ?? "") ?? []), j]);

  // folders covered by several plans (enabled tasks of enabled plans only)
  const folderPlans = new Map<string, Set<string>>();
  for (const p of plans) if (p.enabled) for (const t of p.tasks) if (t.enabled) for (const d of t.dirs) folderPlans.set(d, (folderPlans.get(d) ?? new Set()).add(p.name || p.id));
  const dirs = [...folderPlans.keys()];
  const overlaps: { folder: string; plans: string[]; kind: string }[] = [];
  for (const d of dirs) {
    const ps = new Set(folderPlans.get(d));
    for (const e of dirs) if (e !== d && (d + "/").startsWith(e.replace(/\/+$/, "") + "/")) for (const x of folderPlans.get(e)!) ps.add(x);
    if (ps.size > 1) overlaps.push({ folder: d, plans: [...ps], kind: folderPlans.get(d)!.size > 1 ? "same folder" : "inside a folder another plan backs up" });
  }

  const planRows = plans.map((p) => {
    const rows = (byPlan.get(p.name) ?? []).filter((j) => j.start); // jobs without a start time cannot be dated
    const flags: Flag[] = [];
    const last = rows.filter((j) => !isActive(j)).sort((a, b) => (b.start ?? "").localeCompare(a.start ?? ""))[0];
    const lastOk = rows.filter(isOk).sort((a, b) => (b.start ?? "").localeCompare(a.start ?? ""))[0];
    const interval = minIntervalDays(p);
    const rare = interval > months * 30;
    const perTask = p.tasks.map((t) => {
      const tj = rows.filter((j) => j.task === t.id && !isActive(j)).sort((a, b) => (b.start ?? "").localeCompare(a.start ?? ""));
      const lj = tj[0];
      const miss = t.dirs.filter((d) => exists.get(d) === false);
      if (miss.length && t.enabled) flags.push({ reason: `task ${t.id} backs up ${miss.join(", ")} which does not exist in the P5 ${cfg.mode === "docker" ? "container" : "host"}`, recommendation: "disable", apply: `disable-task:${t.id}` });
      if (t.enabled && p.enabled && rows.length > 0 && tj.length === 0 && !rows.some((j) => j.task === t.id && isActive(j))) flags.push({ reason: `enabled task ${t.id} (${t.dirs.join(", ")}) has no run in the last ${months} months although the plan ran ${rows.length} times: check why (client, folder, task added recently?)`, recommendation: "keep", apply: `disable-task:${t.id}` });
      return { task: t.id, client: t.client, enabled: t.enabled, folders: t.dirs, foldersMissing: miss, lastRun: lj ? { job: lj.id, start: lj.start, result: lj.completion ?? lj.status } : null };
    });
    const anyEnabledTask = p.tasks.some((t) => t.enabled);
    if (p.enabled) {
      if (p.events.length === 0) flags.push({ reason: "enabled but has no event (schedule): it never runs by itself", recommendation: "disable", apply: `disable-plan:${p.id}` });
      if (!anyEnabledTask) flags.push({ reason: "enabled but has no enabled task", recommendation: "disable", apply: `disable-plan:${p.id}` });
      if (rows.length === 0 && !rare && p.events.length) flags.push({ reason: `enabled with a schedule but no run in the last ${months} months`, recommendation: "disable", apply: `disable-plan:${p.id}` });
      else if (rows.length > 0 && !lastOk && !rows.some(isActive)) flags.push({ reason: `only failed or stopped runs in the last ${months} months (${rows.length})`, recommendation: "disable", apply: `disable-plan:${p.id}` });
    } else {
      const ago = dayAgo(last?.start ?? null, now);
      if (!last) flags.push({ reason: `disabled and no run in the last ${months} months (likely abandoned)`, recommendation: "delete", apply: `delete-plan:${p.id}` });
      else if (ago !== null && ago > cfg.disabledDays) flags.push({ reason: `disabled for over ${cfg.disabledDays} days (last run ${last.start}, ${ago} days ago)`, recommendation: "keep" });
    }
    const covered = p.tasks.filter((t) => t.enabled && t.dirs.length && t.dirs.every((d) => overlaps.some((o) => o.folder === d && o.plans.includes(p.name || p.id))));
    if (p.enabled && covered.length && covered.length === p.tasks.filter((t) => t.enabled).length) flags.push({ reason: "all its folders are also backed up by other enabled plans", recommendation: "merge" });
    for (const e of p.events) {
      const pl = pools.get(e.pool);
      if (!pl) flags.push({ reason: `event ${evLabel(e)} uses pool ${e.pool}, which does not exist`, recommendation: "delete" });
      else if (p.enabled && pl.volumes.length === 0) flags.push({ reason: `event ${evLabel(e)}: pool ${e.pool} has no volumes`, recommendation: "disable", apply: `disable-plan:${p.id}` });
      else if (p.enabled && !pl.volumes.some((v) => v.where !== "offsite")) flags.push({ reason: `event ${evLabel(e)}: no volume of pool ${e.pool} is in the library`, recommendation: "keep" });
      else if (p.enabled && pl.appendableInLibrary === 0) flags.push({ reason: `event ${evLabel(e)}: pool ${e.pool} has no appendable volume in the library`, recommendation: "keep" });
    }
    return {
      id: p.id,
      name: p.name,
      enabled: p.enabled,
      retentionDays: p.retention,
      stophours: p.stophours,
      canceltime: p.canceltime,
      events: p.events.map((e) => ({ name: evLabel(e), pool: e.pool, level: e.level === "1" ? "full" : e.level === "0" ? "incremental" : e.level, frequency: frequencyWords(e.frequency, e.firstrun) + (e.exception ? ` (not on days when "${frequencyWords(e.exception, e.firstrun).replace(/ at \d\d:\d\d$/, "")}" runs)` : ""), nextRun: (() => { const r = eventRuns(e, now, new Date(now.getTime() + 800 * DAY))[0]; return r ? `${dayStr(r)} ${hhmm(r)}` : null; })() })),
      taskCount: p.tasks.length,
      tasks: perTask,
      lastRun: last ? { job: last.id, start: last.start, result: last.completion ?? last.status } : null,
      runsInWindow: rows.length,
      flags,
    };
  });

  const poolRows = [...pools.values()].map((p) => ({ pool: p.name, mediaType: p.mediatype, generation: p.gen, volumes: p.volumes.length, inLibrary: p.volumes.filter((v) => v.where === "slot" || v.where === "drive" || v.where === "disk").length, appendableInLibrary: p.appendableInLibrary, flags: [...(p.volumes.length === 0 ? ["no volumes"] : []), ...(p.volumes.length > 0 && p.appendableInLibrary === 0 ? ["no appendable volume in the library"] : [])] }));
  const window = await restartWindow(cfg).catch(() => null);
  const notify = await notifyStatus(cfg).then((n) => ({ words: n.words, problem: n.problem })).catch((e) => ({ words: [`mail status unavailable: ${(e as Error).message.split("\n")[0]}`], problem: null }));
  const server = [
    ...restartWindowWords(window),
    ...planRows.filter((p) => p.enabled).map((p) => `Plan "${p.name}": ${p.stophours && p.stophours !== "0" ? `stops starting new work after ${p.stophours} h` : "no stop time"}; ${p.canceltime && p.canceltime !== "0" ? `cancels a job after ${p.canceltime} h` : "no cancel time"}; keeps backups ${p.retentionDays} days.`),
    ...notify.words,
  ];
  const flagged = planRows.flatMap((p) => p.flags.map((f) => ({ plan: `${p.name} (${p.id})`, ...f })));
  return {
    generated: now.toISOString(),
    windowMonths: months,
    plans: planRows,
    foldersInSeveralPlans: overlaps,
    pools: poolRows,
    server,
    flags: flagged,
    note: "Run history covers the last " + months + " months of the job database. Apply one recommendation with governance_apply <item> (confirm-gated).",
  };
}

// ---------------------------------------------------------------------------
// governance_apply
// ---------------------------------------------------------------------------

export async function governanceApply(cfg: ArchiwareConfig, item: string, confirm: boolean) {
  const m = item.match(/^(disable-plan|delete-plan|disable-task):(\d+)$/);
  if (!m) throw new P5Error(`unknown item "${item}"; use one of the "apply" values of governance_report (disable-plan:<id>, delete-plan:<id>, disable-task:<id>)`);
  const [, kind, id] = m;
  if (kind === "disable-task") return taskSetEnabled(cfg, id, false, confirm);
  const desc = (await nsdchatCalls(cfg, [["BackupPlan", id, "describe"], ["BackupPlan", id, "enabled"]]));
  if (desc[0].rc !== 0) throw new P5Error(`no such backup plan: ${id}`);
  const name = desc[0].out.trim();
  const active = await nsdchatCalls(cfg, [["Job", "running"], ["Job", "pending"]]);
  const ids = [...parseTclList(active[0].out), ...parseTclList(active[1].out)];
  const ds = ids.length ? await nsdchatCalls(cfg, ids.map((j) => ["Job", j, "describe"])) : [];
  const busy = ids.filter((_, i) => ds[i].out.trim() === name || ds[i].out.trim().startsWith(`${name} - `));
  if (busy.length && confirm) throw new P5Error(`plan ${id} (${name}) has active job(s): ${busy.join(", ")}; not touching it`);
  if (kind === "disable-plan") {
    const r = await ops.disablePlan(cfg, id, confirm);
    if (!confirm) return { ...r, plan: name, busyJobs: busy };
    const after = (await nsdchatCalls(cfg, [["BackupPlan", id, "enabled"]]))[0].out.trim();
    if (after !== "0") throw new P5Error(`plan ${id}: enabled=${after} after disable`);
    return { confirmationRequired: false as const, plan: id, name, before: { enabled: desc[1].out.trim() }, after: { enabled: after } };
  }
  const r = await ops.deletePlan(cfg, id, confirm);
  if (!confirm) return { ...r, plan: name, busyJobs: busy, note: "Deleting a plan removes its tasks and events; already written backups stay on tape until their retention expires." };
  return { ...r, name, readBack: "plan no longer listed in BackupPlan names" };
}

// ---------------------------------------------------------------------------
// schedule_check
// ---------------------------------------------------------------------------

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export interface Run {
  plan: string;
  planId: string;
  event: string;
  pool: string;
  gen: string | null;
  start: Date;
  end: Date;
  durationMin: number;
  durationKnown: boolean;
}

/** Pairs of runs overlapping in time that share a key. */
export function overlaps(runs: Run[], key: (r: Run) => string | null, limit = (_k: string) => 1): { key: string; a: Run; b: Run }[] {
  const out: { key: string; a: Run; b: Run }[] = [];
  const groups = new Map<string, Run[]>();
  for (const r of runs) {
    const k = key(r);
    if (k) groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const [k, rs] of groups) {
    const s = [...rs].sort((a, b) => a.start.getTime() - b.start.getTime());
    for (let i = 0; i < s.length; i++)
      for (let j = i + 1; j < s.length && s[j].start < s[i].end; j++) {
        // concurrent count at s[j].start
        const concurrent = s.filter((x) => x.start <= s[j].start && x.end > s[j].start).length;
        if (concurrent > limit(k)) out.push({ key: k, a: s[i], b: s[j] });
      }
  }
  return out;
}

export async function scheduleCheck(cfg: ArchiwareConfig, opts: { days?: number } = {}) {
  const days = opts.days ?? 7;
  const now = new Date();
  const to = new Date(now.getTime() + days * DAY);
  const plans = (await loadPlans(cfg)).filter((p) => p.enabled);
  const snap = await snapshot(cfg);
  const pools = await loadPools(cfg, snap);
  const window = await restartWindow(cfg).catch(() => null);

  // typical durations: median of past runs of the event, from the backup index snapshot table
  const spans: { plan: string; event: string; minutes: number }[] = [];
  for (const client of [...new Set(plans.flatMap((p) => p.tasks.map((t) => t.client)))]) {
    try {
      const raw = await sqliteQuery(cfg, backupIndexDb(cfg, client, "files"), "select plan,pool,btime,ctime from snapshots where ctime>btime order by plan,pool,btime");
      let last: { plan: string; event: string; start: number; end: number } | null = null;
      const flush = () => last && spans.push({ plan: last.plan, event: last.event, minutes: (last.end - last.start) / 60 });
      for (const [plan, event, b, c] of raw) {
        const s = Number(b);
        const e = Number(c);
        if (last && last.plan === plan && last.event === event && s - last.end < 1800) last.end = Math.max(last.end, e);
        else {
          flush();
          last = { plan, event, start: s, end: e };
        }
      }
      flush();
    } catch {
      /* no index for this client: durations stay unknown */
    }
  }

  const runs: Run[] = [];
  for (const p of plans)
    for (const e of p.events) {
      const planMed = median(spans.filter((s) => s.plan === p.id).map((s) => s.minutes));
      const evMed = median(spans.filter((s) => s.plan === p.id && s.event === e.pool).map((s) => s.minutes));
      const med = evMed ?? planMed;
      const dur = Math.max(1, Math.round(med ?? 60));
      for (const start of eventRuns(e, now, to)) runs.push({ plan: p.name, planId: p.id, event: evLabel(e), pool: e.pool, gen: pools.get(e.pool)?.gen ?? null, start, end: new Date(start.getTime() + dur * 60_000), durationMin: dur, durationKnown: med !== null });
    }
  runs.sort((a, b) => a.start.getTime() - b.start.getTime());

  const drivesOf = (g: string) => Math.max(1, cfg.drives.filter((d) => d.gen === g).length);
  const fmt = (r: Run) => `${r.plan}/${r.event} ${dayStr(r.start)} ${hhmm(r.start)}-${hhmm(r.end)}`;
  const warnings: string[] = [];
  for (const o of overlaps(runs, (r) => (r.gen ? `gen:${r.gen}` : null), (k) => drivesOf(k.slice(4)))) warnings.push(`more runs at once than ${o.key.slice(4)} drives (${drivesOf(o.key.slice(4))}): ${fmt(o.a)} overlaps ${fmt(o.b)}`);
  for (const o of overlaps(runs, (r) => `pool:${r.pool}`)) warnings.push(`two runs write to pool ${o.key.slice(5)} at once (one tape): ${fmt(o.a)} overlaps ${fmt(o.b)}`);
  if (window) {
    const [fh, fm] = window.from.split(":").map(Number);
    const [th, tm] = window.to.split(":").map(Number);
    for (const r of runs) {
      for (let d = new Date(r.start.getFullYear(), r.start.getMonth(), r.start.getDate() - 1); d <= r.end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
        if (!window.days.includes(d.getDay())) continue;
        const ws = new Date(d.getFullYear(), d.getMonth(), d.getDate(), fh, fm);
        const we = new Date(d.getFullYear(), d.getMonth(), d.getDate(), th, tm);
        if (r.start < we && r.end > ws) {
          warnings.push(`${fmt(r)} reaches into P5's maintenance restart window (${window.from}-${window.to}): the restart waits until idle and gives up at ${window.to}; it will not interrupt the run, but it cannot restart that day`);
          break;
        }
      }
    }
  }
  for (const r of runs) {
    const pl = pools.get(r.pool);
    if (!pl || pl.appendableInLibrary === 0) warnings.push(`${fmt(r)}: pool ${r.pool} has no appendable tape in the library`);
  }
  const uniq = [...new Set(warnings)];
  return {
    from: now.toISOString(),
    days,
    windowOfRestart: window,
    runs: runs.map((r) => ({ start: `${dayStr(r.start)} ${hhmm(r.start)}`, end: `${dayStr(r.end)} ${hhmm(r.end)}`, plan: r.plan, event: r.event, pool: r.pool, driveGeneration: r.gen, expectedMinutes: r.durationMin, durationFromHistory: r.durationKnown })),
    warnings: uniq,
    note: "Expected duration = median of the event's past runs (from the backup index snapshot table; 60 min assumed when there is none). Pending jobs already queued are not part of this forecast.",
  };
}

// ---------------------------------------------------------------------------
// ensure_done
// ---------------------------------------------------------------------------

export interface TaskResult {
  plan: string;
  planId: string;
  event: string;
  runAt: string;
  task: string;
  folders: string;
  state: "ok" | "failed" | "stopped" | "missing" | "waiting";
  job: string | null;
  completion: string | null;
  pool: string;
  level: string;
}

export function classify(rows: JobRow[], task: string, from: Date, to: Date): { state: TaskResult["state"]; job: JobRow | null } {
  const inWin = rows.filter((j) => {
    if (j.task !== task || !j.start) return false;
    const t = new Date(j.start.replace(" ", "T")).getTime();
    return t >= from.getTime() && t < to.getTime();
  });
  const ok = inWin.find(isOk);
  if (ok) return { state: "ok", job: ok };
  const act = inWin.find(isActive);
  if (act) return { state: "waiting", job: act };
  const bad = inWin.sort((a, b) => (b.start ?? "").localeCompare(a.start ?? ""))[0];
  if (bad) return { state: /cancel|terminat/i.test(bad.status) ? "stopped" : "failed", job: bad };
  return { state: "missing", job: null };
}

/** Change time (ms) per BackupTask name from P5's resource database (cstamp, microseconds since epoch). P5 bumps it on every job, so it only approximates creation for tasks that never ran. Empty map when unreadable. */
export async function taskCreated(cfg: ArchiwareConfig): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  try {
    for (const r of await sqliteQuery(cfg, resourcesDb(cfg), "select name,cstamp from BackupTask")) {
      const us = Number(r[1]);
      if (r[0] && Number.isFinite(us) && us > 0) m.set(r[0], Math.floor(us / 1000));
    }
  } catch { /* fall back to no creation times: every task is expected in every run */ }
  return m;
}

export async function ensureDone(cfg: ArchiwareConfig, opts: { since?: string; rerun?: boolean; confirm?: boolean; mail?: boolean } = {}) {
  const now = new Date();
  const since = opts.since ? new Date(opts.since.includes("T") ? opts.since : `${opts.since}T00:00:00`) : new Date(now.getTime() - DAY);
  if (!Number.isFinite(since.getTime())) throw new P5Error(`invalid since "${opts.since}", expected YYYY-MM-DD or YYYY-MM-DDTHH:MM`);
  const plans = (await loadPlans(cfg)).filter((p) => p.enabled);
  const jobs = await loadJobs(cfg, new Date(since.getTime() - 2 * DAY).toISOString().slice(0, 10), 3000);
  const created = await taskCreated(cfg);
  const firstJob = new Map<string, number>();
  for (const j of jobs) {
    if (!j.task || !j.start) continue;
    const t = new Date(j.start.replace(" ", "T")).getTime();
    if (t < (firstJob.get(j.task) ?? Infinity)) firstJob.set(j.task, t);
  }
  const results: TaskResult[] = [];
  for (const p of plans)
    for (const e of p.events)
      for (const run of eventRuns(e, since, now)) {
        const winEnd = new Date(run.getTime() + 20 * 3_600_000);
        for (const t of p.tasks.filter((x) => x.enabled)) {
          // A task cannot be expected in a run it could not take part in: with jobs, that is a run ending before its first job; without any job, a run that started before the task row was last written.
          const first = firstJob.get(t.id);
          if (first !== undefined ? first >= winEnd.getTime() : (created.get(t.id) ?? 0) > run.getTime()) continue;
          const c = classify(jobs.filter((j) => j.plan === p.name || j.plan?.startsWith(`${p.name} - `)), t.id, new Date(run.getTime() - 10 * 60_000), winEnd);
          results.push({ plan: p.name, planId: p.id, event: evLabel(e), runAt: `${dayStr(run)} ${hhmm(run)}`, task: t.id, folders: t.dirs.join(" "), state: c.state, job: c.job?.id ?? null, completion: c.job?.completion ?? c.job?.status ?? null, pool: e.pool, level: e.level === "1" ? "full" : "incr" });
        }
      }
  const bad = results.filter((r) => r.state !== "ok");
  const lines = [
    `Backups since ${dayStr(since)} ${hhmm(since)}: ${results.length} task run(s) expected, ${results.length - bad.length} ok, ${bad.filter((r) => r.state === "failed").length} failed, ${bad.filter((r) => r.state === "stopped").length} stopped, ${bad.filter((r) => r.state === "missing").length} missing, ${bad.filter((r) => r.state === "waiting").length} still waiting/running.`,
    ...bad.map((r) => `${r.state.toUpperCase()}: plan ${r.plan}, run ${r.runAt}, task ${r.task} (${r.folders})${r.job ? `, job ${r.job} ${r.completion}` : ""}`),
  ];
  const out: Record<string, unknown> = { since: since.toISOString(), allDone: bad.length === 0, summary: lines, problems: bad, checked: results.length };
  if (opts.rerun) {
    const todo = bad.filter((r) => r.state === "failed" || r.state === "stopped" || r.state === "missing");
    const groups = new Map<string, TaskResult[]>();
    for (const r of todo) groups.set(`${r.planId}|${r.pool}|${r.level}`, [...(groups.get(`${r.planId}|${r.pool}|${r.level}`) ?? []), r]);
    const planned = [...groups.entries()].map(([k, rs]) => ({ plan: k.split("|")[0], pool: k.split("|")[1], level: k.split("|")[2] as "full" | "incr", tasks: [...new Set(rs.map((x) => x.task))] }));
    const started: unknown[] = [];
    for (const g of planned) started.push(await runTasksOnce(cfg, g.plan, g.tasks, g.pool, g.level, Boolean(opts.confirm)));
    out.rerun = { confirmed: Boolean(opts.confirm), plannedGroups: planned, results: started, note: "Nothing is cancelled. Delete each temporary mcp-once-* plan with run_tasks_once_cleanup after its job finished." };
  }
  if (opts.mail) {
    await sendHostMail(cfg, `P5 backup check: ${bad.length === 0 ? "all done" : `${bad.length} problem(s)`}`, lines.join("\n"));
    out.mailed = "sent via the host MTA to operatorMail";
  }
  return out;
}

export function formatEnsureDone(r: Record<string, unknown>): string {
  return (r.summary as string[]).join("\n");
}

