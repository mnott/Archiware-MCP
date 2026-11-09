# Web viewer (optional)

The web viewer is an optional component. Nothing else in archiware-mcp needs it. Skip this page if you do not want a web page.

## What you get

A small read-only web page next to the P5 web UI:

- Search by file name (substring, or glob with `*` and `?`) across the tar catalogue and, once you have run `index_sync`, across P5's backup index too. See [index-and-search.md](index-and-search.md).
- Each version of a file shows where it can be fetched from: "on disk", "tape in library", "tape offline: <barcode>".
- Sets, folder browse of a set, a detail page per file.
- For every hit the exact CLI command to restore it, with the default destination. The page never restores anything itself; restores stay confirm-gated in the CLI / MCP (see [restore.md](restore.md)).
- A link to the P5 web UI (config key `p5BaseUrl`).

Pages: `/` search, `/hit` detail, `/sets`, `/browse?set=NAME[&dir=sub/folder]`, `/login`, `/logout`.

## Requirements

- A docker host with `docker` and the `docker compose` plugin. In docker mode this is normally the P5 host. The MCP reaches the viewer's database with `docker exec` on the P5 host, so for `pack` and the `catalog_*` tools the viewer has to run on the P5 host. On another docker host the page works, but the MCP config is not rewired.
- An existing (external) docker network and two free IPv4 addresses on it: one for the web page, one for the database. `docker network inspect <network>` lists the used addresses.
- The P5 backup index directory on that host (`<P5 config>/index/backup`) and the pack root (`packRoot`), both mounted read-only.
- ssh key login to the docker host from the machine that runs archiware-mcp (as for the rest of the tool).
- HTTPS in front of the page for login (see [Reverse proxy](#run-it-behind-a-reverse-proxy-under-a-sub-path)).

## The three containers

One compose project, `web/docker-compose.yaml`, on the external docker network:

| Container | Image | What it does |
|---|---|---|
| `catalog` | built from `web/Dockerfile` (Node 22, one runtime dependency `mysql2`) | The web page. Read-only root file system, runs as the install user, port 8080 on its fixed IP |
| `catalog-db` | `mariadb:11.4` (LTS) | The catalogue's own database `archive_catalog`. Data directory on the host. Port 3306 on its fixed IP (the MCP connects here). Has a health check |
| `catalog-dump` | `mariadb:11.4` | One `mariadb-dump --single-transaction` at start and then one per night at 02:00 into `dumps/archive_catalog-YYYYMMDD.sql.gz`. Keeps the last 14. Skips the cache table |

`catalog` and `catalog-dump` wait for `catalog-db` to be healthy. Nothing inside a container survives a rebuild: database files, dumps, secrets and config are host directories.

Database users (created or updated on every deploy):

| User | Rights | Used by |
|---|---|---|
| `catalog` | all on `archive_catalog` | the MCP (`pack`, `catalog_*`, `index_sync`) and the dump |
| `catalog_ro` | `SELECT` on `archive_catalog`; `INSERT`, `UPDATE` on `p5_cache` only | the web page |

## Set up the web viewer

### With the tool

Plan first, nothing is changed without `--yes`:

```
archiware viewer_deploy --network dockernet --catalog-ip 192.0.2.30 --db-ip 192.0.2.31
```

Then deploy:

```
archiware viewer_deploy --network dockernet --catalog-ip 192.0.2.30 --db-ip 192.0.2.31 --yes
```

Options:

| Option | Default | Meaning |
|---|---|---|
| `--network N` | required | Existing docker network |
| `--catalog-ip IP` | required | Address of the web page on that network |
| `--db-ip IP` | required | Address of the database; must differ from `--catalog-ip` |
| `--host H` | `viewerHost` from the config, else the P5 host (`sshHost`); local mode: this machine | Docker host (ssh target) |
| `--dir D` | `viewerDir` from the config, else `/opt/catalog-viewer` | Install directory on that host |
| `--data-dir D` | `<dir>/data/db` | Database files |
| `--p5-index D` | `<P5 config>/index/backup` | P5 backup index on the host (mounted read-only) |
| `--pack-root D` | `packRoot` from the config | Pack root on the host (mounted read-only) |
| `--subpath S` | none | Reverse-proxy sub-path; only adds an Apache example to the output |
| `--viewer-user U` | `viewer` | Login user name |
| `--p5-base-url URL` | empty | Link target for "P5 web UI" |
| `--tz Z` | `UTC` | Time zone of the containers |

Through MCP the tool is `viewer_deploy` with the same options (`confirm: true` instead of `--yes`).

What a confirmed deploy does:

1. Copies `web/` to the install directory (without `secrets/`, `data/`, `dumps/`, `.env`, `config/config.json`, and without the local owner and group).
2. Generates any missing secret (see [Secrets](#env-and-secrets)). The viewer password is printed once.
3. Writes `.env` and `config/config.json`.
4. Runs `docker compose up -d --build` and waits up to 3 minutes for `catalog-db` to be healthy.
5. Creates or updates the database users inside `catalog-db`, verifies the `catalog` login, and creates the schema (`catalog_init`).
6. If the docker host is the P5 host: sets `catalogMysqlContainer` to `catalog-db` and `catalogDbCnf` to `<dir>/secrets/catalog.cnf` in the MCP config, so `pack` and `catalog_*` use the new database. Always records `viewerHost` and `viewerDir`.

Save the printed viewer password at once. Only its hash is stored.

### With `archiware setup` or the setup skill

`archiware setup` asks "Deploy the catalogue viewer ... [y/N]" after the P5 connection step, then asks for host, install dir, data dir, network, the two IPs, P5 index dir, pack root and an optional sub-path, shows the plan and asks again before deploying. The Claude Code setup skill (`skills/setup`, section "Optional: catalogue viewer") asks the same questions one at a time, runs the plan, and deploys only after your yes.

### By hand

Use this when you do not want `viewer_deploy`, for example because the compose files go into your own repository. In the install directory:

1. Copy `web/` there.
2. `cp .env.example .env` and edit it (see [.env](#env-and-secrets)).
3. Create the secrets (see [Secrets](#env-and-secrets)) in `./secrets`, each mode 600:
   ```
   umask 077
   mkdir -p secrets config dumps
   openssl rand -hex 24 > secrets/db_root_password
   openssl rand -hex 24 > secrets/db_catalog_password
   openssl rand -hex 24 > secrets/db_catalog_ro_password
   printf '[client]\nuser=catalog\npassword=%s\n' "$(cat secrets/db_catalog_password)" > secrets/catalog.cnf
   ```
   The passwords must be non-empty and only `A-Za-z0-9_-`; hex is safe.
4. `cp secrets/secrets.example.json secrets/secrets.json` and fill it in. Hash for the login: `docker compose run --rm catalog node dist/hashpw.js 'the password'` (the image has to be built first: `docker compose build`).
5. `cp config/config.example.json config/config.json` and edit it.
6. `docker compose up -d --build`.
7. Create the users and the schema. The compose file only sets the root password, so create `catalog` and `catalog_ro` yourself, or run `archiware viewer_deploy ... --yes` once afterwards: it keeps what exists and does this step idempotently.
8. In the MCP config set `catalogMysqlContainer` to `catalog-db`, `catalogDbCnf` to `<install dir>/secrets/catalog.cnf`, `viewerDir` to the install directory (and `viewerHost` if it is not the P5 host); run `archiware catalog_init`.

Open `http://<catalog-ip>:8080/`.

## Configuration files of the viewer

### `.env`

Written by `viewer_deploy` (template: `web/.env.example`). Read by `docker compose`.

| Variable | Compose default | Meaning |
|---|---|---|
| `DOCKER_NETWORK` | `dockernet` | External docker network |
| `CATALOG_IP` | `192.0.2.30` | Fixed IP of `catalog` |
| `CATALOG_DB_IP` | `192.0.2.31` | Fixed IP of `catalog-db` |
| `P5_INDEX_DIR` | placeholder path | Host path of P5's `config/index/backup`, mounted read-only at `/p5index` |
| `PACK_ROOT` | placeholder path | Host path of the pack root, mounted read-only at `/packroot` |
| `DB_DATA_DIR` | `./data/db` | Database files |
| `CATALOG_UID`, `CATALOG_GID` | `1000` | The web container runs as this user so it can read `./secrets`; `viewer_deploy` writes the ids of the ssh user |
| `TZ` | `UTC` | Time zone |

The defaults in the compose file are placeholders from the documentation ranges; set real values.

### `config/config.json`

Written by `viewer_deploy` for the keys it owns. Keys you add yourself are kept on the next deploy.

| Key | Default | Meaning |
|---|---|---|
| `listen` | `8080` | Port in the container |
| `p5BaseUrl` | empty | Link target for "P5 web UI" |
| `p5RestUrl` | empty | P5 REST base URL (from the MCP `restUrl`) |
| `p5Client` | `localhost` | P5 client whose index is used for the tape lookup of tars |
| `indexDir` | `/p5index` | Mount point of the P5 index |
| `mysqlHost`, `mysqlPort`, `mysqlDatabase` | none, `3306`, `archive_catalog` | Database address (`mysqlHost` = `CATALOG_DB_IP`) |
| `packRoot`, `packRootMount`, `packRootP5` | none, `/packroot`, empty | Pack root as stored in the catalogue, where it is mounted in the container, and as P5 sees it |
| `restoreRoot` | `<packRoot>/restore` | Default restore destination shown in the copyable commands. Not written by `viewer_deploy`: if you changed `restoreRoot` in the MCP config, add it here too |
| `mailSlots` | `[]` | Slot numbers that are mail slots (decides "mail slot" vs "library slot") |
| `cliName` | `archiware` | Command name shown in the copyable restore commands |
| `cacheTtlMinutes` | `60` | Lifetime of cached P5 lookups; `0` = off |

Change a value, then `docker compose restart catalog` in the install directory.

### `.env` and secrets

`viewer_deploy` creates only what is missing and keeps what exists, so a re-deploy does not log anyone out or change a password. The plan shows `kept:` and `generated:` before you confirm.

| File in `<dir>/secrets` | Holds | On re-deploy |
|---|---|---|
| `db_root_password` | database root password | kept |
| `db_catalog_password` | password of the `catalog` user | kept |
| `db_catalog_ro_password` | password of the `catalog_ro` user | kept |
| `catalog.cnf` | `[client]` file for the MCP (user `catalog`) | kept |
| `secrets.json` | `mysql` (`catalog_ro` + password), `p5` (REST user + password), `auth` (login user + scrypt hash), `sessionSecret` | `auth` and `sessionSecret` kept if present; `mysql` and `p5` are always rewritten from the current passwords and from `restPasswordFile` |

The directory has mode 700, files 600. Passwords are never in the compose file or `.env`: `catalog-db` reads `MARIADB_ROOT_PASSWORD_FILE`. Treat the `secrets/` directory like the REST password: do not commit it. The shipped `web/.gitignore` ignores `secrets/`, `.env`, `data/`, `dumps/`.

The `p5` entry is the account the page uses for P5's REST volume list. A read-only P5 user is better than `admin`: edit it in `secrets.json`, but note that the next `viewer_deploy` overwrites it with `restUser` from the MCP config.

## Login

- The page has a login form (user and password). There is one login.
- The session is a signed cookie (`catalog_session`, HttpOnly, SameSite=Lax, 30 days). The signing key is `sessionSecret` in `secrets.json`. Without it a random key is made at every start and everyone is logged out on restart. `viewer_deploy` generates one.
- The cookie is `Secure`. The login therefore only sticks over HTTPS, that is, through your reverse proxy. Over plain `http://<catalog-ip>:8080/` the form is shown but you stay logged out.
- The login form sends the password in clear text. Put the page behind TLS before using it beyond a trusted LAN.

### Change the password

Make a hash and put it into `secrets.json`:

```
cd <install dir>
docker compose run --rm catalog node dist/hashpw.js 'the new password'
```

Copy the printed `scrypt$...` string into `auth.hash` in `secrets/secrets.json` and restart the page:

```
docker compose restart catalog
```

To get a new generated password instead: remove the `auth` entry from `secrets.json` and run `archiware viewer_deploy ... --yes` again; the new password is printed once. To log everyone out, change `sessionSecret` and restart.

## Run it behind a reverse proxy under a sub-path

Every link in the page is relative, so the page works under a sub-path such as `https://www.example.org/viewer/`. No `base` tag or path rewriting is needed. Two things matter:

- The sub-path rule must come before any catch-all proxy rule (the first match wins).
- `/viewer` without the trailing slash has to be redirected to `/viewer/` and must not reach a catch-all proxy: the relative links only resolve correctly with the slash.

### Apache

Inside the `VirtualHost` of the site (placeholder host and address):

```
ProxyPass /viewer/ http://192.0.2.30:8080/
ProxyPassReverse /viewer/ http://192.0.2.30:8080/
# /viewer without the slash must not reach a catch-all proxy rule
ProxyPass /viewer !
RedirectMatch ^/viewer$ https://www.example.org/viewer/
```

`viewer_deploy --subpath viewer` prints this snippet with your catalog IP filled in.

### nginx

```
location = /viewer {
    return 301 https://www.example.org/viewer/;
}
location /viewer/ {
    proxy_pass http://192.0.2.30:8080/;
}
```

With a trailing slash on `proxy_pass` nginx strips `/viewer/` before it forwards. A catch-all `location /` elsewhere in the same server block does not clash: the longer prefix and the exact match win.

## Backups

The catalogue holds the only copy of "which file is in which tar", apart from the `<tar>.list` files next to the tars, and (after `index_sync`) a copy of P5's index that can be rebuilt.

- `catalog-dump` writes `<dir>/dumps/archive_catalog-YYYYMMDD.sql.gz` at start and every night at 02:00 and keeps the last 14. The cache table `p5_cache` is not dumped; it refills itself. After downtime there is no catch-up beyond the next loop.
- Put `<dir>/dumps` into a P5 backup plan. The data directory can be backed up too, but only consistently while `catalog-db` is stopped.
- Restore from a dump:
  ```
  gunzip -c dumps/archive_catalog-YYYYMMDD.sql.gz | docker exec -i catalog-db sh -c 'mariadb -uroot -p"$(cat /secrets/db_root_password)" archive_catalog'
  ```
- `viewer_status` shows the newest dump and how many are kept.

## Status

```
archiware viewer_status
```

Shows the three containers with state and health, the user the dump runs as, the newest dump (file, size, time) and the number of dumps kept, the database size and row counts (`sets`, `tars`, `entries`), and the cache (entries, newest, TTL). It needs `viewerDir` in the config.

## Upgrade

Update archiware-mcp (`archiware update`), then re-run the same `viewer_deploy ... --yes`. It copies the new `web/`, keeps all secrets and the database, rebuilds the images and restarts the containers. Existing keys in `config/config.json` that you added are kept.

By hand: copy the new `web/` files over the install directory (not `secrets/`, `data/`, `dumps/`, `.env`, `config/config.json`), then `docker compose up -d --build`.

## Uninstall

On the docker host, in the install directory:

```
docker compose down
```

This removes the containers and keeps everything on the host. Delete the install directory (it contains the database files, secrets and dumps) only when you no longer need the catalogue: keep a dump first. Then remove `viewerHost` and `viewerDir` from the MCP config, and point `catalogMysqlContainer` / `catalogDbCnf` at another catalogue database; they still name the removed viewer database until you do.

## Move an existing catalogue database into the viewer

If you had the catalogue in another MySQL (the earlier setup used a MySQL 8 container), copy it into `catalog-db`. Plan first:

```
archiware catalog_migrate --from db-old.example:3306 --user catalog --password-file ~/.config/archiware-mcp/old-db.password --source-tls skip-verify
```

Then add `--yes`. Details:

- `--password-file` is read on the machine that runs archiware-mcp and sent over stdin into a temporary mode-600 client file inside `catalog-db`, removed afterwards.
- The source user needs `SELECT` on `archive_catalog` and permission to connect from the docker host. The source is only read.
- `--source-tls` is `verify` (default), `skip-verify` (encrypted, certificate not checked; for a self-signed certificate such as the MySQL 8 default) or `off`.
- Row counts of `sets`, `tars` and `entries` are compared on both sides before and after; the result says `row counts match` or reports the difference.
- A target that already holds rows is refused without `--force`. With `--force` the copy drops and recreates `sets`, `tars`, `entries`. `p5_cache` is not copied.
- It needs `viewerDir` in the config (run `viewer_deploy` first).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `docker network "<name>" does not exist` | The network is external and must exist. `docker network ls` on the docker host; pass the right `--network` |
| `catalog-db is "starting"/"unhealthy" after 3 minutes` | `docker logs catalog-db` on the docker host. Usually the data directory is not writable or the first start is still initialising a big directory |
| Database users `catalog` / `catalog_ro` do not exist, or `database user "catalog" cannot log in ... with secrets/catalog.cnf` | The data directory was initialised before the passwords existed, or the files in `secrets/` changed afterwards. Re-run `viewer_deploy ... --yes`: it creates or updates the users from the current `secrets/` files as root inside the container and verifies the login. The passwords must be non-empty and only `A-Za-z0-9_-` |
| `catalog` container restarts, `docker logs catalog` shows a permission error reading `/secrets/secrets.json` | The web container runs as `CATALOG_UID:CATALOG_GID` from `.env`. That user must be able to read `secrets/` (directory mode 700 means the owner only). Set both to `id -u` / `id -g` of the install user, or fix the owner of `secrets/`, then `docker compose up -d` |
| `cannot create <dir>/secrets` or `cannot write ...` | The ssh user cannot write the install directory. Create it with the right owner first |
| `git` complains about "dubious ownership" in the install directory | The directory was copied with another owner. `viewer_deploy` copies without the local owner and group, so files belong to the remote ssh user; if you copied by hand, `chown -R` to the user who runs git, or `git config --global --add safe.directory <dir>` |
| `catalog_migrate`: ERROR 2026, "SSL", "TLS" | The source's certificate was rejected by the client, typical for an older MySQL with a self-signed certificate. Retry with `--source-tls skip-verify`, or `off` for an unencrypted source |
| Login form appears again after login | The cookie is `Secure` and you use plain HTTP. Log in through the HTTPS reverse proxy |
| Everyone is logged out after a restart | `sessionSecret` is missing from `secrets.json`. Add a long random string, or re-run `viewer_deploy --yes` |
| Page shows "tape lookup failed" / "not on tape" for a hit | P5 REST is unreachable, the index mount is missing, or P5 never backed that path up. The rest of the page keeps working; with the cache an expired answer is shown marked stale |
| Search finds only tars | `index_sync` has not been run; a note on the page says so. See [index-and-search.md](index-and-search.md) |
| Page shows the wrong default restore destination | `restoreRoot` is not in `config/config.json` (see above) |
| `viewer_status`: "no viewer deployed (viewerDir is not set)" | Run `viewer_deploy`, or set `viewerDir` in the MCP config |

For a walkthrough see [web viewer setup](guides/web-viewer-setup.md).
