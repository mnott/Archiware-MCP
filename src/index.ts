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
import * as rops from "./restops.js";
import * as cops from "./containerops.js";
import { normalizeRestPath, restRequest, restResources } from "./rest.js";

const cfg = loadConfig();
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
      "Restores a folder from a P5 BACKUP volume to an ALTERNATE directory (never overwrites originals) and returns the restore job id. P5's CLI can only select a whole backup volume, so it refuses unless every entry on the volume is under `path`. May load a tape. Requires confirm:true; without it only the commands that WOULD run are returned.",
    inputSchema: {
      volume: z.string().describe("Backup volume id holding the data (see restore_lookup)"),
      path: z.string().describe("Original absolute folder path as backed up"),
      target: z.string().describe("Separate absolute directory in the P5 container to restore into (created if missing)"),
      confirm: z.boolean().optional().describe("Must be true to actually run"),
    },
  },
  async ({ volume, path, target, confirm }) => {
    try {
      return text(await ops.restore(cfg, volume, path, target, Boolean(confirm)));
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
      "DESTRUCTIVE: short-erases tapes in the given slots (rewind + mt erase 0) — this DESTROYS all contents on them. One tape at a time, reported per slot; a bad tape reports an I/O error and is still rewound+unloaded. Requires confirm:true.",
    inputSchema: {
      slots: z.array(z.number()).describe("Slot numbers to erase, e.g. [14]"),
      confirm: z.boolean().optional().describe("Must be true to actually run"),
      force: z.boolean().optional().describe("Override the busy-library check"),
    },
  },
  async ({ slots, confirm, force }) => {
    try {
      return text(await tape.tapeErase(cfg, slots, Boolean(confirm), Boolean(force)));
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
