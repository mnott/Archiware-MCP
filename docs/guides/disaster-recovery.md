# Disaster recovery of the P5 server

`p5_dr_kit` collects the small pieces you need to rebuild a lost P5 server. It works in docker mode only.

## Why

Rebuilding P5 needs more than the tapes:

- the P5 program version that was running (P5 updates land in the mounted program tree, not in the image)
- the container image
- the compose project: it pins hostname, MAC and IP, and the P5 license host id is derived from that IP, so the license moves with the compose file
- the configuration databases (`customerconfig/resources.db*`): pools, volumes, plans and the **encrypted** cloud-storage credentials
- the key files next to them in the config root (for example `*.key`, `ltokey`, `lexxsrv.*`, `nanopureparams`), needed to decrypt those credentials

The big indexes are covered elsewhere: [p5-config-backup](p5-config-backup.md) copies them locally, and P5 keeps its own copy on container volumes.

## What the kit holds

Destination: `<backupDir>/p5-dr-kit/` (override with `drKitDir`).

| Piece | Content | When written |
|---|---|---|
| `<stamp>/config-small/` | `sqlite3 .backup` copies of every SQLite database except `index/`, `joblog/`, `ltfsindex/`; plain copies of the other small config files (key files); the manifest lists every file taken | every run, 7 generations |
| `<stamp>/compose/` | compose file, Dockerfile, build script, `.env` if present | every run |
| `<stamp>/kit-small.tar.gz` | config-small + compose + manifest | every run; its size and SHA256 are printed |
| `<stamp>/manifest.json`, `SHA256SUMS`, `VERIFIED` | P5 version, image name/id/created, hostname/MAC/IP from the compose file, database list; `VERIFIED` only after `PRAGMA integrity_check` on each copy | every run |
| `image/` | `docker save <running image> \| gzip` | only when the image id changed, last 2 kept |
| `program/` | tar of the P5 program tree without `config/`, logs and temp | only when the P5 version changed, last 2 kept |

Config-small is expected to stay below 50 MB. The run refuses above 500 MB (something big slipped in).

The manifest holds the MAC and IP of the container. It stays on the server and in your kit-small copy; do not put it into public documents.

```bash
archiware p5_dr_kit            # plan with sizes, takes nothing
archiware p5_dr_kit --yes      # take the kit
archiware p5_dr_kit --status   # generations, last saved image and program version
```

Schedule it daily next to `p5_config_backup`:

```cron
30 1 * * *  archiware p5_dr_kit --yes >> /var/log/archiware-dr-kit.log 2>&1
```

`health` warns when the newest verified kit is older than 36 hours (only once a kit exists).

## Where each piece should live

A kit on the P5 host dies with the host. Put every piece somewhere else too:

| Piece | Where |
|---|---|
| whole `p5-dr-kit/` | another local disk or share (point `drKitDir` there) |
| whole `p5-dr-kit/` | tape, through a P5 backup plan that includes the folder |
| whole `p5-dr-kit/` | a cloud container volume via P5 |
| `kit-small.tar.gz` | a password manager or a private repository |

`kit-small.tar.gz` must live outside the cloud: the cloud credentials inside the configuration are encrypted with the key files, and the cloud copy of the kit cannot be reached without those credentials and keys. Keep it as small as it is, and treat it as a secret (it holds the keys and the `.env`).

## Rebuild procedure

1. **Docker host.** Install docker on the replacement host. Create the folders the compose file mounts.
2. **Macvlan network.** Create the docker network the compose file refers to, with the same parent interface, subnet and gateway as before.
3. **Compose project.** Unpack `kit-small.tar.gz` (or take `<stamp>/compose/`) into the compose directory. The hostname, MAC and IP in it must stay unchanged: the license host id derives from the IP.
4. **Image.** `gunzip -c image/<id>.tar.gz | docker load` (the `.json` next to it names the tag; `docker tag` it if the compose file expects another name). Or rebuild with the build script from the compose folder.
5. **Program tree.** Unpack `program/p5-<version>.tar.gz` into the mounted program folder (the one that holds `config/`).
6. **Config-small.** Copy `config-small/db/*` and `config-small/files/*` into `<program folder>/config/` with the same relative paths. Check the sums with `sha256sum -c SHA256SUMS` first.
7. **Start.** `docker compose up -d`. Wait until `archiware version` answers.
8. **Check the license.** Open the P5 web UI, Setup > License. The host id must match; if it shows a new id, the IP or MAC differs from before.
9. **Attach storage.** Tapes: connect the library, `archiware slots`, `archiware inventory` as needed. Cloud store: the credentials in the restored configuration decrypt with the restored key files.
10. **Restore the indexes.** From a [p5-config-backup](p5-config-backup.md) copy (copy `index/` into the config folder while P5 is stopped), or from P5's own copy on the container volume.
11. **Test restore.** Restore one known file to a scratch folder and compare it with the original.

## Test procedure

Do this once after the first kit and after every P5 update:

1. `archiware p5_dr_kit --status`: newest generation `verified`, image and program version match `archiware version`.
2. `sha256sum -c SHA256SUMS` inside the newest generation.
3. Unpack `kit-small.tar.gz` into a scratch folder and open a database copy: `sqlite3 config-small/db/customerconfig/resources.db "PRAGMA integrity_check;"` answers `ok`.
4. Check that `config-small/files/` holds the key files you expect.
5. Rebuild on a spare docker host with a different IP (the license will not match, everything else must start) and delete it afterwards.

## See also

- [p5-config-backup](p5-config-backup.md)
- [p5-container](p5-container.md)
- [offsite-rotation](offsite-rotation.md)
