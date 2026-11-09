# P5 REST API (8.x): findings

Discovered from a live server with GET requests only (OPTIONS is answered 405). The Archiware docs site was not reachable. Everything below marked **unverified** could not be tested without a mutating call.

## Access

- Base: `https://<containerIp>:8443/rest` (docker mode; `restUrl` in ssh/local mode), HTTP basic auth (`restUser`, password from `restPasswordFile`), self-signed certificate (curl `-k`).
- `GET /rest` without credentials: HTTP 400. With credentials: list of resources, each with a `self` link to `/rest/v1/<resource>`.
- archiware-mcp runs `curl` on the P5 host (over ssh, or locally in local mode); the credentials and any body are fed to `curl -K -` on stdin, never in argv.

## Resources (GET /rest)

general/srvinfo, license/resources, backup2go/templates|servers|workstations, archive/plans|entries|indexes, backup/plans, synchronize/plans, general/clients|devices|jukeboxes|pools|volumes|jobs, restore/restoreselections.

## Read behaviour (verified)

| Path | Result |
|---|---|
| `general/srvinfo` | object: address, hostname, port, server, version, lexxvers (e.g. 8.0.6), platform, hostid, buildstamp, uptime (seconds), home |
| `general/jobs` | `{"jobs":[{"ID":"1234","links":[...]}]}` (ids of all current jobs) |
| `general/jobs/<id>` | label, description, status, completion, runat, resourcegroup, resourcename, totalfiles, totalkbytes. Unknown id: HTTP 200 with `{}` |
| `general/pools` / `general/pools/<name>` | list of `ID`; detail: mediatype, usage, usedsize, totalsize (KB), enabled, drivecount. No volume list |
| `general/volumes` / `general/volumes/<id>` | detail: mediatype, label, barcode, isonline, location, mode, state, usage, dateused, dateexpires, usecount, maxsize, usedsize, totalsize, enabled, copyof, usetime, error counters. No pool |
| `general/devices` / `<id>` | list of ids; detail: `cleaning` flag only |
| `general/jukeboxes` / `<id>` | list; detail: `slotcount` |
| `general/clients` | list of ids |
| `backup/plans` / `<id>` | detail: description, enabled, retention, loglevel, stophours, progressive, canceltime, startnewvol, tasknames |
| `archive/indexes` | list; `archive/plans`, `synchronize/plans`, `backup2go/servers` returned `{}` (none configured) |
| `restore/restoreselections` | `null` |

Query parameters such as `?status=running` or `?offset=1` are ignored by the server (full list returned); filter client-side.

## Job states

Seen live: `scheduled` (future runs; `completion` is then a placeholder like `failure`). Active states treated by archiware-mcp: `running`, `waiting`, `pending`, `scheduled`. No running or waiting job existed during the discovery, so those state names are **unverified** against REST output; nsdchat names are running / pending.

## Job listing and history

- REST `general/jobs` lists only current (active/scheduled) jobs; a finished job answers HTTP 404 on `general/jobs/<id>`. nsdchat `Job names` lists only scheduled jobs, `Job running` / `Job pending` the active ones.
- History still exists in the job database: `Job <id> status|describe|completion|resourcename|totalkbytes|totalfiles|protocol` answers for finished ids (`completed`, `terminated`, `cancelled`), exit 100 for ids that do not exist. Ids are contiguous, so `job-history` walks them downward from the newest known id.
- A finished job's `describe` is the plan name; a scheduled job's is `<plan> - '<client>'`. `runat` is 0 for finished jobs; the start time is the protocol line `Client time: DD-Mon-YYYY HH:MM:SS` (server-local). The first protocol line says `Full save of: <path> to pool <pool>.`.
- nsdchat -c evaluates its words as a Tcl script, so one call can loop over many ids (`foreach i {...} {catch {Job $i status}}`): 100 ids per call instead of one ssh round trip per few ids (about 6 s for 300 ids instead of over 2 minutes).
- nsdchat is not safe for concurrent use: two simultaneous calls fail with "can't create communication pipes ... .rcli.0: file already exists" (exit 10). archiware-mcp runs every call under `flock /tmp/archiware-mcp-nsdchat.lock` on the P5 host and retries exit 10 with backoff.

## Cancelling a running or waiting job (verified live)

Tested on a dry-run job (`BackupPlan <id> dryrun`, which only starts while the plan is enabled and has an event) of a throwaway plan:

- `DELETE /rest/v1/general/jobs/<id>` **works**: HTTP 200, empty body; the job's nsdchat status turns `cancelled` (completion `exception`) within a second; afterwards REST `GET general/jobs/<id>` is 404.
- nsdchat `Job <id> cancel` also works for a running job (returns 1; the status changes to `cancelled` a moment later). `Job <id> stop` and `cancel` on an already cancelled job: exit 100.

`job_cancel <id>`:

1. reads `GET general/jobs/<id>`; if not active it does nothing,
2. sends the DELETE,
3. polls the state (REST, or nsdchat when REST answers 404) up to 3 times,
4. only if the job is still active: nsdchat `Job <id> cancel` (running) or `Job <id> stop` (waiting/scheduled),
5. reports before/after state, completion, the path used (`rest` or the nsdchat command) and any REST error.

## archiware-mcp tools

`rest_resources`, `rest` (GET free; POST/PUT/DELETE need confirm / `--yes`; path must be below `/rest/v1`, no `..`), `job_cancel`, `health`. `status`, `jobs` (without `--all`) and `job` prefer REST and fall back to nsdchat. `pools` and `volumes` stay on nsdchat: REST pool detail has no volume list and volume detail has no pool.

## Restore selections and mail (checked live, read-only)

- nsdchat `RestoreSelection`: methods that exist are `create`, `describe`, `volumes`, `entries`, `size`, `addentry <handle>`, `addfromvolume <volume>`, `findentry <archive index or plan> <query>`, `submit`, `destroy`. `findentry` on a backup index or backup plan answers `no such index or plan`; `ArchiveEntry handle` answers `no such database` for backup databases. A selection created and destroyed without submit leaves nothing behind.
- REST `POST restore/restoreselections` answers HTTP 400 `Missing Client ID` for every JSON body and query shape tried; the body format is undocumented.
- A failed nsdchat call prints nothing on stderr; `geterror` in the same `nsdchat -c` Tcl script returns the message.
- The backup index per client is SQLite under `<config>/index/backup/bsx_<client>/` (`files.db` elements with btime/dtime/mtime/size and `snapshots`, `addrs.db` addresses id -> volume id). P5's mail settings (`Client` `localhost`: mailServer, mailPort, mailSender, mailUser, encrypted password; `UserPref`: email, allowNotify, mailSeverity) are in `customerconfig/resources.db`. Neither is reachable through nsdchat or REST.
- nsdchat `Job pending` also lists future scheduled runs (status `scheduled`).
- The maintenance restart window is logged at start (`Attempt restart on Sun, 04:00 - 07:00`); not exposed by nsdchat or REST.
