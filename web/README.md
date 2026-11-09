# Catalogue web page

Read-only companion to the P5 web UI for the archiware-mcp tar catalogue: search the files that were packed into tars, see per hit which tar holds it, whether the tar is still on disk, and where it sits on tape (P5 volume label, barcode, library slot / mail slot / not in the library). The detail view shows the exact `catalog_restore` command and a link to the P5 web UI. There is no restore button: restores stay confirm-gated in the MCP server / CLI.

Pages: `/` search (substring or glob `*` `?`, optional set filter), `/hit` detail, `/sets`, `/browse?set=NAME[&dir=sub/folder]` folder browse.

One container, Node 22, one runtime dependency (`mysql2`). Nothing is written inside the container (`read_only: true`); secrets and config are mounted.

## Data sources

| What | How |
|---|---|
| sets, tars, files | MySQL `archive_catalog`, user `catalog_ro` with `SELECT` only |
| tape versions of a tar | P5's backup index (SQLite, mounted read-only, opened `immutable`); same lookup as `indexVersions()` in `src/p5db.ts` of archiware-mcp (copied, with `node:sqlite`) |
| volume label, barcode, location | P5 REST `general/volumes` (cached 2 min). Location text `... : Slot N` is a library slot, or a mail slot if N is in `mailSlots`; `isonline: false` = not in the library |
| tar on disk | the pack root mounted read-only; `stat` of the tar |

## Install

1. Read-only MySQL user (run on the P5 host; the container's root password stays inside the mysql container):

   ```
   docker exec -i mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD"' <<SQL
   CREATE USER 'catalog_ro'@'<web container ip>' IDENTIFIED BY '<generated password>';
   GRANT SELECT ON archive_catalog.* TO 'catalog_ro'@'<web container ip>';
   SQL
   ```

2. Pick a free address on the docker network (`docker network inspect dockernet` lists the used ones; confirm with a `ping` from the host) and put it into `docker-compose.yaml` (`ipv4_address`, example value is from the documentation range).
3. `cp config/config.example.json config/config.json` and edit: `p5BaseUrl` (link target), `p5RestUrl`, `mysqlHost`, `packRoot` (as stored in the catalogue), `packRootP5` (the same directory as P5 sees it), `mailSlots`.
4. `cp secrets/secrets.example.json secrets/secrets.json` and fill it: MySQL password, P5 REST user/password (a read-only P5 user is better than `admin`), basic-auth user and hash. Create the hash with `docker compose run --rm catalog node dist/hashpw.js 'the password'`. The container runs as uid 1000: `chown 1000:1000 secrets secrets/secrets.json; chmod 500 secrets; chmod 400 secrets/secrets.json`.
5. Edit the two host paths in `docker-compose.yaml` (P5 `config/index/backup`, pack root), then `docker compose up -d --build`.
6. `curl -u user:password http://<ip>:8080/sets`

Basic auth is sent in clear text: put the page behind the reverse proxy with TLS before using it beyond a trusted LAN.

## Notes

- A missing index mount, an unreachable P5 REST or a path P5 never backed up shows as "tape lookup failed" / "not on tape" on that hit; the rest of the page keeps working.
- A hit lists at most 100 results; the tape column is looked up for the first 40 distinct tars of a result list.
- `secrets/` is gitignored.
