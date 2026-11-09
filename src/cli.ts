#!/usr/bin/env node
/**
 * archiware — CLI exposing the same operations as the MCP server.
 *
 * Usage: archiware <command> [args] [--json] [--yes]
 * Default output is a table; --json prints raw JSON.
 * Mutating commands require --yes; without it they print what WOULD run.
 */

import { loadConfig } from "./config.js";
import { configPath, missingKeys } from "./config.js";
import { doctorExitCode, formatDoctor, runDoctor } from "./doctor.js";
import { runSetup, SETUP_FLAGS, SETUP_USAGE, type SetupOptions } from "./setup.js";
import { runUpdate } from "./update.js";
import { VERSION } from "./version.js";
import * as ops from "./operations.js";
import * as tape from "./tapeops.js";
import * as rops from "./restops.js";
import * as cops from "./containerops.js";
import * as tops from "./taskops.js";
import { restRequest, restResources, type RestMethod } from "./rest.js";
import * as lib from "./libops.js";
import * as gov from "./govops.js";
import * as cat from "./catalog.js";
import * as idx from "./indexsync.js";
import * as ff from "./findfile.js";
import * as viewer from "./viewer.js";
import { P5Error } from "./transport.js";

const USAGE = `archiware — manage an Archiware P5 server (docker, ssh or local mode)

Commands:
  setup [--mode ...]     configure, create the REST password file, register with Claude Code (setup --help)
  doctor                 configuration + connectivity report with fix hints (exit 1 on fail)
  update [--check]       update to the latest GitHub Release (or only report)
  version                print the version
  status                 devices, jukeboxes, pools with usage, running/scheduled jobs
  slots                  per-slot barcode (mtx) + P5 volume info, drive loaded state
  volumes                all volumes: label, barcode, type, location, mode, state, pool, sizes
  pools                  pools with mediatype, usage, volumes
  plans                  backup plans (and archive plans) with enabled, events, tasks
  plan <id>              one plan in detail: settings, events, tasks
  jobs [--all]           jobs with label, status, last report lines (--all = +7 days completed)
  job <id>               one job: status, report, protocol
  dryrun_plan <id>       start a dry-run job (safe, no --yes needed)
  start_plan <id>        start a backup now          (needs --yes)
  enable_plan <id>       enable a plan               (needs --yes)
  disable_plan <id>      disable a plan              (needs --yes)
  stop_job <id>          stop a scheduled job        (needs --yes)
  label_tapes <jukebox> <pool> <slot...> [--drive <device>]
                         DESTRUCTIVE: label EMPTY tapes; --drive forces that drive (needs --yes)
  restore_lookup <volume|job> [--job]               list what a backup volume (or job's volumes) holds
  restore --at "<start>" <path> [--to <dir>] [--client C]   plan for one path at the version chosen from restore_options: full preview + P5 GUI steps (P5 CLI cannot restore a single backup path); --yes --plan <id> prepares the folder
  restore_archive <path> [--index I] [--to <dir>]   restore one ARCHIVE entry (RestoreSelection addentry); preview, then --yes --plan <id>
  restore_volume <volume> [--to <dir>]              EXPLICIT whole-volume restore (everything on the volume); preview, then --yes --plan <id>
  add_plan_folder <plan> <path>                   add one folder as a new enabled task (needs --yes)
  add_plan_folders <plan> <path...> [--filter <f>]  add folders as enabled tasks (needs --yes)
  create_plan <name> [--retention <days>]         create a plan (needs --yes)
  set_plan_retention <plan> <days>                set plan retention (needs --yes)
  delete_plan <plan>                              delete a plan (needs --yes)
  volume_enable <volume> on|off                   enable/disable a volume (needs --yes)
  plan_event <plan> <pool> <level> <frequency...> <firstrun YYYY-MM-DDTHH:MM> [--exception "<spec>"]
                         add an event; level 1 full, 0 incr, -1 synthetic; time is the local time zone (needs --yes)
  set_cleaning <device> <0|1>                       set a drive's cleaning flag (needs --yes)
  inventory <jukebox> [--barcode]                   schedule inventory job (needs --yes)
  tape_load <slot>                                  load tape into matching drive, leave loaded (needs --yes)
  tape_unload <slot>                                rewind + unload back to slot    (needs --yes)
  tape_read_header <slot>                           read first block (256k then 1M), always unloads after
  tape_erase <slot...>                              DESTRUCTIVE: destroy tape contents (rewind + mt erase 0) (needs --yes)
  clean_drive <p5 device|gen>                       clean drive with CLN* tape, reset P5 cleaning flag (needs --yes)
  job_cancel <id>        cancel a running or waiting job via REST (needs --yes)
  job-history [--plan <name|id>] [--status <s>] [--since YYYY-MM-DD] [--limit N]
                         past jobs (newest first): plan, task, status, start, size, files, source line
  find-tasks <substring> plans and tasks whose directories contain the substring (+ enabled flags)
  task enable|disable <task>                      enable/disable a backup task, read back (needs --yes)
  task set-dirs <task> <dir...>                   replace a task's directories, read back (needs --yes)
  run-once <plan> <task...> [--pool P] [--level full|incr]
                         back up chosen tasks once via a temporary plan (needs --yes)
  run-once-cleanup <temp plan>                    delete a temporary run-once plan (needs --yes)
  governance_report      per plan: schedule in words, folders, last run per task, retention; flags with keep/merge/disable/delete; pools; server settings (restart window, mail)
  governance_apply <item>  apply ONE recommendation: disable-plan:<id> | delete-plan:<id> | disable-task:<id> (needs --yes, read back)
  schedule_check [--days N]  timeline of enabled events with expected duration, drive generation, pool; overlaps, restart window, pools without appendable tape
  ensure_done [--since T] [--rerun] [--mail]  every scheduled run since T: did every task produce a successful job? --rerun re-runs the failed/missing tasks once (needs --yes); --mail sends the result to operatorMail through the host MTA
  notify_status          P5 mail setup in words (SMTP server, port, TLS, sender, auth, recipients) + what its log says
  notify_set [--server S --port N --tls T --sender A --user U --password-file F --recipients a,b]   P5 offers no API for this: prints why and the GUI steps
  notify_test [--yes]    SMTP reachability from P5, log evidence; with --yes also a test mail via the host MTA to operatorMail
  library_layout         per slot: barcode, P5 label/pool, target pool (config slotLayout), ok/misplaced/foreign/empty; drives, mail slots
  library_arrange        minimal mtx move list to reach the slotLayout (dry plan; --yes runs it, refused while busy)
  tape_export <barcode|label>                     slot -> first free mail slot (dry plan; --yes)
  tape_import [mail slot]                         mail slot -> its pool's slot per slotLayout (dry plan; --yes)
  restore_options <path> [--since YYYY-MM-DD] [--client C]   every backed-up version of a file/folder from P5's backup index, newest first, with the volumes (copies) holding it, barcode, location, fetch list
  offsite_status [--path <p>]                     per pool: volumes in library / mail slot / out; pools with nothing out; fetch list for a path
  library_plan arrange | export <tape> | import [mail slot] [--simulate]    start a step-by-step session
  library_step <session> [--yes]                  execute exactly one next step (human steps are verified)
  library_status <session> / library_abort <session>
  library_reconcile [--yes]                       compare P5 volume locations with mtx, cleaningSlot, plan events (--yes fixes cleaningSlot in the config)
  catalog_init           create the file catalogue schema (MySQL archive_catalog) idempotently
  pack <source dir> --set NAME [--max 50G] [--into <pack root>] [--replan] [--detach]   cut a folder into tars and catalogue every file (plan without --yes; --yes writes, resumable; --detach runs it on the host)
  pack_status --set NAME   detached pack: tars done/total, bytes, current tar, rate, ETA, log tail
  pack_stop --set NAME     stop a detached pack after the current tar (needs --yes)
  catalog_sets           sets with tars, files, bytes, status
  index_sync [--client C] [--full] [--detach] [--no-dtime]   copy P5's backup index (names, dirs, versions) into the catalogue db; incremental unless --full
  index_status   index_sync state per client (last id/btime, rows), table sizes, detached runs with rows/s
  find_file <name|glob> [--client C] [--since YYYY-MM-DD] [--under /path] [--limit N]   every backed-up version of every matching file, each with all places to fetch it from, cheapest first
  restore_version <path> <versionKey> [--to original|<dir>] [--on-conflict refuse|rename|overwrite] [--force-sync] [--from <location id>] [--client C]   restore one version from its cheapest place; no --yes = preview with planId, then --yes --plan <id>
  catalog_search <pattern> [--set NAME] [--limit N]   find files (glob or substring) with tar, on-disk and tape location
  catalog_restore <path> --set NAME [--to original|<dir>] [--on-conflict ...]   extract one file from its tar (preview, then --yes --plan <id>)
  catalog_drop --set NAME                         delete a set's catalogue rows, not its tars (needs --yes)
  viewer_deploy --network N --catalog-ip IP --db-ip IP [--host H] [--dir D] [--data-dir D] [--p5-index D] [--pack-root D] [--subpath S] [--viewer-user U] [--p5-base-url URL] [--tz Z]
                         deploy the catalogue viewer (web page + its own MariaDB + nightly dump) on a docker host (plan without --yes)
  viewer_status          viewer containers, health, database size, last dump, cache entries
  catalog_migrate --from <host[:port]> --user U --password-file F [--source-tls verify|skip-verify|off] [--force]   copy archive_catalog from an existing MySQL into the viewer's database; F is read on THIS machine; skip-verify for a self-signed source cert (plan without --yes)
  health                 one-call P5 health check (exit code 1 on any fail; part of doctor)
  rest_resources         list the REST API resources
  rest <path> [--method GET|POST|PUT|DELETE] [--body <json>]
                         REST passthrough under /rest/v1 (non-GET needs --yes)
  container_status       state, image, version, newest backup of the P5 container
  container_backup [--restart] [--force]            cold backup, STOPS the container (needs --yes)
  container_stop [--force]                          docker stop -t 120 (needs --yes)
  container_start                                   docker start, wait for srvinfo (needs --yes)
  container_update <file.deb> [--skip-backup-check] [--force]   install a .deb in the container (needs --yes)
  nsdchat <args...>      raw nsdchat passthrough (non-read-only methods need --yes)

Options:
  --json   print JSON instead of a table
  --yes    confirm mutating commands
  --force  override the "library busy" check on tape_* / clean_drive
`;

const VALUE_FLAGS = new Set(["drive", "plan", "status", "since", "limit", "pool", "level", "exception", "filter", "retention", "method", "body", "config", "job", "mail-slot", "at", "client", "days", "password-file", "server", "port", "tls", "sender", "user", "recipients", "set", "max", "into", "to", "on-conflict", "host", "dir", "data-dir", "network", "catalog-ip", "db-ip", "p5-index", "pack-root", "subpath", "viewer-user", "p5-base-url", "tz", "from", "source-tls", "under", ...Object.keys(SETUP_FLAGS)]);

function parseArgs(argv: string[]) {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      flags.add(name);
      if (VALUE_FLAGS.has(name) && i + 1 < argv.length) values.set(name, argv[++i]);
    } else positional.push(a);
  }
  return { flags, values, positional };
}

function safetyOf(values: Map<string, string>, flags: Set<string>, confirm: boolean, to = values.get("to")) {
  return { to, onConflict: values.get("on-conflict"), forceSync: flags.has("force-sync"), plan: values.get("plan"), confirm };
}

const cliProgress = (m: string) => console.error(`[progress] ${m}`);

function printJson(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

function table(rows: Record<string, unknown>[], columns: string[]) {
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  const cells = rows.map((r) => columns.map((c) => (r[c] == null ? "-" : String(r[c]))));
  const header = columns.map((c) => c.toUpperCase());
  const widths = columns.map((c, i) => Math.max(c.length, ...cells.map((row) => row[i].length)));
  const fmt = (row: string[]) => row.map((v, i) => v.padEnd(widths[i])).join("  ");
  console.log(fmt(header));
  for (const row of cells) console.log(fmt(row));
}

/** Text form of a restore plan (finishGuard preview): every field, nothing dropped. */
function printRestorePlan(d: Record<string, unknown>) {
  const kb = (n: unknown) => (typeof n === "number" ? `${n} bytes (${(n / 1048576).toFixed(1)} MiB)` : "unknown");
  console.log(`Restore plan ${d.planId}${d.executed === false ? " (the tool does not start a P5 job for this)" : ""}`);
  console.log(`  source:       ${d.source}`);
  console.log(`  host:         ${d.host}`);
  console.log(`  destination:  ${d.destination} (${d.destinationMode})`);
  console.log(`  bytes:        ${kb(d.bytesToWrite)}`);
  console.log(`  free space:   ${kb(d.freeBytesAtDestination)}`);
  console.log(`  entries:      ${d.entries}`);
  console.log(`  policy:       ${d.conflictPolicy}`);
  const c = d.conflicts as { count: number; first50: { path: string; current: { size: number; mtime: string }; restored: { size: number; mtime: string } }[]; more: number };
  console.log(`  conflicts:    ${c.count}`);
  for (const x of c.first50) console.log(`    ${x.path}: now ${x.current.size} bytes ${x.current.mtime}, restored ${x.restored.size} bytes ${x.restored.mtime}`);
  if (c.more) console.log(`    ... ${c.more} more`);
  console.log("  tree:");
  for (const t of d.tree as string[]) console.log(`    ${t}`);
  if ((d.treeMore as number) > 0) console.log(`    ... ${d.treeMore} more`);
  for (const w of (d.warnings as string[]) ?? []) console.log(`  WARNING: ${w}`);
  for (const n of (d.notes as string[] | undefined) ?? []) console.log(`  note: ${n}`);
  const m = d.manual as { why: string; p5: string; steps: string[]; volumesNeeded: { volume: string; label: string | null; barcode: string | null; location: string | null }[] } | undefined;
  if (m) {
    console.log(`\n${m.why}`);
    console.log("Volumes holding this version:");
    for (const v of m.volumesNeeded) console.log(`  ${v.label ?? v.volume} (volume ${v.volume}) barcode ${v.barcode ?? "none"} - ${v.location}`);
    console.log("Do in the P5 GUI:");
    m.steps.forEach((x, i) => console.log(`  ${i + 1}. ${x}`));
  }
  if (Array.isArray(d.wouldRun)) {
    console.log("Would run:");
    for (const cmd of d.wouldRun as string[]) console.log(`  ${cmd}`);
  }
  if (typeof d.destinationPrepared === "string") console.log(`\nDestination folder created: ${d.destinationPrepared}`);
  if (d.refused) console.log(`\nREFUSED: ${d.refused}`);
  else if (d.confirmationRequired === true) console.log(`\n${d.next}\n  i.e. --yes --plan ${d.planId}`);
}

function printResult(name: string, data: unknown, json: boolean) {
  if (json) {
    printJson(data);
    return;
  }
  const d = data as Record<string, unknown>;
  if (typeof d.planId === "string" && Array.isArray(d.tree)) {
    printRestorePlan(d);
    return;
  }
  // Any mutation without --yes: print the exact commands that WOULD run.
  if (d.confirmationRequired === true && !Array.isArray(d.wouldRun)) {
    printJson(data);
    console.log("\nRe-run with --yes to actually do it.");
    return;
  }
  if (d.confirmationRequired === true) {
    console.log(d.note as string);
    console.log("Would run:");
    for (const cmd of d.wouldRun as string[]) console.log(`  ${cmd}`);
    for (const p of (d.problems as string[] | undefined) ?? []) console.log(`PROBLEM: ${p}`);
    console.log("Re-run with --yes to actually do it.");
    return;
  }
  switch (name) {
    case "status": {
      console.log(`P5 version: ${(d.server as { version: string }).version}`);
      console.log(`Devices: ${(d.devices as string[]).join(", ")}`);
      console.log(`Jukeboxes: ${(d.jukeboxes as string[]).join(", ")}`);
      console.log("\nPools:");
      table(d.pools as Record<string, unknown>[], ["name", "usage", "mediatype", "usedsize_human", "totalsize_human", "usedPercent"]);
      console.log("\nJobs (running/scheduled):");
      table(d.jobs as Record<string, unknown>[], ["id", "status", "label", "resource"]);
      break;
    }
    case "slots":
      table(d.slots as Record<string, unknown>[], ["slot", "barcode", "full", "loadedInDrive", "p5Volume", "label", "pool", "mode", "state", "unknownToP5"]);
      console.log("\nDrives:");
      table(d.drives as Record<string, unknown>[], ["drive", "full", "loadedFromSlot", "barcode"]);
      break;
    case "volumes":
      table(d as unknown as Record<string, unknown>[], ["id", "label", "barcode", "mediatype", "location", "mode", "state", "pool", "usedsize_human", "totalsize_human", "dateexpires"]);
      break;
    case "pools":
      table(d as unknown as Record<string, unknown>[], ["name", "usage", "mediatype", "volumes", "usedsize_human", "totalsize_human", "usedPercent"]);
      break;
    case "plans": {
      const p = d as unknown as { backupPlans: Record<string, unknown>[]; archivePlans: Record<string, unknown>[] };
      table(p.backupPlans, ["id", "describe", "enabled", "eventnames", "tasknames"]);
      if (p.archivePlans.length > 0) {
        console.log("\nArchive plans:");
        table(p.archivePlans, ["id", "describe", "enabled"]);
      }
      break;
    }
    case "plan": {
      const p = d as unknown as Record<string, unknown>;
      console.log(`Plan ${p.id}: ${p.describe} (${p.enabled ? "enabled" : "disabled"})`);
      console.log(`Retention: ${p.retention_days} days, loglevel ${p.loglevel}, progressive ${p.progressive}`);
      console.log("\nEvents:");
      table(p.events as Record<string, unknown>[], ["name", "pool", "level", "frequency", "exception", "firstrun_local"]);
      console.log("\nTasks:");
      table(
        (p.tasks as Record<string, unknown>[]).map((t) => ({ ...t, directories: (t.directories as string[]).join(" ") })),
        ["name", "client", "enabled", "directories"],
      );
      break;
    }
    case "jobs":
      table(d as unknown as Record<string, unknown>[], ["id", "status", "completion", "label", "report_last_lines"]);
      break;
    case "job": {
      const j = d as unknown as Record<string, unknown>;
      console.log(`Job ${j.id}: ${j.label} — ${j.status} (${j.completion ?? "-"})`);
      console.log(`Resource: ${j.resourcegroup} ${j.resourcename}; started ${j.runat ?? "-"}; ${j.totalkbytes_human ?? "-"}, ${j.totalfiles ?? "-"} files`);
      if (j.report) console.log(`\nReport:\n${j.report}`);
      if (j.protocol) console.log(`\nProtocol:\n${j.protocol}`);
      break;
    }
    case "governance_report": {
      const g = d as unknown as { plans: Record<string, any>[]; pools: Record<string, unknown>[]; server: string[]; flags: Record<string, unknown>[]; foldersInSeveralPlans: Record<string, unknown>[] };
      for (const p of g.plans) {
        console.log(`\n${p.enabled ? "ENABLED " : "disabled"} ${p.name} (${p.id}) retention ${p.retentionDays} d, ${p.taskCount} task(s), last run ${p.lastRun ? `${p.lastRun.start} ${p.lastRun.result}` : "none in window"}`);
        for (const e of p.events) console.log(`   event ${e.name}: ${e.level} into pool ${e.pool}, ${e.frequency}; next ${e.nextRun ?? "none"}`);
        for (const t of p.tasks) console.log(`   task ${t.task}${t.enabled ? "" : " (disabled)"}: ${t.folders.join(" ")}${t.foldersMissing.length ? "  [MISSING: " + t.foldersMissing.join(" ") + "]" : ""} -> ${t.lastRun ? `${t.lastRun.start} ${t.lastRun.result} (job ${t.lastRun.job})` : "never ran in window"}`);
        for (const f of p.flags) console.log(`   FLAG: ${f.reason} => ${f.recommendation}${f.apply ? `  [${f.apply}]` : ""}`);
      }
      console.log("\nFolders backed up by several enabled plans:");
      table(g.foldersInSeveralPlans.map((o) => ({ folder: o.folder, kind: o.kind, plans: (o.plans as string[]).join(", ") })), ["folder", "kind", "plans"]);
      console.log("\nPools:");
      table(g.pools.map((p) => ({ ...p, flags: (p.flags as string[]).join("; ") })), ["pool", "mediaType", "generation", "volumes", "inLibrary", "appendableInLibrary", "flags"]);
      console.log("\nServer settings:");
      for (const l of g.server) console.log(`  - ${l}`);
      console.log(`\n${g.flags.length} flag(s).`);
      break;
    }
    case "schedule_check": {
      const r = d as unknown as { runs: Record<string, unknown>[]; warnings: string[]; note: string };
      table(r.runs, ["start", "end", "plan", "event", "pool", "driveGeneration", "expectedMinutes", "durationFromHistory"]);
      console.log("");
      for (const w of r.warnings) console.log(`WARNING: ${w}`);
      console.log(`\n${r.runs.length} run(s), ${r.warnings.length} warning(s). ${r.note}`);
      break;
    }
    case "ensure_done":
      for (const l of (d as unknown as { summary: string[] }).summary) console.log(l);
      for (const k of ["rerun", "mailed"]) if (d[k] !== undefined) console.log(`${k}: ${JSON.stringify(d[k])}`);
      break;
    case "notify_status": {
      for (const l of (d as unknown as { words: string[] }).words) console.log(`- ${l}`);
      console.log(`\n${(d as { where: string }).where}`);
      if ((d as { problem: string | null }).problem) console.log(`PROBLEM: ${(d as { problem: string }).problem}`);
      break;
    }
    case "job-history": {
      const h = d as unknown as { jobs: Record<string, unknown>[]; scannedIds: number; roundTrips: number };
      table(h.jobs, ["id", "plan", "task", "status", "completion", "start", "size", "files", "source"]);
      console.log(`\n${h.jobs.length} job(s); ${h.scannedIds} ids scanned in ${h.roundTrips} ssh round trips`);
      break;
    }
    case "find-tasks":
      table((d as unknown as { matches: Record<string, unknown>[] }).matches, ["plan", "describe", "plan_enabled", "task", "task_enabled", "directories"]);
      break;
    case "task": {
      const t = d as unknown as { task: string; before: Record<string, unknown>; after: Record<string, unknown> };
      console.log(`Task ${t.task}: ${JSON.stringify(t.before)} -> ${JSON.stringify(t.after)}`);
      break;
    }
    case "library_layout": {
      const l = d as unknown as { slots: Record<string, unknown>[]; drives: Record<string, unknown>[]; mailSlots: number[]; summary: Record<string, number>; warnings: string[]; poolsWithTapesButNoSlots: string[] };
      table(l.slots, ["slot", "kind", "barcode", "label", "pool", "targetPool", "status", "note"]);
      console.log("\nDrives:");
      table(l.drives, ["drive", "barcode", "label", "pool", "status"]);
      console.log(`\nSummary: ${JSON.stringify(l.summary)}; mail slots: ${l.mailSlots.join(", ") || "none"}`);
      if (l.poolsWithTapesButNoSlots.length) console.log(`Pools with tapes but no slotLayout entry: ${l.poolsWithTapesButNoSlots.join(", ")}`);
      for (const w of l.warnings) console.log(`WARNING: ${w}`);
      break;
    }
    case "restore_options": {
      const r = d as unknown as { path: string; versions: Record<string, any>[]; fetchList: Record<string, unknown>[]; note: string };
      table(
        r.versions.map((v) => ({ start: v.start, modified: v.mtime, plan: v.plan, level: v.level, size: ops.kbToHuman(v.sizeBytes / 1024), volume: v.volumes.map((x: any) => x.label ?? x.id).join(","), barcode: v.volumes.map((x: any) => x.barcode ?? "-").join(","), where: v.volumes.map((x: any) => x.location).join(", ") })),
        ["start", "modified", "plan", "level", "size", "volume", "barcode", "where"],
      );
      console.log("\nFetch list (tapes not in the library):");
      table(r.fetchList, ["barcode", "label", "volume", "versions"]);
      console.log(`\n${r.note}`);
      break;
    }
    case "offsite_status": {
      const o = d as unknown as { pools: { pool: string; inLibrary: number; inMailSlot: number; out: number; warnings: string[] }[]; warnings: string[]; fetchList?: Record<string, unknown>[] };
      table(o.pools.map((p) => ({ pool: p.pool, library: p.inLibrary, mail: p.inMailSlot, out: p.out })), ["pool", "library", "mail", "out"]);
      for (const w of o.warnings) console.log(`WARNING: ${w}`);
      if (o.fetchList) {
        console.log("\nFetch list:");
        table(o.fetchList, ["barcode", "label", "volume", "jobs"]);
      }
      break;
    }
    case "library_session": {
      const v = d as unknown as { session: string; op: string; simulated: boolean; state: string; note: string; done: string[]; next: string | null; remaining: string[]; stopped?: string; executed?: boolean; hint?: string };
      console.log(`Session ${v.session} (${v.op}${v.simulated ? ", SIMULATED" : ""}) ${v.state}: ${v.note}`);
      for (const x of v.done) console.log(`  done  ${x}`);
      if (v.next) console.log(`  NEXT  ${v.next}`);
      for (const x of v.remaining) console.log(`  todo  ${x}`);
      if (v.stopped) console.log(`STOPPED: ${v.stopped}`);
      if (v.hint) console.log(v.hint);
      break;
    }
    case "tape_read_header": {
      const t = d as unknown as Record<string, unknown>;
      console.log(`Slot ${t.slot} (${t.barcode}) in drive ${t.drive}: read ${t.bytes} bytes with bs=${t.blockSize}`);
      console.log(`mt: file ${t.file ?? "-"}, block ${t.block ?? "-"}`);
      const strings = (t.printableStrings as string[]) ?? [];
      if (strings.length > 0) {
        console.log("\nPrintable strings:");
        for (const s of strings.slice(0, 20)) console.log(`  ${JSON.stringify(s)}`);
      }
      break;
    }
    case "tape_erase": {
      const rows = d as unknown as { results: Record<string, unknown>[] };
      table(rows.results, ["slot", "barcode", "drive", "erased", "eraseError", "unloadError"]);
      break;
    }
    case "clean_drive": {
      const t = d as unknown as Record<string, unknown>;
      console.log(`Drive ${t.drive} (P5 ${t.p5}): ${t.cleanResult}`);
      if (t.unloadError) console.log(`Unload problem: ${t.unloadError}`);
      console.log(`P5: ${t.p5Cleaning}`);
      break;
    }
    case "health": {
      const h = d as unknown as { overall: string; checks: { name: string; level: string; reason: string }[] };
      for (const c of h.checks) console.log(`${c.level.toUpperCase().padEnd(4)}  ${c.name.padEnd(14)} ${c.reason}`);
      console.log(`\nOverall: ${h.overall.toUpperCase()}`);
      break;
    }
    default:
      printJson(data);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, values, positional } = parseArgs(argv);
  const cmd = positional[0];
  const json = flags.has("json");
  const yes = flags.has("yes");
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return;
  }
  if (cmd === "setup") {
    if (flags.has("help")) {
      console.log(SETUP_USAGE);
      return;
    }
    const opts: SetupOptions = { yes, noRegister: flags.has("no-register") };
    for (const [flag, key] of Object.entries(SETUP_FLAGS)) {
      const v = values.get(flag);
      if (v !== undefined) (opts as Record<string, unknown>)[key] = v;
    }
    process.exitCode = await runSetup(opts);
    return;
  }
  if (cmd === "version" || flags.has("version")) {
    console.log(VERSION);
    return;
  }
  if (cmd === "update") {
    process.exitCode = await runUpdate(flags.has("check"));
    return;
  }
  const configFile = values.get("config") ?? configPath();
  if (values.has("config")) process.env.ARCHIWARE_CONFIG = configFile;
  const cfg = loadConfig(configFile);
  if (cmd === "doctor") {
    const lines = await runDoctor(cfg, configFile);
    if (json) printJson(lines);
    else console.log(formatDoctor(lines));
    process.exitCode = doctorExitCode(lines);
    return;
  }
  const gaps = missingKeys(cfg).filter((k) => k !== "restPasswordFile" && k !== "restUser");
  if (gaps.length) throw new Error(`not configured (mode ${cfg.mode}: missing ${gaps.join(", ")}); run \`archiware setup\` or \`archiware doctor\``);
  switch (cmd) {
    case "status":
      printResult("status", await rops.status(cfg), json);
      break;
    case "slots":
      printResult("slots", await ops.slots(cfg), json);
      break;
    case "volumes":
      printResult("volumes", await ops.volumes(cfg), json);
      break;
    case "pools":
      printResult("pools", await ops.pools(cfg), json);
      break;
    case "plans":
      printResult("plans", await ops.plans(cfg), json);
      break;
    case "plan": {
      const id = positional[1];
      if (!id) throw new Error("usage: archiware plan <id>");
      printResult("plan", await ops.plan(cfg, id), json);
      break;
    }
    case "jobs":
      printResult("jobs", await rops.jobs(cfg, flags.has("all")), json);
      break;
    case "job": {
      const id = positional[1];
      if (!id) throw new Error("usage: archiware job <id>");
      printResult("job", await rops.job(cfg, id), json);
      break;
    }
    case "dryrun_plan": {
      const id = positional[1];
      if (!id) throw new Error("usage: archiware dryrun_plan <id>");
      printResult("dryrun_plan", await ops.dryrunPlan(cfg, id), json);
      break;
    }
    case "start_plan": {
      const id = positional[1];
      if (!id) throw new Error("usage: archiware start_plan <id> --yes");
      printResult("start_plan", await ops.startPlan(cfg, id, yes), json);
      break;
    }
    case "enable_plan": {
      const id = positional[1];
      if (!id) throw new Error("usage: archiware enable_plan <id> --yes");
      printResult("enable_plan", await ops.enablePlan(cfg, id, yes), json);
      break;
    }
    case "disable_plan": {
      const id = positional[1];
      if (!id) throw new Error("usage: archiware disable_plan <id> --yes");
      printResult("disable_plan", await ops.disablePlan(cfg, id, yes), json);
      break;
    }
    case "stop_job": {
      const id = positional[1];
      if (!id) throw new Error("usage: archiware stop_job <id> --yes");
      printResult("stop_job", await ops.stopJob(cfg, id, yes), json);
      break;
    }
    case "label_tapes": {
      const [jukebox, pool, ...slotIds] = positional.slice(1);
      if (!jukebox || !pool || slotIds.length === 0) throw new Error("usage: archiware label_tapes <jukebox> <pool> <slot...> --yes");
      printResult("label_tapes", await ops.labelTapes(cfg, jukebox, pool, slotIds, yes, values.get("drive")), json);
      break;
    }
    case "restore_lookup": {
      const id = positional[1];
      if (!id) throw new Error("usage: archiware restore_lookup <id> [--job]");
      printResult("restore_lookup", await ops.restoreLookup(cfg, flags.has("job") ? { job: id } : { volume: id }), json);
      break;
    }
    case "restore": {
      const at = values.get("at");
      const path = positional[1];
      if (!at || !path) throw new Error('usage: archiware restore --at "<YYYY-MM-DD HH:MM>" <path> [--to <dir>] [--client C] [--on-conflict refuse|overwrite] [--plan <id>] [--yes]\n  (P5 cannot restore one path of a backup via CLI: this prints the plan and the P5 GUI steps; for a whole volume use restore_volume, for archive entries restore_archive)');
      printResult("restore", await lib.restoreVersion(cfg, at, path, safetyOf(values, flags, yes, positional[2] ?? values.get("to")), values.get("client")), json);
      break;
    }
    case "restore_volume": {
      if (!positional[1]) throw new Error("usage: archiware restore_volume <volume> [--to <dir>] [--on-conflict refuse|overwrite] [--plan <id>] [--yes]   (restores EVERYTHING on the volume)");
      printResult("restore", await ops.restoreVolume(cfg, positional[1], safetyOf(values, flags, yes, positional[2] ?? values.get("to"))), json);
      break;
    }
    case "restore_archive": {
      if (!positional[1]) throw new Error("usage: archiware restore_archive <path> [--index Default-Archive] [--to <dir>] [--on-conflict refuse|overwrite] [--plan <id>] [--yes]");
      printResult("restore", await ops.restoreArchiveEntry(cfg, positional[1], safetyOf(values, flags, yes, positional[2] ?? values.get("to")), values.get("index")), json);
      break;
    }
    case "governance_report":
      printResult("governance_report", await gov.governanceReport(cfg), json);
      break;
    case "governance_apply": {
      if (!positional[1]) throw new Error("usage: archiware governance_apply <disable-plan:ID|delete-plan:ID|disable-task:ID> --yes");
      printResult("governance_apply", await gov.governanceApply(cfg, positional[1], yes), json);
      break;
    }
    case "schedule_check":
      printResult("schedule_check", await gov.scheduleCheck(cfg, { days: values.has("days") ? Number(values.get("days")) : undefined }), json);
      break;
    case "ensure_done": {
      const r = await gov.ensureDone(cfg, { since: values.get("since"), rerun: flags.has("rerun"), confirm: yes, mail: flags.has("mail") });
      printResult("ensure_done", r, json);
      process.exitCode = r.allDone ? 0 : 3;
      break;
    }
    case "notify_status": {
      const n = await gov.notifyStatus(cfg);
      printResult("notify_status", n, json);
      break;
    }
    case "notify_set":
      printResult("notify_set", await gov.notifySet(cfg, { server: values.get("server"), port: values.has("port") ? Number(values.get("port")) : undefined, tls: values.get("tls"), sender: values.get("sender"), user: values.get("user"), passwordFile: values.get("password-file"), recipients: values.get("recipients")?.split(",") }, yes), json);
      break;
    case "notify_test":
      printResult("notify_test", await gov.notifyTest(cfg, yes), json);
      break;
    case "catalog_init":
      printResult("catalog_init", await cat.catalogInit(cfg), json);
      break;
    case "viewer_deploy":
      printResult("viewer_deploy", await viewer.viewerDeploy(cfg, { host: values.get("host"), dir: values.get("dir"), dataDir: values.get("data-dir"), network: values.get("network"), catalogIp: values.get("catalog-ip"), dbIp: values.get("db-ip"), p5Index: values.get("p5-index"), packRoot: values.get("pack-root"), subpath: values.get("subpath"), viewerUser: values.get("viewer-user"), p5BaseUrl: values.get("p5-base-url"), tz: values.get("tz"), confirm: yes }), json);
      break;
    case "viewer_status":
      printResult("viewer_status", await viewer.viewerStatus(cfg), json);
      break;
    case "catalog_migrate": {
      if (!values.get("from") || !values.get("user") || !values.get("password-file")) throw new Error("usage: archiware catalog_migrate --from <host[:port]> --user U --password-file F [--source-tls verify|skip-verify|off] [--force] [--yes]");
      printResult("catalog_migrate", await viewer.catalogMigrate(cfg, { from: values.get("from")!, user: values.get("user")!, passwordFile: values.get("password-file")!, confirm: yes, force: flags.has("force"), sourceTls: values.get("source-tls") as "verify" | "skip-verify" | "off" | undefined }), json);
      break;
    }
    case "pack": {
      if (!positional[1] || !values.get("set")) throw new Error("usage: archiware pack <source dir> --set NAME [--max 50G] [--into <pack root>] [--yes]");
      printResult("pack", await cat.pack(cfg, positional[1], { set: values.get("set")!, max: values.get("max"), into: values.get("into"), confirm: yes, replan: flags.has("replan"), detach: flags.has("detach") }, cliProgress), json);
      break;
    }
    case "pack_status":
      if (!values.get("set")) throw new Error("usage: archiware pack_status --set NAME");
      printResult("pack_status", await cat.packStatus(cfg, values.get("set")!), json);
      break;
    case "pack_stop":
      if (!values.get("set")) throw new Error("usage: archiware pack_stop --set NAME [--yes]");
      printResult("pack_stop", await cat.packStop(cfg, values.get("set")!, yes), json);
      break;
    case "catalog_sets":
      printResult("catalog_sets", await cat.catalogSets(cfg), json);
      break;
    case "index_sync":
      printResult("index_sync", await idx.indexSync(cfg, { client: values.get("client"), full: flags.has("full"), detach: flags.has("detach"), noDtime: flags.has("no-dtime") }, cliProgress), json);
      break;
    case "index_status":
      printResult("index_status", await idx.indexStatus(cfg), json);
      break;
    case "find_file": {
      if (!positional[1]) throw new Error("usage: archiware find_file <name|glob> [--client C] [--since YYYY-MM-DD] [--under /path] [--limit N]");
      printResult("find_file", await ff.findFile(cfg, positional[1], { client: values.get("client"), since: values.get("since"), under: values.get("under"), limit: values.has("limit") ? Number(values.get("limit")) : undefined }), json);
      break;
    }
    case "restore_version": {
      if (!positional[1] || !positional[2]) throw new Error("usage: archiware restore_version <path> <versionKey: mtime-size> [--to original|<dir>] [--on-conflict refuse|rename|overwrite] [--plan <id>] [--force-sync] [--from <location id>] [--client C] [--yes]");
      printResult("restore_version", await ff.restoreFileVersion(cfg, positional[1], positional[2], { ...safetyOf(values, flags, yes), from: values.get("from"), client: values.get("client") }), json);
      break;
    }
    case "catalog_search": {
      if (!positional[1]) throw new Error("usage: archiware catalog_search <pattern> [--set NAME] [--limit N]");
      printResult("catalog_search", await cat.catalogSearch(cfg, positional[1], { set: values.get("set"), limit: values.has("limit") ? Number(values.get("limit")) : undefined }), json);
      break;
    }
    case "catalog_restore": {
      if (!positional[1] || !values.get("set")) throw new Error("usage: archiware catalog_restore <path> --set NAME [--to original|<dir>] [--on-conflict refuse|rename|overwrite] [--plan <id>] [--force-sync] [--yes]");
      printResult("catalog_restore", await cat.catalogRestore(cfg, positional[1], { ...safetyOf(values, flags, yes), set: values.get("set")! }, cliProgress), json);
      break;
    }
    case "catalog_drop": {
      if (!values.get("set")) throw new Error("usage: archiware catalog_drop --set NAME [--yes]");
      printResult("catalog_drop", await cat.catalogDrop(cfg, values.get("set")!, yes), json);
      break;
    }
    case "library_layout":
      printResult("library_layout", await lib.libraryLayout(cfg), json);
      break;
    case "library_arrange":
      printResult("library_arrange", await lib.libraryArrange(cfg, yes, flags.has("force")), json);
      break;
    case "tape_export": {
      if (!positional[1]) throw new Error("usage: archiware tape_export <barcode|label> [--yes]");
      printResult("tape_export", await lib.tapeExport(cfg, positional[1], yes, flags.has("force")), json);
      break;
    }
    case "tape_import":
      printResult("tape_import", await lib.tapeImport(cfg, positional[1] ? Number(positional[1]) : undefined, yes, flags.has("force")), json);
      break;
    case "restore_options": {
      if (!positional[1]) throw new Error("usage: archiware restore_options <path> [--since YYYY-MM-DD]");
      printResult("restore_options", await lib.restoreOptions(cfg, positional[1], { since: values.get("since"), client: values.get("client") }), json);
      break;
    }
    case "offsite_status": {
      const o = (await lib.offsiteStatus(cfg)) as Record<string, unknown>;
      if (values.has("path")) o.fetchList = (await lib.offsiteFetchList(cfg, values.get("path")!)).fetchList;
      printResult("offsite_status", o, json);
      break;
    }
    case "library_plan": {
      const kind = positional[1] as "arrange" | "export" | "import";
      if (!["arrange", "export", "import"].includes(kind)) throw new Error("usage: archiware library_plan arrange | export <tape> | import [mail slot] [--simulate]");
      const r = await lib.libraryPlan(cfg, kind, kind === "export" ? { ref: positional[2] } : { mailSlot: positional[2] ? Number(positional[2]) : undefined }, flags.has("simulate"));
      printResult("session" in r ? "library_session" : "library_plan", r, json);
      break;
    }
    case "library_step": {
      if (!positional[1]) throw new Error("usage: archiware library_step <session> [--yes]");
      printResult("library_session", await lib.libraryStep(cfg, positional[1], yes, flags.has("force")), json);
      break;
    }
    case "library_status":
      if (!positional[1]) throw new Error("usage: archiware library_status <session>");
      printResult("library_session", lib.libraryStatus(cfg, positional[1]), json);
      break;
    case "library_abort":
      if (!positional[1]) throw new Error("usage: archiware library_abort <session>");
      printResult("library_session", await lib.libraryAbort(cfg, positional[1]), json);
      break;
    case "library_reconcile":
      printResult("library_reconcile", await lib.reconcile(cfg, yes), json);
      break;
    case "add_plan_folder": {
      const [planId, path] = positional.slice(1);
      if (!planId || !path) throw new Error("usage: archiware add_plan_folder <plan> <path> --yes");
      printResult("add_plan_folder", await ops.addPlanFolder(cfg, planId, path, yes), json);
      break;
    }
    case "add_plan_folders": {
      const [planId, ...paths] = positional.slice(1);
      if (!planId || paths.length === 0) throw new Error("usage: archiware add_plan_folders <plan> <path...> [--filter <name>] --yes");
      printResult("add_plan_folders", await ops.addPlanFolders(cfg, planId, paths, values.get("filter"), yes), json);
      break;
    }
    case "create_plan": {
      const [name] = positional.slice(1);
      if (!name) throw new Error("usage: archiware create_plan <name> [--retention <days>] --yes");
      const r = values.get("retention");
      printResult("create_plan", await ops.createPlan(cfg, name, r === undefined ? undefined : Number(r), yes), json);
      break;
    }
    case "set_plan_retention": {
      const [planId, days] = positional.slice(1);
      if (!planId || days === undefined) throw new Error("usage: archiware set_plan_retention <plan> <days> --yes");
      printResult("set_plan_retention", await ops.setPlanRetention(cfg, planId, Number(days), yes), json);
      break;
    }
    case "delete_plan": {
      const [planId] = positional.slice(1);
      if (!planId) throw new Error("usage: archiware delete_plan <plan> --yes");
      printResult("delete_plan", await ops.deletePlan(cfg, planId, yes), json);
      break;
    }
    case "volume_enable": {
      const [vol, state] = positional.slice(1);
      if (!vol || (state !== "on" && state !== "off")) throw new Error("usage: archiware volume_enable <volume> on|off --yes");
      printResult("volume_enable", await ops.volumeEnable(cfg, vol, state === "on", yes), json);
      break;
    }
    case "plan_event": {
      const [planId, pool, level, ...rest] = positional.slice(1);
      const firstrun = rest.pop();
      if (!planId || !pool || level === undefined || rest.length === 0 || !firstrun) {
        throw new Error('usage: archiware plan_event <plan> <pool> <level> <frequency...> <firstrun YYYY-MM-DDTHH:MM> [--exception "<spec>"] --yes');
      }
      const exception = values.get("exception")?.split(/\s+/).filter(Boolean) ?? [];
      printResult("plan_event", await ops.planEvent(cfg, planId, pool, level, rest, firstrun, yes, exception), json);
      break;
    }
    case "set_cleaning": {
      const [device, value] = positional.slice(1);
      if (!device || !value) throw new Error("usage: archiware set_cleaning <device> <0|1> --yes");
      printResult("set_cleaning", await ops.setCleaning(cfg, device, value, yes), json);
      break;
    }
    case "inventory": {
      const jukebox = positional[1];
      if (!jukebox) throw new Error("usage: archiware inventory <jukebox> [--barcode] --yes");
      printResult("inventory", await ops.inventory(cfg, jukebox, flags.has("barcode"), yes), json);
      break;
    }
    case "job-history": {
      const lim = values.get("limit");
      printResult("job-history", await tops.jobHistory(cfg, { plan: values.get("plan"), status: values.get("status"), since: values.get("since"), limit: lim === undefined ? undefined : Number(lim) }), json);
      break;
    }
    case "find-tasks": {
      const sub = positional[1];
      if (!sub) throw new Error("usage: archiware find-tasks <substring>");
      printResult("find-tasks", await tops.findTasks(cfg, sub), json);
      break;
    }
    case "task": {
      const [sub, task, ...dirs] = positional.slice(1);
      if (sub === "enable" || sub === "disable") {
        if (!task) throw new Error(`usage: archiware task ${sub} <task> --yes`);
        printResult("task", await tops.taskSetEnabled(cfg, task, sub === "enable", yes), json);
      } else if (sub === "set-dirs") {
        if (!task || dirs.length === 0) throw new Error("usage: archiware task set-dirs <task> <dir...> --yes");
        printResult("task", await tops.taskSetDirectories(cfg, task, dirs, yes), json);
      } else throw new Error("usage: archiware task enable|disable|set-dirs <task> [dirs...] --yes");
      break;
    }
    case "run-once": {
      const [planId, ...tasks] = positional.slice(1);
      const level = values.get("level") ?? "full";
      if (!planId || tasks.length === 0) throw new Error("usage: archiware run-once <plan> <task...> [--pool P] [--level full|incr] --yes");
      if (level !== "full" && level !== "incr") throw new Error("--level must be full or incr");
      printResult("run-once", await tops.runTasksOnce(cfg, planId, tasks, values.get("pool"), level, yes), json);
      break;
    }
    case "run-once-cleanup": {
      const planId = positional[1];
      if (!planId) throw new Error("usage: archiware run-once-cleanup <temp plan> --yes");
      printResult("run-once-cleanup", await tops.runTasksOnceCleanup(cfg, planId, yes), json);
      break;
    }
    case "job_cancel": {
      const id = positional[1];
      if (!id) throw new Error("usage: archiware job_cancel <id> --yes");
      printResult("job_cancel", await rops.jobCancel(cfg, id, yes), json);
      break;
    }
    case "health": {
      const h = await rops.health(cfg);
      printResult("health", h, json);
      process.exitCode = rops.healthExitCode(h.checks);
      break;
    }
    case "rest_resources":
      printJson(await restResources(cfg));
      break;
    case "rest": {
      const path = positional[1];
      if (!path) throw new Error("usage: archiware rest <path> [--method GET|POST|PUT|DELETE] [--body <json>] [--yes]");
      const method = (values.get("method") ?? "GET").toUpperCase() as RestMethod;
      if (!["GET", "POST", "PUT", "DELETE"].includes(method)) throw new Error(`unsupported method ${method}`);
      const raw = values.get("body");
      printResult("rest", await restRequest(cfg, method, path, raw === undefined ? undefined : JSON.parse(raw), yes), json);
      break;
    }
    case "container_status":
      printResult("container_status", await cops.containerStatus(cfg), json);
      break;
    case "container_backup":
      printResult("container_backup", await cops.containerBackup(cfg, yes, { force: flags.has("force"), restart: flags.has("restart") }, cliProgress), json);
      break;
    case "container_stop":
      printResult("container_stop", await cops.containerStop(cfg, yes, flags.has("force"), cliProgress), json);
      break;
    case "container_start":
      printResult("container_start", await cops.containerStart(cfg, yes, cliProgress), json);
      break;
    case "container_update": {
      const deb = positional[1];
      if (!deb) throw new Error("usage: archiware container_update <file.deb> [--skip-backup-check] --yes");
      printResult("container_update", await cops.containerUpdate(cfg, deb, yes, { skipBackupCheck: flags.has("skip-backup-check"), force: flags.has("force") }, cliProgress), json);
      break;
    }
    case "nsdchat": {
      const args = positional.slice(1);
      if (args.length === 0) throw new Error("usage: archiware nsdchat <args...>");
      printResult("nsdchat", await ops.nsdchatRaw(cfg, args, yes), json);
      break;
    }
    case "tape_load": {
      const slot = Number(positional[1]);
      if (!Number.isInteger(slot)) throw new Error("usage: archiware tape_load <slot> --yes");
      printResult("tape_load", await tape.tapeLoad(cfg, slot, yes, flags.has("force")), json);
      break;
    }
    case "tape_unload": {
      const slot = Number(positional[1]);
      if (!Number.isInteger(slot)) throw new Error("usage: archiware tape_unload <slot> --yes");
      printResult("tape_unload", await tape.tapeUnload(cfg, slot, yes, flags.has("force")), json);
      break;
    }
    case "tape_read_header": {
      const slot = Number(positional[1]);
      if (!Number.isInteger(slot)) throw new Error("usage: archiware tape_read_header <slot>");
      printResult("tape_read_header", await tape.tapeReadHeader(cfg, slot, flags.has("force")), json);
      break;
    }
    case "tape_erase": {
      const slots = positional.slice(1).map(Number);
      if (slots.length === 0 || slots.some((s) => !Number.isInteger(s))) throw new Error("usage: archiware tape_erase <slot...> [--erase-known] --yes");
      printResult("tape_erase", await tape.tapeErase(cfg, slots, yes, flags.has("force"), flags.has("erase-known")), json);
      break;
    }
    case "clean_drive": {
      const drive = positional[1];
      if (!drive) throw new Error("usage: archiware clean_drive <p5 device|gen> --yes");
      printResult("clean_drive", await tape.cleanDrive(cfg, drive, yes, flags.has("force")), json);
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
      process.exit(2);
  }
}

main().catch((e) => {
  const detail = e instanceof P5Error && e.stderr ? `\n${e.stderr}` : "";
  console.error(`Error: ${e instanceof Error ? e.message : String(e)}${detail}`);
  if (e instanceof Error && !(e instanceof P5Error)) console.error(e.stack);
  process.exit(1);
});
