# Configuration

## Where the configuration lives

| What | Where |
|---|---|
| Main config | `~/.config/archiware-mcp/config.json` |
| Another location | environment variable `ARCHIWARE_CONFIG`, or `--config <file>` on the CLI |
| REST password | a file, default `~/.config/archiware-mcp/rest.password`, mode 600 (key `restPasswordFile`) |
| Conversational library sessions | `library_session.json` next to the config file |

`archiware setup` writes the config file and creates the password file. You can edit the config by hand afterwards; `archiware doctor` checks it and prints a fix hint for every problem. Missing keys are replaced by the defaults below. Unknown keys are ignored.

`viewer_deploy` and `library_reconcile --yes` also write to this file (see the keys marked "written by"). Everything else is only read.

The REST password is never read from the environment or from the command line. It is read from the password file at call time and passed to `curl` on stdin.

## Environment overrides

These win over the config file:

| Variable | Overrides |
|---|---|
| `ARCHIWARE_CONFIG` | path of the config file |
| `ARCHIWARE_MODE` | `mode` |
| `ARCHIWARE_SSH_HOST` | `sshHost` |
| `ARCHIWARE_CONTAINER` | `container` |
| `ARCHIWARE_CONTAINER_IP` | `containerIp` |
| `ARCHIWARE_REST_URL` | `restUrl` |
| `ARCHIWARE_REST_USER` | `restUser` |
| `ARCHIWARE_REST_PASSWORD_FILE` | `restPasswordFile` |
| `ARCHIWARE_BACKUP_DIR` | `backupDir` |

## Minimal example (docker mode)

```json
{
  "mode": "docker",
  "sshHost": "backup-host.example",
  "container": "p5",
  "containerIp": "192.0.2.10",
  "composeDir": "/srv/archiware",
  "backupDir": "/srv/backup",
  "restUser": "admin",
  "restPasswordFile": "~/.config/archiware-mcp/rest.password",
  "changer": "/dev/sg3",
  "drives": [{ "element": 0, "gen": "L6", "nst": "/dev/nst0", "p5": "sg4" }],
  "cleaningSlot": 24
}
```

## Core keys: connection

| Key | Default | Meaning |
|---|---|---|
| `mode` | `docker` | Where P5 runs: `docker` (container on an ssh host), `ssh` (native on an ssh host), `local` (this machine) |
| `sshHost` | empty | Host reachable with plain `ssh <sshHost>` (key login). Docker and ssh mode |
| `container` | empty | Docker container name. Docker mode |
| `containerIp` | empty | Container IP, reachable from the docker host; used for the REST URL. Docker mode |
| `composeDir` | empty | Host directory of the docker compose project (source of the cold copy). Docker mode |
| `backupDir` | empty | Host directory where `container_backup` creates `archiware-update-<YYYYMMDD>`. Docker mode |
| `p5Home` | `/usr/local/aw` | P5 install directory of a native install. ssh and local mode |
| `nsdchat` | `<p5Home>/bin/nsdchat` | Path of `nsdchat` (inside the container in docker mode) |
| `restUrl` | docker: `https://<containerIp>:8443`; ssh, local: `https://localhost:8443` | REST base URL without trailing slash |
| `restUser` | `admin` | REST user |
| `restPasswordFile` | `~/.config/archiware-mcp/rest.password` | File (mode 600) with the REST password |
| `restTimeoutMs` | `20000` | REST call timeout |
| `timeoutMs` | `60000` | Timeout of a normal command |
| `longTimeoutMs` | `600000` | Timeout of the few calls that legitimately take minutes (volume inventories, index lookups) |
| `lockWaitS` | `120` | Seconds a call waits for the host-side nsdchat lock held by another call |

Required per mode (`doctor` reports what is missing): all modes need `restUrl`, `restUser`, `restPasswordFile`; docker adds `sshHost`, `container`, `containerIp`, `composeDir`, `backupDir`; ssh adds `sshHost`, `p5Home`.

## Core keys: library and health

| Key | Default | Meaning |
|---|---|---|
| `changer` | empty | Medium changer device on the P5 host (`sudo -n mtx -f <changer> status`) |
| `drives` | `[]` | Tape drives: `element` (mtx Data Transfer Element number), `gen` (`L6`, `L9`: decided by the barcode suffix), `nst` (host tape device), `p5` (P5 device name). Cannot be detected reliably, so you add them |
| `cleaningSlot` | `0` | Slot with the `CLN*` cleaning tape; `0` = none. `library_reconcile --yes` rewrites it if the cleaning tape moved |
| `slotLayout` | `{}` | Pool name to slot range or list, for example `{"Yearly": "9-12", "Daily": [14, 15]}` |
| `mailSlots` | `[]` | Import/export (mail slot) element ids; empty = taken from mtx |
| `logPath` | docker: empty; other modes: `<p5Home>/log/lexxsrv.log` | lexxsrv log on the P5 host (job report blocks, health). Docker mode: host path of the mounted log; empty = not available |
| `healthPaths` | `[]` | Host paths whose free space `health` checks (`df -P`) |
| `p5ConfigDir` | derived | Host path of P5's config folder (holds `customerconfig/` and `index/backup/`). Derived from `logPath` (`<logdir>/../config`) or `<p5Home>/config`. Read-only use |

## Core keys: governance and mail

| Key | Default | Meaning |
|---|---|---|
| `operatorMail` | empty | Address for `ensure_done --mail` and `notify_test --yes`, sent by the host MTA |
| `mailSilenceDays` | `3` | Days without a sent P5 mail (while jobs ran) before `doctor` / `health` warn |
| `governanceMonths` | `3` | Months back `governance_report` looks for runs |
| `disabledDays` | `60` | Days a plan may stay disabled before `governance_report` flags it |

## Optional keys: file catalogue and packs

Used by `pack`, `catalog_*`, `index_sync`, `find_file`, `restore_version`. See [d2d2t.md](d2d2t.md) and [index-and-search.md](index-and-search.md).

| Key | Default | Meaning |
|---|---|---|
| `catalogMysqlContainer` | `mysql` | Docker container on the P5 host that runs the catalogue database. `viewer_deploy` sets it to `catalog-db` |
| `catalogDbCnf` | `/root/.mysql-catalog.cnf` | File on the P5 host (mode 600) with the MySQL client credentials of the catalogue user. Never printed. `viewer_deploy` points it at `<dir>/secrets/catalog.cnf` |
| `packRoot` | `/srv/archive/pack` | Host directory under which `pack` writes its tar sets (`<packRoot>/<set>/`) |
| `packRootP5` | empty | The same directory as P5 sees it (docker mount point). Empty = same as `packRoot`. Used to look tars up in P5's backup index |
| `packMBps` | `150` | Assumed tar write throughput for the `pack` time estimate |
| `cacheTtlMinutes` | `60` | Minutes a cached slow P5 lookup stays fresh in the table `p5_cache`; an expired entry is still served, marked stale, when P5 is unreachable. `0` = no cache |

## Restore keys

Used by every restore path. See [restore.md](restore.md).

| Key | Default | Meaning |
|---|---|---|
| `restoreRoot` | `<packRoot>/restore` | Where restores land unless you say otherwise: `<restoreRoot>/<YYYYMMDD-HHMMSS>/<original absolute path>` |
| `syncRoots` | `[]` | Host paths whose content is synced to other machines (a Seafile library path, a sync mount). A restore destination below one gets a warning; `--to original` below one is refused without `--force-sync` |

## Optional keys: web viewer

Written by `viewer_deploy`; you normally do not edit them. See [web-viewer.md](web-viewer.md).

| Key | Default | Meaning |
|---|---|---|
| `viewerHost` | empty | Docker host of the viewer (ssh target). Empty = the P5 host |
| `viewerDir` | empty | Install directory of the viewer on that host (holds `docker-compose.yaml`, `secrets/`, `dumps/`). `viewer_status` and `catalog_migrate` need it |

## Secrets files

| File | Holds | Mode | Written by |
|---|---|---|---|
| `restPasswordFile` (local) | P5 REST password | 600 | `archiware setup` |
| `catalogDbCnf` (P5 host) | MySQL client file of the catalogue user | 600 | you, or `viewer_deploy` (`<dir>/secrets/catalog.cnf`) |
| `<viewerDir>/secrets/*` (docker host) | viewer database passwords, viewer login, session secret | 600, directory 700 | `viewer_deploy` |

The web viewer has its own two config files on the docker host (`<viewerDir>/config/config.json` and `<viewerDir>/secrets/secrets.json`); see [web-viewer.md](web-viewer.md#configuration-files-of-the-viewer).
