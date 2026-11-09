# Catalogue web page (optional component)

Read-only web page for the archiware-mcp catalogue: search by file name across the tar catalogue and P5's backup index copy, see per version where it can be fetched from (on disk, tape in library, tape offline with barcode), browse sets, and copy the exact restore command. It never restores anything itself.

This directory is a self-contained compose project of three containers on an external docker network:

| Service | What it does |
|---|---|
| `catalog` | The web page (built from `Dockerfile`, Node 22, one runtime dependency `mysql2`). Port 8080 on a fixed IP |
| `catalog-db` | Its own MariaDB 11.4 with the catalogue database `archive_catalog`; data directory on the host; port 3306 on a fixed IP |
| `catalog-dump` | One `mariadb-dump` per night into `./dumps`, last 14 kept |

Files here:

| File | Purpose |
|---|---|
| `docker-compose.yaml` | The three services; site values come from `.env` |
| `.env.example` | Template for `.env` (network, IPs, host paths, user id, time zone) |
| `config/config.example.json` | Template for `config/config.json` (page settings) |
| `secrets/secrets.example.json` | Template for `secrets/secrets.json` (database user, P5 REST user, login hash, session secret) |
| `dump.sh` | The nightly dump loop of `catalog-dump` |
| `src/server.ts`, `src/hashpw.ts` | The page, and a tool that prints a login password hash |

`archiware viewer_deploy` copies this directory to the docker host, generates the secrets, writes `.env` and `config/config.json`, starts the stack, creates the database users and the schema, and points the MCP at the new database. `secrets/`, `.env`, `data/` and `dumps/` are never copied from here and are ignored by `.gitignore`.

Full documentation: [docs/web-viewer.md](../docs/web-viewer.md): setup (tool, setup skill, by hand), `.env` and secrets, login and password change, reverse proxy under a sub-path (Apache, nginx), backups, upgrade, uninstall, migrating an existing catalogue database, troubleshooting.

Quick start by hand, in a copy of this directory on the docker host:

```
cp .env.example .env && cp config/config.example.json config/config.json
# edit both, create secrets/ (see docs/web-viewer.md), then:
docker compose up -d --build
```
