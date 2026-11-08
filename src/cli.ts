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
import { restRequest, restResources, type RestMethod } from "./rest.js";
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
  restore <volume> <path> <target-dir>              restore a backed-up folder to an ALTERNATE dir (needs --yes)
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

const VALUE_FLAGS = new Set(["drive", "exception", "filter", "retention", "method", "body", "config", ...Object.keys(SETUP_FLAGS)]);

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

function printResult(name: string, data: unknown, json: boolean) {
  if (json) {
    printJson(data);
    return;
  }
  const d = data as Record<string, unknown>;
  // Any mutation without --yes: print the exact commands that WOULD run.
  if (d.confirmationRequired === true) {
    console.log(d.note as string);
    console.log("Would run:");
    for (const cmd of d.wouldRun as string[]) console.log(`  ${cmd}`);
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
      const [volume, path, target] = positional.slice(1);
      if (!volume || !path || !target) throw new Error("usage: archiware restore <volume> <path> <target-dir> --yes");
      printResult("restore", await ops.restore(cfg, volume, path, target, yes), json);
      break;
    }
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
      if (slots.length === 0 || slots.some((s) => !Number.isInteger(s))) throw new Error("usage: archiware tape_erase <slot...> --yes");
      printResult("tape_erase", await tape.tapeErase(cfg, slots, yes, flags.has("force")), json);
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
