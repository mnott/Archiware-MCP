# Guide: web viewer from zero to a reverse proxy

## Why

You want a small read-only web page where colleagues (or you) search backed-up files by name, see which tar and which tape holds a file, and copy the exact CLI restore command. The page never restores anything itself. One command deploys the page, its own MariaDB and a nightly dump on a docker host.

## What you do

1. Prerequisites: docker and the compose plugin on the host, an existing external docker network, two free IPv4 addresses on it (`docker network inspect <network>`), ssh key login.
2. Plan: `viewer_deploy --network <net> --catalog-ip <ip1> --db-ip <ip2>`. Nothing changes without `--yes`.
3. Deploy: same command with `--yes`. The viewer password is printed once; save it. The MCP config is pointed at the new database when the docker host is the P5 host.
4. Check: `viewer_status` (containers, health, database size, last dump).
5. Optional: `index_sync --detach` to fill it with P5's index ([index search setup](index-search-setup.md)); `catalog_migrate` to copy an existing catalogue.
6. Reverse proxy with TLS in front of `http://<catalog-ip>:8080/` (the login cookie is `Secure`, so it only sticks over HTTPS). Under a sub-path `/viewer/`: Apache or nginx snippet below.
7. Put `<dir>/dumps` into a P5 backup plan.

## Example

```
archiware viewer_deploy --network dockernet --catalog-ip 192.0.2.30 --db-ip 192.0.2.31 --subpath viewer
archiware viewer_deploy --network dockernet --catalog-ip 192.0.2.30 --db-ip 192.0.2.31 --subpath viewer --yes
archiware viewer_status
```

```
viewer_deploy {"network":"dockernet","catalogIp":"192.0.2.30","dbIp":"192.0.2.31","subpath":"viewer","confirm":true}
viewer_status {}
```

`viewer_status` (real output shape, anonymised):

```
{
  "host": "p5.example.lan",
  "installDir": "/opt/catalog-viewer",
  "containers": [
    { "name": "catalog",      "state": "running", "health": "-" },
    { "name": "catalog-db",   "state": "running", "health": "healthy" },
    { "name": "catalog-dump", "state": "running", "health": "-" }
  ],
  "lastDump": { "file": "/opt/catalog-viewer/dumps/archive_catalog-20261109.sql.gz", ... }
}
```

Apache (inside the site's VirtualHost):

```
ProxyPass /viewer/ http://192.0.2.30:8080/
ProxyPassReverse /viewer/ http://192.0.2.30:8080/
ProxyPass /viewer !
RedirectMatch ^/viewer$ https://www.example.org/viewer/
```

nginx:

```
location = /viewer { return 301 https://www.example.org/viewer/; }
location /viewer/ { proxy_pass http://192.0.2.30:8080/; }
```

Upgrade later: `archiware update`, then the same `viewer_deploy ... --yes`; secrets and data stay.

## Watch out

- The viewer password is shown once, only its hash is stored.
- Without TLS in front, the login form is shown but you stay logged out.
- The sub-path rule must come before any catch-all proxy rule.
- `pack` and the `catalog_*` tools reach the database with `docker exec` on the P5 host, so for them the viewer must run on the P5 host.

## See also

[Web viewer reference](../web-viewer.md) (options, secrets, change password, backups, uninstall, troubleshooting) | [Index search setup](index-search-setup.md) | [D2D2T packs](d2d2t-packs.md)
