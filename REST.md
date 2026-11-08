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

## Cancelling a running or waiting job

Not testable read-only (mutating methods were not sent). `job_cancel <id>` therefore:

1. reads `GET general/jobs/<id>`; if not active it does nothing,
2. sends `DELETE /rest/v1/general/jobs/<id>` (**unverified guess** at the REST cancel endpoint),
3. polls the job state up to 3 times,
4. if the job is still active: falls back to nsdchat `Job <id> cancel` (running) or `Job <id> stop` (waiting/scheduled),
5. reports before/after state, the path used (`rest` or the nsdchat command) and any REST error.

First live use must be on a harmless job and the report checked.

## archiware-mcp tools

`rest_resources`, `rest` (GET free; POST/PUT/DELETE need confirm / `--yes`; path must be below `/rest/v1`, no `..`), `job_cancel`, `health`. `status`, `jobs` (without `--all`) and `job` prefer REST and fall back to nsdchat. `pools` and `volumes` stay on nsdchat: REST pool detail has no volume list and volume detail has no pool.
