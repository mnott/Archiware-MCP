# Archiware MCP

MCP server and CLI to manage an **Archiware P5** backup server from Claude Code or a terminal, without the P5 web UI: status, pools, volumes, plans, jobs, restores, tape library operations and, for container installs, cold backup and update of the P5 container.

> **Unofficial.** This project is not affiliated with, authorized or endorsed by Archiware GmbH. Archiware and P5 are trademarks of Archiware GmbH.

P5's scripting interface is `nsdchat`; since P5 8 there is also a REST API. This tool uses both (REST first, nsdchat as fallback and for what REST lacks) on the machine where P5 runs, reached over ssh or locally.

## Install

Prerequisites: [Claude Code](https://claude.com/claude-code) and Node.js 20 or newer.

The easy way: tell Claude Code

> Clone https://github.com/mnott/Archiware-MCP and set it up for me

Claude reads this repository, finds the setup skill (`skills/setup`) and walks you through it: it asks where Archiware runs and for the connection details one question at a time, runs `archiware setup`, then `archiware doctor`, and reports a pass/fail list. It never asks you to paste the REST password into chat: you type it at a hidden prompt.

Or by hand. There is no npm registry; the install is the GitHub Release tarball:

```
npm i -g https://github.com/mnott/Archiware-MCP/releases/latest/download/archiware-mcp.tgz
archiware setup
archiware doctor
```

Update by re-running the install line, or `archiware update` (`archiware update --check` only reports). From a clone instead: `npm install && npm run build && npm link`.

The same repository is also a Claude Code plugin (skill only): `claude plugin marketplace add mnott/Archiware-MCP`, `claude plugin install archiware@archiware`, then say "set up Archiware".

## Quick start

```
archiware setup          # asks for mode, host, container, REST user; hidden prompt for the REST password
archiware doctor         # pass/fail list with a fix hint per line
archiware status         # devices, jukeboxes, pools, running and scheduled jobs
archiware plans          # backup plans
archiware jobs           # recent jobs
```

Mutating commands print what they would do and change nothing until you add `--yes`. After `setup`, restart Claude Code (or run `/mcp`) so the `archiware` MCP server is loaded; then ask for "status" in plain words.

## Guides

Task-oriented walkthroughs with examples (CLI and MCP form), each: why, steps, example, watch out.

| Task | Example | Guide |
|---|---|---|
| See and fix the slot layout of the library | `archiware library_layout` | [library-layout](docs/guides/library-layout.md) |
| Take tapes out and bring them back | `archiware offsite_status` | [offsite-rotation](docs/guides/offsite-rotation.md) |
| Morning checks, mail, cron | `archiware ensure_done --mail` | [daily-checks](docs/guides/daily-checks.md) |
| Look at plans, add a folder, run once, stop a job | `archiware plans` | [plans-and-tasks](docs/guides/plans-and-tasks.md) |
| Find a file in all backups and restore it | `archiware find_file offer.docx` | [find-and-restore-a-file](docs/guides/find-and-restore-a-file.md) |
| Pack a folder to tars, find and restore from them | `archiware pack /data/projects --set projects` | [d2d2t-packs](docs/guides/d2d2t-packs.md) |
| Set up the backup index copy and search | `archiware index_sync --detach` | [index-search-setup](docs/guides/index-search-setup.md) |
| Deploy the web viewer behind a reverse proxy | `archiware viewer_deploy --network N ...` | [web-viewer-setup](docs/guides/web-viewer-setup.md) |
| Back up and update the P5 container | `archiware container_status` | [p5-container](docs/guides/p5-container.md) |
| Clean, label, inventory, read, erase tapes | `archiware slots` | [tape-maintenance](docs/guides/tape-maintenance.md) |

## Modes: where Archiware runs

Set once by `archiware setup` as the config key `mode`:

| mode | P5 runs | nsdchat runs as | REST | needs |
|---|---|---|---|---|
| `docker` | in a container on an ssh host | `ssh <sshHost> docker exec <container> nsdchat -c ...` | `https://<containerIp>:8443`, curl on the host | ssh key login, `docker` without sudo on the host |
| `ssh` | natively on a remote host | `ssh <sshHost> <p5Home>/bin/nsdchat -c ...` | `restUrl` (default `https://localhost:8443`), curl on that host | ssh key login |
| `local` | on this machine | `<p5Home>/bin/nsdchat -c ...` | `restUrl` (default `https://localhost:8443`), curl locally | permission to run nsdchat |

All tools work in every mode. The `container_*` tools exist only for docker mode and answer "not applicable" otherwise. Host-side tape operations (`mtx`, `mt`, `dd`) run on the P5 host in every mode and need passwordless `sudo -n` for them there.

## Features

**Core** (works after `archiware setup`, needs nothing else):

| Area | Tools | Documented in |
|---|---|---|
| Status and health | `status`, `slots`, `volumes`, `pools`, `health`, `doctor` | [CLI reference](docs/cli.md) |
| Plans, jobs, tasks | `plans`, `plan`, `jobs`, `job`, `job_history`, `find_tasks`, `task_*`, `run_tasks_once`, `start_plan`, `dryrun_plan`, `enable_plan`, `disable_plan`, `stop_job`, `job_cancel`, plan editing | [CLI reference](docs/cli.md) |
| Tape library | `library_layout`, `library_arrange`, `tape_export`, `tape_import`, `library_plan`/`step`/`status`/`abort`/`reconcile`, `offsite_status`, `tape_load`/`unload`/`read_header`/`erase`, `clean_drive`, `label_tapes`, `inventory` | [Operations](docs/operations.md) |
| Governance and mail | `governance_report`, `governance_apply`, `schedule_check`, `ensure_done`, `notify_status`, `notify_set`, `notify_test` | [Operations](docs/operations.md) |
| Restore | `restore_options`, `restore`, `restore_archive`, `restore_volume`, `restore_lookup` | [Restore](docs/restore.md) |
| P5 container (docker mode) | `container_status`, `container_backup`, `container_stop`, `container_start`, `container_update` | [Operations](docs/operations.md) |
| Passthrough | `rest_resources`, `rest`, `nsdchat` | [CLI reference](docs/cli.md) |

**Optional** (needs a catalogue database; each part can be used without the next):

| Component | What it gives you | Tools | Documented in |
|---|---|---|---|
| File catalogue for tar packs (D2D2T) | Pack folders into tars on disk, record every file, find which tar and which tape holds a file | `catalog_init`, `pack`, `pack_status`, `pack_stop`, `catalog_sets`, `catalog_search`, `catalog_restore`, `catalog_drop` | [D2D2T](docs/d2d2t.md) |
| Backup index copy and file search | Copy P5's slow SQLite backup index into the catalogue database; search every version of a file by name in under a second, with the cheapest place to fetch it from | `index_sync`, `index_status`, `find_file`, `restore_version` | [Index and search](docs/index-and-search.md) |
| Web viewer | Read-only web page (search, sets, browse, tape side) with its own database and a nightly dump, deployed by one command | `viewer_deploy`, `viewer_status`, `catalog_migrate` | [Web viewer](docs/web-viewer.md) |

Restores are always planned first and confirmed with `--yes --plan <id>`. They go to a restore folder by default, never to the original location. Single files from a tar on disk are extracted by the tool; one path of a P5 backup version is not: P5's CLI and REST cannot select it, so the tool prints the exact P5 GUI steps. See [Restore](docs/restore.md).

## Documentation

| Page | Content |
|---|---|
| [docs/configuration.md](docs/configuration.md) | Every config key with default and meaning, secrets files, environment overrides |
| [docs/cli.md](docs/cli.md) | All commands (`archiware help`) |
| [docs/operations.md](docs/operations.md) | Library, mail slot, governance, schedule check, ensure_done, mail, tape tools, safety model |
| [docs/restore.md](docs/restore.md) | Restore tools, plan and plan id, destinations, conflicts, sync roots |
| [docs/d2d2t.md](docs/d2d2t.md) | Optional: file catalogue and tar packs |
| [docs/index-and-search.md](docs/index-and-search.md) | Optional: backup index copy and `find_file` |
| [docs/web-viewer.md](docs/web-viewer.md) | Optional: web viewer, reverse proxy, backup, upgrade |
| [REST.md](REST.md) | What was found about P5's REST API |
| [CHANGELOG.md](CHANGELOG.md) | Changes |

## MCP tools

The MCP server has the same names as the CLI subcommands, with `-` replaced by `_` (`job-history` is `job_history`, `find-tasks` is `find_tasks`, `task enable` is `task_enable`, `run-once` is `run_tasks_once`). `archiware setup` registers the server with `claude mcp add` (user scope); by hand: `claude mcp add archiware -s user -- archiware-mcp`. Mutating MCP tools take `confirm: true`; restore tools also take `planId`.

## Safety model

- Mutating MCP tools require an explicit `confirm: true`; the CLI requires `--yes`. Without confirmation they only report the exact commands that WOULD run and change nothing.
- `label_tapes` and `tape_erase` are destructive. P5 restores never go to the original location; restores from a tar go there only with an explicit `--to original`. `dryrun_plan` is safe.
- The `nsdchat` passthrough runs read-only methods directly; anything else needs confirmation. `rest` GETs run directly; POST/PUT/DELETE need confirmation.
- `container_*` refuse while a P5 job runs (unless forced); `container_update` also refuses without a backup younger than 24 h.
- Credentials: the REST password lives in a mode-600 file, is read at call time and handed to curl on stdin, never in argv, environment or logs.

More in [docs/operations.md](docs/operations.md#safety-model).

## REST notes

P5 8 serves a REST API on port 8443 (self-signed certificate, not verified: the hop is a LAN/loopback one). Findings are in [REST.md](REST.md). `status`, `jobs` and `job` prefer REST with nsdchat fallback; `pools` and `volumes` stay on nsdchat because REST lacks the pool/volume relation.

## Development

`npm install && npm run build` (`npm run typecheck` for types only). `package.json` is `private`: releases are GitHub Release tarballs (`npm pack` gives the `.tgz` to attach as `archiware-mcp.tgz`), never an npm registry publish.

## License

MIT, see [LICENSE](LICENSE).
