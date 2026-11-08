# Changelog

## 0.2.0

- Three deployment modes, set with the config key `mode`: `docker` (P5 in a container on an ssh host, the previous behaviour), `ssh` (P5 installed natively on an ssh host) and `local` (P5 on the machine running the tool). All tools work in each mode; `container_*` tools report "not applicable" outside docker mode.
- New `archiware setup`: checks prerequisites, detects the tape changer, writes the config, creates the REST password file (mode 600, hidden prompt, never argv), registers the MCP server with Claude Code. Idempotent; usable non-interactively through flags.
- New `archiware doctor`: configuration and connectivity report with a fix hint per line, non-zero exit on fail. `health` keeps working.
- New `archiware update [--check]` and `archiware version`. Distribution is the GitHub Release tarball only (no npm registry); `package.json` is `private`.
- Claude Code setup skill (`skills/setup`) and plugin manifest.
- No site-specific defaults any more: host, container, container IP, compose dir and backup dir are required keys that setup fills in.
- Tests are no longer shipped in the repository.
- README rewritten; LICENSE added; not affiliated with Archiware GmbH.

## 0.1.0

- Initial version: MCP server and CLI for Archiware P5 over ssh + docker exec: REST-first status, jobs, plans, volumes, restore, tape operations, container backup/update.
