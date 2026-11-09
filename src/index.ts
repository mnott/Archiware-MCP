#!/usr/bin/env node
/**
 * archiware-mcp — MCP server for Archiware P5 backup servers.
 *
 * Talks to P5's nsdchat CLI: `ssh <host> docker exec <container>` (docker mode), `ssh <host>` (ssh mode) or locally (local mode).
 * stdout is the JSON-RPC transport — all debug output goes to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, missingKeys } from "./config.js";
import { VERSION } from "./version.js";
import * as ops from "./operations.js";
import * as tape from "./tapeops.js";
import * as lib from "./libops.js";
import * as gov from "./govops.js";
import * as rops from "./restops.js";
import * as cops from "./containerops.js";
import { p5ConfigBackup } from "./configbackup.js";
import { p5DrKit } from "./drkit.js";
import * as tops from "./taskops.js";
import * as cat from "./catalog.js";
import * as idx from "./indexsync.js";
import * as ff from "./findfile.js";
import * as viewer from "./viewer.js";
import { normalizeRestPath, restRequest, restResources } from "./rest.js";

const cfg = loadConfig();
const onConflictArg = z.enum(["refuse", "rename", "overwrite"]).optional().describe("What to do when a destination file exists: refuse (default), rename (<name>.restored-YYYYMMDD; not for P5 volume restores) or overwrite");
const forceSyncArg = z.boolean().optional().describe("Allow to:'original' inside a configured syncRoot");
const planIdArg = z.string().optional().describe("planId printed by the preview; required with confirm:true. A changed destination or new conflicts make the call refuse and show the new plan");
if (missingKeys(cfg).length) console.error(`archiware-mcp: not configured (missing ${missingKeys(cfg).join(", ")}); run \`archiware setup\``);

function text(data: unknown) {
  const t = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text: t }] };
}
function err(e: unknown) {
  const stderr = (e as { stderr?: string } | null)?.stderr;
  const msg = e instanceof Error ? `${e.message}${stderr ? `\n${stderr}` : ""}` : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

const server = new McpServer(
  { name: "archiware", version: VERSION },
  {
    instructions: [
      "Archiware P5 backup server via the REST API (preferred) and nsdchat over SSH.",
      "P5 concepts: a pool is a named collection of labeled media; a volume is one piece of media (tape or disk container) labeled for a pool;",
      "a plan is a backup configuration grouping tasks (what to back up) and events (when and into which pool);",
      "an event is one schedule entry of a plan (frequency + pool + backup level); a job is one execution, tracked by id with a report.",
      "container_* tools only apply when P5 runs in a docker container (mode docker); otherwise they report notApplicable.",
      "Mutating tools require confirm:true; without it they only report the command that WOULD run.",
    ].join(" "),
  },
);

server.registerTool(
  "status",
  {
    description:
      "Overall P5 status: tape devices, jukeboxes, pools with usage percentages, and running/scheduled jobs. A pool is a named collection of labeled media that backup jobs write into.",
    inputSchema: {},
  },
  async () => {
    try {
      return text(await rops.status(cfg));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "slots",
  {
    description:
      "Per-slot view of the tape library: slot number, barcode (from mtx), and P5 volume id/label/pool/mode/state if known, with an unknownToP5 flag; drive loaded state from mtx. A volume is one piece of media P5 identifies by a label written at its beginning.",
    inputSchema: {},
  },
  async () => {
    try {
      return text(await ops.slots(cfg));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "volumes",
  {
    description:
      "All P5 volumes with label, barcode, mediatype, location, mode, state, pool, used/total size (converted from KB to human units) and expiry date. A volume is one labeled piece of media (tape or disk container).",
    inputSchema: {},
  },
  async () => {
    try {
      return text(await ops.volumes(cfg));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "pools",
  {
    description:
      "All media pools with mediatype, usage (Backup/Archive), used/total size and their volume ids. A pool is a named collection of labeled media that jobs write into.",
    inputSchema: {},
  },
  async () => {
    try {
      return text(await ops.pools(cfg));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "plans",
  {
    description:
      "All backup plans (and archive plans if any) with description, enabled flag, event and task names. A plan is a backup configuration grouping tasks (what to back up) and events (when, into which pool).",
    inputSchema: {},
  },
  async () => {
    try {
      return text(await ops.plans(cfg));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "plan",
  {
    description:
      "Everything readable about one backup plan: settings, each event (pool, level, frequency, firstrun) and each task (client, directories). An event is one schedule entry of a plan; a task defines the client and directories to back up.",
    inputSchema: { id: z.string().describe("Plan id, e.g. 10004") },
  },
  async ({ id }) => {
    try {
      return text(await ops.plan(cfg, id));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "jobs",
  {
    description:
      "Jobs with label and status plus the last report lines; all=true also includes jobs completed in the last 7 days. A job is one execution of a plan/task, tracked by an id.",
    inputSchema: { all: z.boolean().optional().describe("Include completed jobs of the last 7 days") },
  },
  async ({ all }) => {
    try {
      return text(await rops.jobs(cfg, Boolean(all)));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "job",
  {
    description:
      "One job in detail: status, label, completion, full report and protocol log. A job is one execution of a plan/task, tracked by an id.",
    inputSchema: { id: z.string().describe("Job id, e.g. 12482") },
  },
  async ({ id }) => {
    try {
      return text(await rops.job(cfg, id));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "dryrun_plan",
  {
    description:
      "Starts a dry-run job for a backup plan (safe: scans and reports, writes nothing). No confirm needed.",
    inputSchema: { id: z.string().describe("Plan id") },
  },
  async ({ id }) => {
    try {
      return text(await ops.dryrunPlan(cfg, id));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "start_plan",
  {
    description:
      "Starts a real backup job for a plan now. Requires confirm:true; without it only the command that WOULD run is returned.",
    inputSchema: {
      id: z.string().describe("Plan id"),
      confirm: z.boolean().optional().describe("Must be true to actually run"),
    },
  },
  async ({ id, confirm }) => {
    try {
      return text(await ops.startPlan(cfg, id, Boolean(confirm)));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "enable_plan",
  {
    description:
      "Enables a backup plan so its events run on schedule. Requires confirm:true; without it only the command that WOULD run is returned.",
    inputSchema: {
      id: z.string().describe("Plan id"),
      confirm: z.boolean().optional().describe("Must be true to actually run"),
    },
  },
  async ({ id, confirm }) => {
    try {
      return text(await ops.enablePlan(cfg, id, Boolean(confirm)));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "disable_plan",
  {
    description:
      "Disables a backup plan so its events no longer run. Requires confirm:true; without it only the command that WOULD run is returned.",
    inputSchema: {
      id: z.string().describe("Plan id"),
      confirm: z.boolean().optional().describe("Must be true to actually run"),
    },
  },
  async ({ id, confirm }) => {
    try {
      return text(await ops.disablePlan(cfg, id, Boolean(confirm)));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "stop_job",
  {
    description:
      "Stops a scheduled job (only jobs with status 'scheduled'; running jobs must be canceled via nsdchat passthrough). Requires confirm:true.",
    inputSchema: {
      id: z.string().describe("Job id"),
      confirm: z.boolean().optional().describe("Must be true to actually run"),
    },
  },
  async ({ id, confirm }) => {
    try {
      return text(await ops.stopJob(cfg, id, Boolean(confirm)));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "label_tapes",
  {
    description:
      "DESTRUCTIVE: labels media in a jukebox's slots for a pool — this OVERWRITES the tapes in the given slots, destroying any data on them. Only new/empty volumes can be labeled. Requires confirm:true.",
    inputSchema: {
      jukebox: z.string().describe("Jukebox name, e.g. from status"),
      pool: z.string().describe("Pool name to label for"),
      slotIds: z.array(z.string()).describe("Slot numbers to label, e.g. [\"1\",\"5\"]"),
      drive: z.string().optional().describe("Force this drive device (e.g. sg6): other drives get cleaning=1 during the job, restored afterwards"),
      confirm: z.boolean().optional().describe("Must be true to actually run"),
    },
  },
  async ({ jukebox, pool, slotIds, drive, confirm }) => {
    try {
      return text(await ops.labelTapes(cfg, jukebox, pool, slotIds, Boolean(confirm), drive));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "restore_lookup",
  {
    description:
      "Read-only. Lists the entries (path, size, volumes) held by a BACKUP volume, or by the volumes of a backup job, via Volume/Job inventory. Use it to find the volume id for `restore`.",
    inputSchema: {
      volume: z.string().optional().describe("Volume id (numeric)"),
      job: z.string().optional().describe("Backup job id (numeric); alternative to volume"),
    },
  },
  async ({ volume, job }) => {
    try {
      return text(await ops.restoreLookup(cfg, { volume, job }));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "restore",
  {
    description:
      "Restore plan for ONE path at a chosen BACKUP version (`at` = a version `start` from restore_options). P5's CLI and REST cannot select a single path of a backup version (RestoreSelection addentry takes only archive handles; addfromvolume restores a whole volume), so this tool never starts a P5 job: it returns the full preview (source version, volume(s) with barcode and location, destination, bytes, free space, bounded tree, existing destination files, conflict policy, planId) and the exact P5 GUI steps (Restore > Backup > client > path > backup date > restore to the destination folder). confirm:true with the planId only creates the destination folder. Data comes from the catalogue copy of the backup index when the client is indexed, else P5's SQLite index. For archive entries use restore_archive; a whole volume is restore_volume.",
    inputSchema: {
      at: z.string().describe("Version chosen from restore_options (its `start`, YYYY-MM-DD HH:MM)"),
      path: z.string().describe("Original absolute path (file or folder) as backed up"),
      client: z.string().optional().describe("P5 client (default localhost)"),
      to: z.string().optional().describe("Absolute directory in the P5 container; the original path is placed below it. Default: <restoreRoot>/<YYYYMMDD-HHMMSS>"),
      onConflict: onConflictArg,
      forceSync: forceSyncArg,
      planId: planIdArg,
      confirm: z.boolean().optional().describe("With planId: prepare the destination folder"),
    },
  },
  async ({ at, path, client, to, onConflict, forceSync, planId, confirm }) => {
    try {
      return text(await lib.restoreVersion(cfg, at, path, { to, onConflict, forceSync, plan: planId, confirm: Boolean(confirm) }, client));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "restore_archive",
  {
    description:
      "Restores ONE entry (file, or folder with everything below) of a P5 ARCHIVE index to an alternate directory: RestoreSelection create <client> <dir>, addentry <archive handle>, submit; returns the job id. Without confirm only the preview (read-back of the selection: entries and bytes from P5, free space, conflicts, policy, planId; the probe selection is destroyed, nothing submitted). confirm:true must pass that planId.",
    inputSchema: {
      path: z.string().describe("Absolute path of the entry as archived"),
      index: z.string().optional().describe("Archive index (default Default-Archive)"),
      to: z.string().optional().describe("Absolute directory in the P5 container; the original path is placed below it"),
      onConflict: onConflictArg,
      forceSync: forceSyncArg,
      planId: planIdArg,
      confirm: z.boolean().optional().describe("Must be true to actually run (with planId)"),
    },
  },
  async ({ path, index, to, onConflict, forceSync, planId, confirm }) => {
    try {
      return text(await ops.restoreArchiveEntry(cfg, path, { to, onConflict, forceSync, plan: planId, confirm: Boolean(confirm) }, index));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "restore_volume",
  {
    description:
      "EXPLICIT whole-volume restore: EVERYTHING on a P5 backup volume (all clients, all paths) goes to an alternate directory (RestoreSelection addfromvolume). Not for single files (use restore). Preview shows the volume, its used size, free space and a planId; confirm:true must pass that planId. Returns the job id.",
    inputSchema: {
      volume: z.string().describe("Backup volume id (see volumes / restore_lookup)"),
      to: z.string().optional().describe("Absolute directory in the P5 container; default <restoreRoot>/<stamp>"),
      onConflict: onConflictArg,
      forceSync: forceSyncArg,
      planId: planIdArg,
      confirm: z.boolean().optional().describe("Must be true to actually run (with planId)"),
    },
  },
  async ({ volume, to, onConflict, forceSync, planId, confirm }) => {
    try {
      return text(await ops.restoreVolume(cfg, volume, { to, onConflict, forceSync, plan: planId, confirm: Boolean(confirm) }));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "add_plan_folder",
  {
    description:
      "Adds one folder to a backup plan as a new task (addtask, client localhost, dirlist <single path>, enable - verified); a task defines what to back up. Requires confirm:true; without it only the calls that WOULD run are returned.",
    inputSchema: {
      plan: z.string().describe("Plan id"),
      path: z.string().describe("Single absolute folder path as seen by the P5 container"),
      confirm: z.boolean().optional().describe("Must be true to actually run"),
    },
  },
  async ({ plan, path, confirm }) => {
    try {
      return text(await ops.addPlanFolder(cfg, plan, path, Boolean(confirm)));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "add_plan_folders",
  {
    description:
      "Adds several folders to a backup plan, one enabled task each (path checked with test -d in the container; optional task filter). Returns per-path task id or error. Requires confirm:true.",
    inputSchema: {
      plan: z.string().describe("Plan id"),
      paths: z.array(z.string()).min(1).describe("Absolute folder paths as seen by the P5 container"),
      filter: z.string().optional().describe("Optional filter name applied to each task"),
      confirm: z.boolean().optional().describe("Must be true to actually run"),
    },
  },
  async ({ plan, paths, filter, confirm }) => {
    try {
      return text(await ops.addPlanFolders(cfg, plan, paths, filter, Boolean(confirm)));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "create_plan",
  {
    description: "Creates a backup plan (returns its id); optional retention in days. Requires confirm:true.",
    inputSchema: {
      name: z.string(),
      retention_days: z.number().int().min(0).optional(),
      confirm: z.boolean().optional().describe("Must be true to actually run"),
    },
  },
  async ({ name, retention_days, confirm }) => {
    try {
      return text(await ops.createPlan(cfg, name, retention_days, Boolean(confirm)));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "set_plan_retention",
  {
    description: "Sets the retention (days) of a backup plan. Requires confirm:true.",
    inputSchema: {
      plan: z.string().describe("Plan id"),
      days: z.number().int().min(0),
      confirm: z.boolean().optional().describe("Must be true to actually run"),
    },
  },
  async ({ plan, days, confirm }) => {
    try {
      return text(await ops.setPlanRetention(cfg, plan, days, Boolean(confirm)));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "delete_plan",
  {
    description: "Deletes a backup plan. Requires confirm:true.",
    inputSchema: {
      plan: z.string().describe("Plan id"),
      confirm: z.boolean().optional().describe("Must be true to actually run"),
    },
  },
  async ({ plan, confirm }) => {
    try {
      return text(await ops.deletePlan(cfg, plan, Boolean(confirm)));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "volume_enable",
  {
    description: "Enables or disables a volume. Requires confirm:true.",
    inputSchema: {
      volume: z.string().describe("Volume id"),
      enabled: z.boolean(),
      confirm: z.boolean().optional().describe("Must be true to actually run"),
    },
  },
  async ({ volume, enabled, confirm }) => {
    try {
      return text(await ops.volumeEnable(cfg, volume, enabled, Boolean(confirm)));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "plan_event",
  {
    description:
      "Adds an event (schedule entry: pool + level + frequency + first run) to a backup plan. Level 1 full, 0 incremental, -1 synthetic. Frequency tokens: \"D n\" | \"W n days...\" | \"M n week day\". firstrun is ISO local time the local time zone, e.g. 2026-11-07T02:00. Requires confirm:true.",
    inputSchema: {
      plan: z.string().describe("Plan id"),
      pool: z.string().describe("Pool name the event writes into"),
      level: z.string().describe("1 full, 0 incremental, -1 synthetic"),
      frequency: z.array(z.string()).describe("Tokens, e.g. [\"M\",\"1\",\"1\",\"6\"]"),
      firstrun: z.string().describe("ISO local time, e.g. 2026-11-07T02:00"),
      exception: z.array(z.string()).optional().describe("Optional exception tokens, same format as frequency"),
      confirm: z.boolean().optional().describe("Must be true to actually run"),
    },
  },
  async ({ plan, pool, level, frequency, firstrun, exception, confirm }) => {
    try {
      return text(await ops.planEvent(cfg, plan, pool, level, frequency, firstrun, Boolean(confirm), exception ?? []));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "set_cleaning",
  {
    description:
      "Sets a drive's cleaning flag (0 or 1). P5 avoids drives flagged 1 when choosing where to write. Requires confirm:true.",
    inputSchema: {
      device: z.string().describe("Device name, e.g. sg6"),
      value: z.enum(["0", "1"]).describe("0 off, 1 on"),
      confirm: z.boolean().optional().describe("Must be true to actually run"),
    },
  },
  async ({ device, value, confirm }) => {
    try {
      return text(await ops.setCleaning(cfg, device, value, Boolean(confirm)));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "inventory",
  {
    description:
      "Schedules a jukebox inventory job updating P5's volume database; barcode=true requests a barcode scan. Requires confirm:true.",
    inputSchema: {
      jukebox: z.string().describe("Jukebox name"),
      barcode: z.boolean().optional().describe("Request barcode inventory instead of mount inventory"),
      confirm: z.boolean().optional().describe("Must be true to actually run"),
    },
  },
  async ({ jukebox, barcode, confirm }) => {
    try {
      return text(await ops.inventory(cfg, jukebox, Boolean(barcode), Boolean(confirm)));
    } catch (e) {
      return err(e);
    }
  },
);

const tool = (name: string, description: string, inputSchema: Record<string, z.ZodTypeAny>, fn: (a: any) => Promise<unknown> | unknown) =>
  server.registerTool(name, { description, inputSchema }, async (a: any) => {
    try {
      return text(await fn(a));
    } catch (e) {
      return err(e);
    }
  });
const confirmArg = z.boolean().optional().describe("Must be true to actually run; without it only the plan/commands are returned");
const forceArg = z.boolean().optional().describe("Override the busy-library check");

tool("governance_report", "Read-only. P5 explained in plain words, per backup plan: enabled, events (pool, level, frequency in words, next run), tasks and folders, last run per task with result, retention; flags with a one-line reason and a recommendation (keep / merge / disable / delete): never ran or only failed, disabled for long, folders in several plans, tasks on folders that do not exist, pools without (appendable) volumes, events whose pool has no tape in the library; plus server-wide settings (maintenance restart window and what it waits for, plan stop/cancel times, mail). Each deletable/disable-able flag carries an `apply` item for governance_apply.", {}, () => gov.governanceReport(cfg));
tool("governance_apply", "Applies ONE recommendation from governance_report: item is disable-plan:<id>, delete-plan:<id> or disable-task:<id>. Refuses a plan with active jobs. Reads the result back. Requires confirm:true; without it only what would run is returned.", { item: z.string(), confirm: confirmArg }, (a) => gov.governanceApply(cfg, a.item, Boolean(a.confirm)));
tool("schedule_check", "Read-only forecast of all enabled events for the next N days (default 7): start, expected duration (median of past runs), pool, drive generation needed. Warns about overlaps per drive generation and per pool, runs reaching into P5's maintenance restart window, and runs whose pool has no appendable tape in the library.", { days: z.number().optional() }, (a) => gov.scheduleCheck(cfg, { days: a.days }));
tool("ensure_done", "Checks that every scheduled run since `since` (YYYY-MM-DD or YYYY-MM-DDTHH:MM, default 24 h) produced a successful job for every enabled task of its plan; lists failed, stopped, missing and still-waiting tasks. rerun:true with confirm:true re-runs exactly the failed/stopped/missing tasks once (run_tasks_once, same pool); never cancels anything. mail:true sends the report to operatorMail through the host MTA (independent of P5's own mail). Call it after the nightly window.", { since: z.string().optional(), rerun: z.boolean().optional(), mail: z.boolean().optional(), confirm: confirmArg }, (a) => gov.ensureDone(cfg, { since: a.since, rerun: a.rerun, confirm: Boolean(a.confirm), mail: a.mail }));
tool("notify_status", "Read-only. P5's mail setup in plain words (SMTP server, port, TLS, sender, login yes/no, recipients) plus what P5's log says (last mail sent, recent failures) and a one-line problem when mail is broken or silent.", {}, () => gov.notifyStatus(cfg));
tool("notify_set", "P5 offers no API for its mail settings: returns the current settings, why nothing was changed and the GUI steps. Never takes a password as an argument (only a password file path).", { server: z.string().optional(), port: z.number().optional(), tls: z.string().optional(), sender: z.string().optional(), user: z.string().optional(), passwordFile: z.string().optional(), recipients: z.array(z.string()).optional(), confirm: confirmArg }, (a) => gov.notifySet(cfg, a, Boolean(a.confirm)));
tool("notify_test", "P5 has no test-mail command. Checks that P5's SMTP server accepts connections from the P5 side and shows the log evidence; with confirm:true also sends one test mail via the host MTA to operatorMail (config only), which proves the host path, not P5's.", { confirm: confirmArg }, (a) => gov.notifyTest(cfg, Boolean(a.confirm)));
tool("library_layout", "Read-only. Per slot: barcode, P5 volume label/pool, target pool from the config slotLayout, status ok/misplaced/foreign/empty; drives and mail slots too.", {}, () => lib.libraryLayout(cfg));
tool("library_arrange", "Computes the minimal list of mtx transfer moves (via free slots when needed) to reach slotLayout. Refuses while a drive is loaded or a P5 job runs. confirm:true runs the plan and then a P5 jukebox inventory + reconcile; without it only the plan is returned. For a dialog use library_plan/library_step instead.", { confirm: confirmArg, force: forceArg }, (a) => lib.libraryArrange(cfg, Boolean(a.confirm), Boolean(a.force)));
tool("tape_export", "Moves a tape (barcode or volume label) from its slot to the first free mail slot, then a P5 inventory. Same busy refusals as other tape tools. Dry plan without confirm.", { tape: z.string().describe("Barcode or P5 volume label"), confirm: confirmArg, force: forceArg }, (a) => lib.tapeExport(cfg, a.tape, Boolean(a.confirm), Boolean(a.force)));
tool("tape_import", "Moves the tape in a mail slot to the target slot of its pool per slotLayout (else the first free slot), then a P5 inventory. Dry plan without confirm.", { mailSlot: z.number().optional(), confirm: confirmArg, force: forceArg }, (a) => lib.tapeImport(cfg, a.mailSlot, Boolean(a.confirm), Boolean(a.force)));
tool("restore_options", "Read-only. Every backed-up version of a file or folder, newest first, from P5's per-client backup index: backup time, file modification time, size, plan, level, and every volume holding a copy (label, pool, barcode, current location: drive / library slot / mail slot / not in the library), plus a fetch list of tapes to bring back when no copy is in the library. Feed a version's `start` to `restore` as `at`.", { path: z.string().describe("Absolute path as P5 sees it"), since: z.string().optional().describe("YYYY-MM-DD"), client: z.string().optional().describe("P5 client (default localhost)") }, (a) => lib.restoreOptions(cfg, a.path, { since: a.since, client: a.client }));
tool("offsite_status", "Read-only. Per tape pool: volumes in the library, in the mail slot or out; warns about pools with no volume out of the house. With path, also the fetch list for that restore_options result.", { path: z.string().optional() }, async (a) => {
  const o = (await lib.offsiteStatus(cfg)) as Record<string, unknown>;
  if (a.path) o.fetchList = (await lib.offsiteFetchList(cfg, a.path)).fetchList;
  return o;
});
tool("catalog_init", "Creates the file catalogue schema (MySQL database archive_catalog: sets, tars, entries) idempotently and shows the tables.", {}, () => cat.catalogInit(cfg));
tool("pack", "Packs a source directory on the P5 host into tar files (D2D2T) and records every file in the catalogue. Without confirm: only the plan (walks the source once at low I/O priority; tar names, sizes, file counts, time estimate). With confirm:true: writes the tars (tar --sort=inode, resumable per tar via .done markers, sha256 per tar, plain-text listing next to each tar) and the rows in one transaction per tar. Long-running (hours for TB-sized sets); does not hold the nsdchat lock.", { source: z.string().describe("Absolute source directory on the P5 host"), set: z.string().describe("Set name (letters, digits, . _ -)"), max: z.string().optional().describe("Max tar size, e.g. 50G (default 50G)"), into: z.string().optional().describe("Pack root (default config packRoot); tars go to <root>/<set>/"), replan: z.boolean().optional().describe("Ignore a stored plan of an interrupted run"), detach: z.boolean().optional().describe("Run the whole plan as one self-contained runner on the P5 host (setsid nohup, resumable per tar, log in the tar dir); returns at once, the client may disconnect; follow with pack_status"), confirm: confirmArg }, (a) => cat.pack(cfg, a.source, { set: a.set, max: a.max, into: a.into, confirm: Boolean(a.confirm), replan: a.replan, detach: a.detach }));
tool("pack_status", "Read-only. Progress of a detached pack: running or not, tars done/total, bytes, current tar, rate, ETA, last log lines.", { set: z.string() }, (a) => cat.packStatus(cfg, a.set));
tool("pack_stop", "Stops a detached pack after the current tar (stop marker; finished tars stay, rerunning pack --detach resumes). Requires confirm:true.", { set: z.string(), confirm: confirmArg }, (a) => cat.packStop(cfg, a.set, Boolean(a.confirm)));
tool("catalog_sets", "Read-only. Catalogue sets with tar count, file count, bytes and status.", {}, () => cat.catalogSets(cfg));
tool("index_sync", "Copies P5's per-client backup index (read-only, immutable sqlite on the P5 host, P5 is not disturbed) into the catalogue database (tables names, dirs, p5_dirs, p5_files, index_state) so find_file can search names in seconds instead of the ~5 minute scan of P5's own 9.5 GB files.db. Paths are rebuilt set-based (one recursive query), rows stream in batches of 200000. Incremental by default: only new element ids plus versions that ended since the last run; a killed run resumes. full:true rescans everything. detach:true runs it on the host (use for the first, ~84 million row sync); index_status shows progress and rows/s. Writes only to the catalogue database.", { client: z.string().optional().describe("P5 client (default: every client with a backup index)"), full: z.boolean().optional(), detach: z.boolean().optional(), noDtime: z.boolean().optional().describe("skip re-reading rows for versions that ended since the last run (faster, deleted-file status lags until the next full pass)") }, (a) => idx.indexSync(cfg, { client: a.client, full: a.full, detach: a.detach, noDtime: a.noDtime }));
tool("index_status", "Read-only. index_sync state per client (last element id and backup time read, rows), approximate table sizes, and detached runs (running/finished/failed, rows, rows/s, log tail).", {}, () => idx.indexStatus(cfg));
tool("find_file", "Read-only. Searches file NAMES (substring, or glob with * ?; a pattern with / also matches the directory) across all backups: the P5 backup index copy (needs index_sync) and the tar catalogue. Returns every matching file (full path) with every version (distinct mtime+size, newest first); each version lists all places it can be fetched from, cheapest first: 1 disk-tar (inside a tar still on disk, no tape needed), 2 tape-library (P5 volume in the library) or tar-on-tape in library, 3 tape-offline (only on tapes outside the library: shows the barcode to insert). Same path+mtime+size from several sources is one version with several locations. Each version has a key and each location an id for restore_version.", { pattern: z.string(), limit: z.number().optional().describe("max files, default 20, max 200"), client: z.string().optional().describe("only this P5 client"), since: z.string().optional().describe("only versions modified on/after YYYY-MM-DD"), under: z.string().optional().describe("only below this directory (path prefix)") }, (a) => ff.findFile(cfg, a.pattern, { limit: a.limit, client: a.client, since: a.since, under: a.under }));
tool("restore_version", "Restores ONE version found by find_file into a directory on the P5 host, from the cheapest place automatically (disk-tar: extracted from the tar; tape-library: P5 restore; tar on tape in library: tar restored to scratch then extracted) or from the location id given as 'from'. A version that is only on offline tapes is refused with 'insert <barcode>'. Without confirm only the PLAN: host, absolute destination, source location chosen (and alternatives), bytes, free space, tree preview and every destination file that already exists (size+mtime now vs restored), conflict policy and a planId. confirm:true must pass that planId; if the destination or conflicts changed it refuses and shows the new plan.", { path: z.string().describe("full path as find_file shows it"), version: z.string().describe("version key '<mtime>-<size>' from find_file"), to: z.string().optional().describe("Default: restore folder <restoreRoot>/<YYYYMMDD-HHMMSS>/<original path>. 'original' = original location (explicit choice; refused inside a syncRoot without forceSync). Any other absolute directory gets the original path placed below it"), onConflict: onConflictArg, forceSync: forceSyncArg, planId: planIdArg, from: z.string().optional().describe("location id from find_file instead of the cheapest"), client: z.string().optional(), confirm: confirmArg }, (a) => ff.restoreFileVersion(cfg, a.path, a.version, { to: a.to, onConflict: a.onConflict, forceSync: a.forceSync, plan: a.planId, from: a.from, client: a.client, confirm: Boolean(a.confirm) }));
tool("catalog_search", "Read-only. Finds files in the catalogue by glob (* ?) or substring on path/basename. Per hit: set, path, size, mtime, tar name, whether the tar is still on disk, and where the tar is on tape (versions from P5's backup index: date, plan, volume label, barcode, location: library slot / mail slot / out of the house).", { pattern: z.string(), set: z.string().optional(), limit: z.number().optional().describe("Default 20, max 500") }, (a) => cat.catalogSearch(cfg, a.pattern, { set: a.set, limit: a.limit }));
tool("catalog_restore", "Restores ONE file from a packed set into a directory on the P5 host: extracted from the tar when it is on disk; otherwise the tar is restored from tape (via restore, into a scratch dir under packRoot) and the member extracted, then the scratch tar is deleted. Refuses with a fetch list when the needed tape is not in the library. Without confirm only the plan (destination, source, bytes, free space, existing destination files with size+mtime, conflict policy, planId); confirm:true needs that planId.", { path: z.string().describe("File path inside the set (relative to the set's source root)"), set: z.string(), to: z.string().optional().describe("Default: restore folder <restoreRoot>/<YYYYMMDD-HHMMSS>/<original path>; 'original' = original location; else a directory below which the original path is placed"), onConflict: onConflictArg, forceSync: forceSyncArg, planId: planIdArg, confirm: confirmArg }, (a) => cat.catalogRestore(cfg, a.path, { set: a.set, to: a.to, onConflict: a.onConflict, forceSync: a.forceSync, plan: a.planId, confirm: Boolean(a.confirm) }));
tool("viewer_deploy", "Deploys the catalogue viewer on a docker host over ssh: a read-only web page, its own MariaDB (database archive_catalog, users catalog read/write for this MCP and catalog_ro SELECT-only for the page, data dir on the host) and a nightly dump service. Generates random passwords and the viewer login into <dir>/secrets (mode 600), copies web/, runs docker compose up -d --build, waits for health, runs catalog_init against the new database and points the MCP config (catalogMysqlContainer, catalogDbCnf) at it when the docker host is the P5 host. Without confirm: only the plan. With confirm:true the result contains the generated viewer password ONCE.", { host: z.string().optional().describe("Docker host (ssh target); default viewerHost or the P5 host"), dir: z.string().optional().describe("Install dir on the host (default /opt/catalog-viewer)"), dataDir: z.string().optional().describe("Database data dir on the host (default <dir>/data/db)"), network: z.string().describe("Existing external docker network name"), catalogIp: z.string().describe("Free IPv4 on that network for the web page"), dbIp: z.string().describe("Free IPv4 on that network for the database (port 3306)"), p5Index: z.string().optional().describe("P5 config/index/backup dir on the host (default derived from the config)"), packRoot: z.string().optional().describe("Pack root on the host (default config packRoot)"), subpath: z.string().optional().describe("Reverse-proxy sub-path, e.g. viewer (only adds an Apache example to the result)"), viewerUser: z.string().optional().describe("Viewer login name (default viewer)"), p5BaseUrl: z.string().optional().describe("Link target for 'P5 web UI' on the page"), tz: z.string().optional().describe("Time zone of the containers (default UTC)"), confirm: confirmArg }, (a) => viewer.viewerDeploy(cfg, { host: a.host, dir: a.dir, dataDir: a.dataDir, network: a.network, catalogIp: a.catalogIp, dbIp: a.dbIp, p5Index: a.p5Index, packRoot: a.packRoot, subpath: a.subpath, viewerUser: a.viewerUser, p5BaseUrl: a.p5BaseUrl, tz: a.tz, confirm: Boolean(a.confirm) }));
tool("viewer_status", "Read-only. Catalogue viewer: containers (catalog, catalog-db, catalog-dump) with state and health, database size and row counts, newest dump file, number of cache entries (p5_cache) and the cache TTL.", {}, () => viewer.viewerStatus(cfg));
tool("catalog_migrate", "Copies the catalogue database archive_catalog from an existing MySQL/MariaDB (host[:port], read-only on the source) into the viewer's catalog-db: mariadb-dump --single-transaction | mariadb inside the catalog-db container, then compares row counts of sets, tars, entries before/after. Refuses when the target already holds rows unless force:true. Without confirm: only the plan. The password file is read on the machine running the MCP.", { from: z.string().describe("Source host[:port]"), user: z.string(), passwordFile: z.string().describe("File with the source user's password (on this machine)"), force: z.boolean().optional(), sourceTls: z.enum(["verify", "skip-verify", "off"]).optional().describe("verify (default); skip-verify = encrypted but certificate not checked (MySQL 8 self-signed cert); off = no TLS"), confirm: confirmArg }, (a) => viewer.catalogMigrate(cfg, { from: a.from, user: a.user, passwordFile: a.passwordFile, force: a.force, sourceTls: a.sourceTls, confirm: Boolean(a.confirm) }));
tool("catalog_drop", "Deletes a set's rows from the catalogue (not its tar files): for test sets and re-packs. Requires confirm:true.", { set: z.string(), confirm: confirmArg }, (a) => cat.catalogDrop(cfg, a.set, Boolean(a.confirm)));
tool("library_plan", "Proposes the steps of a rearrangement (arrange), export or import and returns a persisted session id. Nothing moves until library_step. simulate:true walks the session on a virtual library without touching hardware.", { kind: z.enum(["arrange", "export", "import"]), tape: z.string().optional().describe("export: barcode or label"), mailSlot: z.number().optional(), simulate: z.boolean().optional() }, (a) => lib.libraryPlan(cfg, a.kind, { ref: a.tape, mailSlot: a.mailSlot }, Boolean(a.simulate)));
tool("library_step", "Executes exactly one next step of a session (confirm-gated) and returns what happened plus the next instruction, including human steps (put/take a tape at the mail slot; those are verified, not executed). Re-checks busy state and slot contents first and stops if reality differs from the plan. The last step runs the P5 inventory and reconcile.", { session: z.string(), confirm: confirmArg, force: forceArg }, (a) => lib.libraryStep(cfg, a.session, Boolean(a.confirm), Boolean(a.force)));
tool("library_status", "Read-only. Done / next / remaining steps of a session.", { session: z.string() }, (a) => lib.libraryStatus(cfg, a.session));
tool("library_abort", "Stops a session cleanly; verifies that no tape is left in a drive.", { session: z.string() }, (a) => lib.libraryAbort(cfg, a.session));
tool("library_reconcile", "After moves: compares every volume's P5 location with mtx, checks the cleaning slot (confirm:true updates cleaningSlot in the config if the CLN tape moved) and warns about enabled plan events whose pool has no appendable volume in the library, with the plan's next run time. Reports P5 slot settings that must be checked manually.", { confirm: confirmArg }, (a) => lib.reconcile(cfg, Boolean(a.confirm)));

server.registerTool(
  "tape_load",
  {
    description:
      "Loads the tape in a library slot into the drive matching its generation (barcode suffix L6/L9), waits until the drive is ready, and leaves it loaded. Host-side mtx/mt, bypasses P5. Refuses if P5 has a running job or a drive is loaded, unless force. Requires confirm:true.",
    inputSchema: {
      slot: z.number().describe("Slot number, e.g. 4"),
      confirm: z.boolean().optional().describe("Must be true to actually run"),
      force: z.boolean().optional().describe("Override the busy-library check"),
    },
  },
  async ({ slot, confirm, force }) => {
    try {
      return text(await tape.tapeLoad(cfg, slot, Boolean(confirm), Boolean(force)));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "tape_unload",
  {
    description:
      "Rewinds the tape currently loaded from a slot and unloads it back to that slot (host-side mtx/mt). Requires confirm:true.",
    inputSchema: {
      slot: z.number().describe("Slot number the tape was loaded from"),
      confirm: z.boolean().optional().describe("Must be true to actually run"),
      force: z.boolean().optional().describe("Override the busy-library check"),
    },
  },
  async ({ slot, confirm, force }) => {
    try {
      return text(await tape.tapeUnload(cfg, slot, Boolean(confirm), Boolean(force)));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "tape_read_header",
  {
    description:
      "Reads the first block of a tape (load, rewind, dd bs=256k then 1M count=1, report bytes + printable strings + mt file/block numbers, rewind, unload). Read-only in data terms; the tape is always unloaded afterwards. No confirm needed.",
    inputSchema: {
      slot: z.number().describe("Slot number"),
      force: z.boolean().optional().describe("Override the busy check for the required drive"),
    },
  },
  async ({ slot, force }) => {
    try {
      return text(await tape.tapeReadHeader(cfg, slot, Boolean(force)));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "tape_erase",
  {
    description:
      "DESTRUCTIVE: short-erases tapes in the given slots (rewind + mt erase 0) — this DESTROYS all contents on them. One tape at a time, reported per slot; a bad tape reports an I/O error and is still rewound+unloaded. Refuses tapes P5 still knows as a volume (or whose barcode is unknown) unless eraseKnown:true; the preview lists them under `refused`. Requires confirm:true.",
    inputSchema: {
      slots: z.array(z.number()).describe("Slot numbers to erase, e.g. [14]"),
      confirm: z.boolean().optional().describe("Must be true to actually run"),
      force: z.boolean().optional().describe("Override the busy-library check"),
      eraseKnown: z.boolean().optional().describe("Erase tapes P5 still knows as a volume (or with unknown barcode); default false = refuse"),
    },
  },
  async ({ slots, confirm, force, eraseKnown }) => {
    try {
      return text(await tape.tapeErase(cfg, slots, Boolean(confirm), Boolean(force), Boolean(eraseKnown)));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "clean_drive",
  {
    description:
      "Cleans a drive with the library's CLN* cleaning tape: load into the drive (by P5 device name or generation L6/L9), wait until the drive goes not ready -> ready (max 180 s), unload back to its slot, then set P5 Device <p5> cleaning 0. Requires confirm:true.",
    inputSchema: {
      drive: z.string().describe("P5 device name (e.g. sg7) or generation (L6/L9)"),
      confirm: z.boolean().optional().describe("Must be true to actually run"),
      force: z.boolean().optional().describe("Override the busy-library check"),
    },
  },
  async ({ drive, confirm, force }) => {
    try {
      return text(await tape.cleanDrive(cfg, drive, Boolean(confirm), Boolean(force)));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "nsdchat",
  {
    description:
      "Raw nsdchat passthrough, e.g. args=[\"Volume\",\"10140\",\"label\"]. Read-only methods (names, describe, status, label, report, usage, ...) run directly; anything else requires confirm:true.",
    inputSchema: {
      args: z.array(z.string()).describe("nsdchat -c arguments, e.g. [\"Device\",\"names\"]"),
      confirm: z.boolean().optional().describe("Must be true for non-read-only methods"),
    },
  },
  async ({ args, confirm }) => {
    try {
      return text(await ops.nsdchatRaw(cfg, args, Boolean(confirm)));
    } catch (e) {
      return err(e);
    }
  },
);

const confirmField = z.boolean().optional().describe("Must be true to actually run");
const progressLog = (m: string) => console.error(`[progress] ${m}`);

server.registerTool(
  "rest_resources",
  { description: "Lists the resources of the P5 REST API (GET /rest).", inputSchema: {} },
  async () => {
    try {
      return text(await restResources(cfg));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "rest",
  {
    description:
      "P5 REST API passthrough under /rest/v1 (e.g. path \"general/jobs\"). GET runs directly (read-only). POST/PUT/DELETE require confirm:true; without it only the request that WOULD be sent is returned. Paths outside /rest/v1 or containing .. are rejected.",
    inputSchema: {
      path: z.string().describe("Path below /rest/v1, e.g. general/jobs/12345"),
      method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional().describe("Default GET"),
      body: z.any().optional().describe("JSON body for POST/PUT"),
      confirm: confirmField,
    },
  },
  async ({ path, method, body, confirm }) => {
    try {
      normalizeRestPath(path);
      return text(await restRequest(cfg, method ?? "GET", path, body, Boolean(confirm)));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "job_history",
  {
    description:
      "Past jobs (P5's job listing only returns scheduled ones, so job ids are walked downward from the newest known id, in batches). Per job: id, plan (describe), task (resourcename), status, completion, start time (server-local, from the protocol), size, files, and the source line ('Full save of: ...'). Scheduled jobs are excluded unless status is 'scheduled'. Filters: plan (name or id), status (status or completion, e.g. completed, running, failure), since (YYYY-MM-DD), limit (default 50).",
    inputSchema: {
      plan: z.string().optional().describe("Plan name or id"),
      status: z.string().optional().describe("Job status or completion to match"),
      since: z.string().optional().describe("Only jobs started on/after this date, YYYY-MM-DD or YYYY-MM-DDTHH:MM"),
      limit: z.number().int().min(1).max(1000).optional().describe("Max rows, newest first (default 50)"),
    },
  },
  async ({ plan, status, since, limit }) => {
    try {
      return text(await tops.jobHistory(cfg, { plan, status, since, limit }));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "find_tasks",
  {
    description: "Every backup plan and task whose directories contain the substring (case-insensitive), with the plan's and the task's enabled flag. One batched pass over all plans.",
    inputSchema: { substring: z.string().min(1).describe("Part of a directory path") },
  },
  async ({ substring }) => {
    try {
      return text(await tops.findTasks(cfg, substring));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "task_enable",
  {
    description: "Enables a backup task and reads the flag back (reports before/after). Requires confirm:true; without it only the calls that WOULD run are returned.",
    inputSchema: { task: z.string().describe("Task id"), confirm: confirmField },
  },
  async ({ task, confirm }) => {
    try {
      return text(await tops.taskSetEnabled(cfg, task, true, Boolean(confirm)));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "task_disable",
  {
    description: "Disables a backup task and reads the flag back (reports before/after). Requires confirm:true; without it only the calls that WOULD run are returned.",
    inputSchema: { task: z.string().describe("Task id"), confirm: confirmField },
  },
  async ({ task, confirm }) => {
    try {
      return text(await tops.taskSetEnabled(cfg, task, false, Boolean(confirm)));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "task_set_directories",
  {
    description:
      "Replaces the directory list of a backup task, reads it back and reports before/after; if P5 did not store exactly the requested list the old value is restored and an error is returned. Requires confirm:true.",
    inputSchema: {
      task: z.string().describe("Task id"),
      directories: z.array(z.string()).min(1).describe("Absolute paths as seen by the P5 server"),
      confirm: confirmField,
    },
  },
  async ({ task, directories, confirm }) => {
    try {
      return text(await tops.taskSetDirectories(cfg, task, directories, Boolean(confirm)));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "run_tasks_once",
  {
    description:
      "Backs up chosen tasks of a plan once, without running the whole plan. P5 cannot submit a task subset, so a temporary plan 'mcp-once-<timestamp>' with copies of those tasks and one event into the pool is created and started; returns the temp plan id and job id. The temp plan is kept until run_tasks_once_cleanup is called after the job finished. Requires confirm:true.",
    inputSchema: {
      plan: z.string().describe("Source plan id"),
      tasks: z.array(z.string()).min(1).describe("Task ids of that plan"),
      pool: z.string().optional().describe("Pool (default: pool of the plan's first event)"),
      level: z.enum(["full", "incr"]).optional().describe("Backup level (default full)"),
      confirm: confirmField,
    },
  },
  async ({ plan, tasks, pool, level, confirm }) => {
    try {
      return text(await tops.runTasksOnce(cfg, plan, tasks, pool, level ?? "full", Boolean(confirm)));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "run_tasks_once_cleanup",
  {
    description: "Deletes a temporary plan created by run_tasks_once (only plans named mcp-once-*, refused while one of its jobs is running or pending). Requires confirm:true.",
    inputSchema: { plan: z.string().describe("Temporary plan id"), confirm: confirmField },
  },
  async ({ plan, confirm }) => {
    try {
      return text(await tops.runTasksOnceCleanup(cfg, plan, Boolean(confirm)));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "job_cancel",
  {
    description:
      "Cancels a running OR waiting job via the REST API (falls back to nsdchat if the job stays active) and reports the job state afterwards. Requires confirm:true; without it only the requests that WOULD be sent are returned.",
    inputSchema: { id: z.string().describe("Job id"), confirm: confirmField },
  },
  async ({ id, confirm }) => {
    try {
      return text(await rops.jobCancel(cfg, id, Boolean(confirm)));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "health",
  {
    description:
      "One-call read-only health check: container, P5 version/uptime, REST, nsdchat, running/waiting jobs, drives, cleaning flags, free space of healthPaths, Error lines in the log. Each check is ok/warn/fail with a reason.",
    inputSchema: {},
  },
  async () => {
    try {
      return text(await rops.health(cfg));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "container_status",
  { description: "State, image, start time and P5 version of the P5 docker container, plus the newest backup dir.", inputSchema: {} },
  async () => {
    try {
      return text(await cops.containerStatus(cfg));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "container_backup",
  {
    description:
      "Cold backup of the P5 container (docker inspect/diff, commit to <image>-pre-update, docker save, STOP the container, tar the compose dir, SHA256SUMS, verify). Leaves the container stopped unless restart:true. Refused while a job runs unless force. Requires confirm:true; without it the steps are listed.",
    inputSchema: { confirm: confirmField, force: z.boolean().optional(), restart: z.boolean().optional().describe("Start the container again afterwards") },
  },
  async ({ confirm, force, restart }) => {
    try {
      return text(await cops.containerBackup(cfg, Boolean(confirm), { force, restart }, progressLog));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "p5_dr_kit",
  {
    description:
      "Disaster-recovery kit for the P5 server itself (docker mode only): consistent copies of the small config databases (sqlite3 .backup, integrity_check) and key files, the compose project, the running image (docker save, only when its id changed) and the P5 program tree (only when the P5 version changed), plus kit-small.tar.gz (config-small + compose + manifest) for a password manager or private repo. Writes <backupDir>/p5-dr-kit/<stamp>/ (7 generations, SHA256SUMS, VERIFIED). status:true lists generations. Requires confirm:true; without it the plan with sizes is returned.",
    inputSchema: { confirm: confirmField, status: z.boolean().optional().describe("List existing generations instead") },
  },
  async ({ confirm, status }) => {
    try {
      return text(await p5DrKit(cfg, { confirm: Boolean(confirm), status }));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "p5_config_backup",
  {
    description:
      "Consistent copy of P5's configuration and SQLite index databases (online sqlite3 .backup, integrity_check on each copy, tar of the rest, SHA256SUMS, manifest) into <backupDir>/p5-config/<YYYYMMDD-HHMMSS>/, restorable without P5. P5 keeps running. Keeps the newest p5ConfigBackupKeep verified copies. status:true lists copies. Requires confirm:true; without it the plan (sources, destination, size, free space) is returned.",
    inputSchema: { confirm: confirmField, status: z.boolean().optional().describe("List existing copies instead") },
  },
  async ({ confirm, status }) => {
    try {
      return text(await p5ConfigBackup(cfg, { confirm: Boolean(confirm), status }));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "container_stop",
  {
    description: "docker stop -t 120 on the P5 container. Refused while a job runs unless force. Requires confirm:true.",
    inputSchema: { confirm: confirmField, force: z.boolean().optional() },
  },
  async ({ confirm, force }) => {
    try {
      return text(await cops.containerStop(cfg, Boolean(confirm), Boolean(force), progressLog));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "container_start",
  { description: "docker start on the P5 container, then waits until srvinfo answers. Requires confirm:true.", inputSchema: { confirm: confirmField } },
  async ({ confirm }) => {
    try {
      return text(await cops.containerStart(cfg, Boolean(confirm), progressLog));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "container_update",
  {
    description:
      "Installs a local .deb into the P5 container (copy, sha256 check, docker cp, dpkg-deb -I, dpkg -i), waits for srvinfo and reports the new version and log Error lines. Refused without a backup newer than 24 h unless skipBackupCheck. Requires confirm:true.",
    inputSchema: { deb: z.string().describe("Local path of the .deb"), confirm: confirmField, skipBackupCheck: z.boolean().optional(), force: z.boolean().optional() },
  },
  async ({ deb, confirm, skipBackupCheck, force }) => {
    try {
      return text(await cops.containerUpdate(cfg, deb, Boolean(confirm), { skipBackupCheck, force }, progressLog));
    } catch (e) {
      return err(e);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`archiware-mcp running over stdio (mode: ${cfg.mode}${cfg.mode === "local" ? "" : `, host: ${cfg.sshHost}`}${cfg.mode === "docker" ? `/${cfg.container}` : ""})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
