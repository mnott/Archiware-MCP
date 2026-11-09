/**
 * p5_dr_kit: the small pieces needed to rebuild a lost P5 server (docker mode).
 *
 * Besides tapes a rebuild needs: the P5 program version (the mounted program
 * tree), the container image, the compose project (it pins hostname, MAC and
 * IP; the P5 license host id derives from that IP), the configuration
 * databases (pools/volumes/plans and the ENCRYPTED cloud credentials) and the
 * key files next to them. The big indexes are NOT part of the kit (see
 * p5_config_backup). Every step is a host command built by a pure function.
 *
 * Layout under <backupDir>/p5-dr-kit (or drKitDir):
 *   <stamp>/config-small  compose  manifest.json  kit-small.tar.gz  SHA256SUMS  VERIFIED   (7 generations)
 *   image/<id12>.tar.gz + .json + LAST      (only when the image id changed; last 2)
 *   program/<version>.tar.gz + LAST         (only when the P5 version changed; last 2)
 */

import type { ArchiwareConfig } from "./config.js";
import { configDir } from "./p5db.js";
import { notApplicable } from "./containerops.js";
import { listCopyState, retentionScript, staleWarning, timeStamp, type CopyInfo } from "./configbackup.js";
import { hostCommand, nsdchat, P5Error, shellQuote } from "./transport.js";

export const DR_KEEP = 7;
export const DR_IMAGE_KEEP = 2;
export const DR_WARN_MB = 50;
export const DR_MAX_MB = 500;
const RUN_MS = 2 * 3600_000;
const sh = (script: string): string[] => ["sh", "-c", script];

export const drKitRoot = (cfg: Pick<ArchiwareConfig, "backupDir"> & { drKitDir?: string }) => cfg.drKitDir || `${cfg.backupDir}/p5-dr-kit`;
/** P5 program tree on the host: the folder that holds config/ (the mounted <aw> dir). */
export const programDir = (cfg: ArchiwareConfig) => {
  const c = configDir(cfg);
  return c.slice(0, c.lastIndexOf("/")) || "/";
};

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

const EXCLUDED = ["index", "joblog", "ltfsindex"];
/** Program tree parts that are not program: config (covered by config-small / p5_config_backup), logs, temp. */
const PROGRAM_EXCLUDE = ["config", "log", "logs", "temp"];
const TRANSIENT = ["*.lock", "*.tmp", "*-wal", "*-shm", "*-journal"];

/** `S|F <bytes> <relative path>` for every file of the config tree outside index/, joblog/, ltfsindex/ (S = SQLite by header). */
export function discoverArgv(src: string): string[] {
  const prune = EXCLUDED.map((d) => `-path ${shellQuote(`${src}/${d}`)}`).join(" -o ");
  return sh(
    `find ${shellQuote(src)} \\( ${prune} \\) -prune -o -type f -print | while IFS= read -r f; do if [ "$(head -c 15 "$f" 2>/dev/null)" = "SQLite format 3" ]; then k=S; else k=F; fi; echo "$k $(stat -c %s "$f") \${f#${src}/}"; done`,
  );
}

export interface DrFile {
  kind: "S" | "F";
  bytes: number;
  path: string;
}

export function parseDiscovery(out: string): DrFile[] {
  return out
    .split("\n")
    .map((l) => l.match(/^([SF]) (\d+) (.+)$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .filter((m) => !TRANSIENT.some((p) => new RegExp(`^${p.replace(/[.]/g, "\\.").replace(/\*/g, ".*")}$`).test(m[3])))
    .map((m) => ({ kind: m[1] as "S" | "F", bytes: Number(m[2]), path: m[3] }));
}

export type SizeVerdict = "ok" | "large" | "refuse";
export function sizeVerdict(totalBytes: number): SizeVerdict {
  const mb = totalBytes / 1048576;
  return mb > DR_MAX_MB ? "refuse" : mb > DR_WARN_MB ? "large" : "ok";
}

/** Compose project files worth keeping, from a directory listing. */
export function composeFiles(listing: string): string[] {
  return listing
    .split("\n")
    .map((s) => s.trim())
    .filter((n) => /^(docker-compose|compose)[^/]*\.ya?ml$/.test(n) || /^Dockerfile/.test(n) || n === ".env" || /^(build|rebuild|run|start)[^/]*\.sh$/.test(n));
}

export interface ComposeIdentity {
  hostname: string | null;
  macAddress: string | null;
  ipv4Address: string | null;
}

/** Reads hostname / mac_address / ipv4_address from compose text (stays on the server, only in the manifest). */
export function parseCompose(text: string): ComposeIdentity {
  const pick = (key: string) => {
    const m = text.match(new RegExp(`^\\s*${key}\\s*:\\s*["']?([^"'#\\s]+)`, "m"));
    return m ? m[1] : null;
  };
  return { hostname: pick("hostname"), macAddress: pick("mac_address"), ipv4Address: pick("ipv4_address") };
}

export const imageIdArgv = (container: string) => ["docker", "inspect", "-f", "{{.Image}}|{{.Config.Image}}", container];
export const imageMetaArgv = (id: string) => ["docker", "image", "inspect", "-f", "{{.Created}}|{{.Size}}", id];

export function parseImage(out: string): { id: string; name: string } | null {
  const [id, name] = out.trim().split("|");
  return id && name ? { id, name } : null;
}

export const imageShort = (id: string) => id.replace(/^sha256:/, "").slice(0, 12);

/** True when a new save is needed: nothing saved yet, or the id/version differs from the last saved one. */
export const needsSave = (last: string | null, current: string | null): boolean => Boolean(current) && current !== (last ?? "").trim();

export const lastSavedArgv = (root: string) =>
  sh(`for k in image program; do printf '%s=' "$k"; cat ${shellQuote(root)}/$k/LAST 2>/dev/null | head -n 1; echo; done; true`);

export function parseLast(out: string): { image: string | null; program: string | null } {
  const g = (k: string) => out.split("\n").find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim() || null;
  return { image: g("image"), program: g("program") };
}

export function toolsArgv(): string[] {
  return sh("for t in sqlite3 flock ionice sha256sum gzip tar docker; do command -v $t >/dev/null 2>&1 && echo \"have $t\"; done; true");
}

export function sizesArgv(cfg: ArchiwareConfig, root: string): string[] {
  return sh(`du -sk ${PROGRAM_EXCLUDE.map((d) => `--exclude=${shellQuote(d)}`).join(" ")} ${shellQuote(programDir(cfg))} | cut -f1; df -Pk ${shellQuote(cfg.backupDir)} | tail -1 | awk '{print $4}'; ls -1 ${shellQuote(root)} 2>/dev/null | wc -l`);
}

// ---------------------------------------------------------------------------
// generation script (config-small + compose + kit-small)
// ---------------------------------------------------------------------------

export interface ManifestInput {
  p5Version: string;
  image: { name: string; id: string; created: string } | null;
  identity: ComposeIdentity;
  composeFiles: string[];
}

const jstr = (s: string | null) => (s === null ? "null" : JSON.stringify(s));

export function manifestHead(m: ManifestInput, stamp: string): string {
  return (
    `{"stamp":${jstr(stamp)},"p5Version":${jstr(m.p5Version)},` +
    `"image":${m.image ? `{"name":${jstr(m.image.name)},"id":${jstr(m.image.id)},"created":${jstr(m.image.created)}}` : "null"},` +
    `"compose":{"hostname":${jstr(m.identity.hostname)},"macAddress":${jstr(m.identity.macAddress)},"ipv4Address":${jstr(m.identity.ipv4Address)},"files":${JSON.stringify(m.composeFiles)}},`
  );
}

export function genScript(o: { src: string; composeDir: string; root: string; stamp: string; head: string; composeFiles: string[]; maxMb: number }): string {
  const v = (k: string, x: string) => `${k}=${shellQuote(x)}`;
  const prune = EXCLUDED.map((d) => `-path "$SRC/${d}"`).join(" -o ");
  return [
    "set -u",
    v("SRC", o.src),
    v("CDIR", o.composeDir),
    v("ROOT", o.root),
    v("STAMP", o.stamp),
    v("HEAD", o.head),
    `KEEP=${DR_KEEP}`,
    `MAXKB=${o.maxMb * 1024}`,
    'D="$ROOT/$STAMP"; T0=$(date +%s)',
    'fail() { echo "p5_dr_kit FAILED: $1" >&2; touch "$D/FAILED"; exit 1; }',
    'mkdir -p "$D/config-small/db" "$D/config-small/files" "$D/compose" || exit 1',
    `find "$SRC" \\( ${prune} \\) -prune -o -type f -print | while IFS= read -r f; do if [ "$(head -c 15 "$f" 2>/dev/null)" = "SQLite format 3" ]; then echo "S \${f#$SRC/}"; else echo "F \${f#$SRC/}"; fi; done > "$D/list.txt"`,
    "grep '^F ' \"$D/list.txt\" | cut -c3- | grep -Ev '\\.(lock|tmp)$|-(wal|shm|journal)$' > \"$D/files.txt\"",
    `TOT=$(cd "$SRC" && xargs -d '\\n' -r du -k < "$D/files.txt" 2>/dev/null | awk '{s+=$1} END {print s+0}')`,
    '[ "$TOT" -le "$MAXKB" ] || fail "config files outside index/joblog/ltfsindex are $((TOT/1024)) MB (limit $((MAXKB/1024)) MB): something big slipped in"',
    ': > "$D/dbs.tsv"; BAD=0',
    'grep "^S " "$D/list.txt" | cut -c3- > "$D/dblist.txt"',
    'while IFS= read -r rel; do',
    '  mkdir -p "$D/config-small/db/$(dirname "$rel")"',
    '  sqlite3 -cmd ".timeout 60000" "$SRC/$rel" ".backup \\"$D/config-small/db/$rel\\"" || fail "backup of $rel"',
    '  r=$(sqlite3 "$D/config-small/db/$rel" "PRAGMA integrity_check;" | head -n 1)',
    '  [ "$r" = "ok" ] || BAD=1',
    '  printf "%s\\t%s\\t%s\\n" "$rel" "$(stat -c %s "$D/config-small/db/$rel")" "$r" >> "$D/dbs.tsv"',
    'done < "$D/dblist.txt"',
    '[ "$(du -sk "$D/config-small/db" | cut -f1)" -le "$MAXKB" ] || fail "database copies exceed the size limit"',
    '[ "$BAD" = 0 ] || fail "integrity_check not ok on a copy (see dbs.tsv)"',
    'if [ -s "$D/files.txt" ]; then tar -C "$SRC" -cf - -T "$D/files.txt" | tar -C "$D/config-small/files" -xf - || fail "copy of config files"; fi',
    `for f in ${o.composeFiles.map(shellQuote).join(" ")}; do cp -p "$CDIR/$f" "$D/compose/" || fail "copy compose file $f"; done`,
    'DUR=$(( $(date +%s) - T0 ))',
    'printf "%s" "$HEAD" > "$D/manifest.json"',
    'printf \'"durationSeconds":%s,"databases":[\' "$DUR" >> "$D/manifest.json"',
    'awk -F"\\t" \'{printf "%s{\\"path\\":\\"%s\\",\\"bytes\\":%s,\\"integrity\\":\\"%s\\"}", (NR>1?",":""), $1,$2,$3}\' "$D/dbs.tsv" >> "$D/manifest.json"',
    'printf \'],"configFiles":[\' >> "$D/manifest.json"',
    'awk \'{printf "%s\\"%s\\"", (NR>1?",":""), $0}\' "$D/files.txt" >> "$D/manifest.json"',
    'printf "]}\\n" >> "$D/manifest.json"',
    'rm -f "$D/list.txt" "$D/dblist.txt" "$D/dbs.tsv" "$D/files.txt"',
    'tar -C "$D" -czf "$D/kit-small.tar.gz" config-small compose manifest.json || fail "kit-small"',
    '( cd "$D" && find . -type f ! -name SHA256SUMS ! -name VERIFIED ! -name FAILED -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS && sha256sum -c --quiet SHA256SUMS ) || fail "SHA256SUMS verify"',
    'date +%s > "$D/VERIFIED"',
    retentionScript(),
    'echo "OK $D $DUR $(stat -c %s "$D/kit-small.tar.gz") $(sha256sum "$D/kit-small.tar.gz" | cut -d" " -f1)"',
  ].join("\n");
}

export function runArgv(root: string, script: string): string[] {
  return sh(`mkdir -p ${shellQuote(root)} && exec flock -n -E 75 ${shellQuote(`${root}/.lock`)} nice -n 19 ionice -c3 sh -c ${shellQuote(script)}`);
}

// ---------------------------------------------------------------------------
// image and program (only when changed)
// ---------------------------------------------------------------------------

export function imageScript(o: { root: string; ref: string; id: string; meta: string }): string {
  const d = `${o.root}/image`;
  const f = `${d}/${imageShort(o.id)}.tar.gz`;
  return [
    "set -eu",
    `mkdir -p ${shellQuote(d)}`,
    `docker save ${shellQuote(o.ref)} | gzip > ${shellQuote(f + ".part")}`,
    `mv ${shellQuote(f + ".part")} ${shellQuote(f)}`,
    `printf '%s\\n' ${shellQuote(o.meta)} > ${shellQuote(f.replace(/\.tar\.gz$/, ".json"))}`,
    `( cd ${shellQuote(d)} && sha256sum ${shellQuote(imageShort(o.id) + ".tar.gz")} > ${shellQuote(imageShort(o.id) + ".sha256")} )`,
    `printf '%s\\n' ${shellQuote(o.id)} > ${shellQuote(d + "/LAST")}`,
    pruneByAge(d, "*.tar.gz", DR_IMAGE_KEEP),
    `echo "OK ${f} $(stat -c %s ${shellQuote(f)})"`,
  ].join("\n");
}

export function programScript(o: { root: string; dir: string; version: string }): string {
  const d = `${o.root}/program`;
  const safe = o.version.replace(/[^A-Za-z0-9._-]/g, "_");
  const f = `${d}/p5-${safe}.tar.gz`;
  const parent = o.dir.slice(0, o.dir.lastIndexOf("/")) || "/";
  const base = o.dir.slice(o.dir.lastIndexOf("/") + 1);
  return [
    "set -eu",
    `mkdir -p ${shellQuote(d)}`,
    `tar -C ${shellQuote(parent)} ${PROGRAM_EXCLUDE.map((d) => `--exclude=${shellQuote(`${base}/${d}`)}`).join(" ")} -czf ${shellQuote(f + ".part")} ${shellQuote(base)}`,
    `mv ${shellQuote(f + ".part")} ${shellQuote(f)}`,
    `( cd ${shellQuote(d)} && sha256sum ${shellQuote(`p5-${safe}.tar.gz`)} > ${shellQuote(`p5-${safe}.sha256`)} )`,
    `printf '%s\\n' ${shellQuote(o.version)} > ${shellQuote(d + "/LAST")}`,
    pruneByAge(d, "*.tar.gz", DR_IMAGE_KEEP),
    `echo "OK ${f} $(stat -c %s ${shellQuote(f)})"`,
  ].join("\n");
}

/** Keep the newest N archives of a folder; remove older ones with their .json/.sha256 companions. */
function pruneByAge(dir: string, glob: string, keep: number): string {
  return `ls -1t ${shellQuote(dir)}/${glob} | tail -n +${keep + 1} | while IFS= read -r x; do rm -f "$x" "\${x%.tar.gz}.json" "\${x%.tar.gz}.sha256"; done`;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export async function drKitCopies(cfg: ArchiwareConfig): Promise<CopyInfo[]> {
  if (!cfg.backupDir || cfg.mode !== "docker") return [];
  return listCopyState(cfg, drKitRoot(cfg));
}

export function drStaleWarning(copies: CopyInfo[], nowMs: number): string | null {
  const w = staleWarning(copies, nowMs);
  return w ? w.replace("P5 config copy", "P5 DR kit").replace("p5_config_backup", "p5_dr_kit") : null;
}

async function srvVersion(cfg: ArchiwareConfig): Promise<string> {
  try {
    return (await nsdchat(cfg, ["srvinfo", "lexxvers"], 15_000)).trim() || "?";
  } catch {
    return "?";
  }
}

const mb = (b: number) => Math.round(b / 1048576);

export async function p5DrKit(cfg: ArchiwareConfig, opts: { confirm: boolean; status?: boolean }) {
  if (cfg.mode !== "docker") return { ...notApplicable(cfg), note: `p5_dr_kit only applies in docker mode; this config uses mode "${cfg.mode}".` };
  if (!cfg.backupDir) throw new P5Error("backupDir is not configured (needed as the destination root)");
  if (!cfg.composeDir) throw new P5Error("composeDir is not configured");
  const root = drKitRoot(cfg);
  const now = Date.now();
  const last = parseLast((await hostCommand(cfg, lastSavedArgv(root), 20_000)).stdout);
  if (opts.status) {
    const copies = await drKitCopies(cfg);
    return {
      confirmationRequired: false as const,
      root,
      copies: copies.map((c) => ({ name: c.name, age: `${Math.round((now - c.at) / 3600_000)} h`, sizeMB: Math.round(c.kb / 1024), state: c.state })),
      lastSavedImage: last.image,
      lastSavedProgramVersion: last.program,
      warning: drStaleWarning(copies, now),
    };
  }
  const tools = (await hostCommand(cfg, toolsArgv(), 20_000)).stdout;
  for (const t of ["sqlite3", "flock", "ionice", "sha256sum", "gzip", "tar", "docker"]) if (!tools.includes(`have ${t}`)) throw new P5Error(`${t} is not installed on the P5 host`);
  const src = configDir(cfg);
  const files = parseDiscovery((await hostCommand(cfg, discoverArgv(src), 300_000)).stdout);
  const smallBytes = files.reduce((s, f) => s + f.bytes, 0);
  const verdict = sizeVerdict(smallBytes);
  if (verdict === "refuse") {
    const big = [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 5).map((f) => `${f.path} ${mb(f.bytes)} MB`);
    throw new P5Error(`config tree outside index/joblog/ltfsindex is ${mb(smallBytes)} MB (limit ${DR_MAX_MB} MB): something big slipped in; largest: ${big.join(", ")}`);
  }
  const ls = (await hostCommand(cfg, ["ls", "-1", "-A", cfg.composeDir], 20_000)).stdout;
  const cfiles = composeFiles(ls);
  const mainCompose = cfiles.find((n) => /\.ya?ml$/.test(n));
  if (!mainCompose) throw new P5Error(`no compose file found in composeDir (${cfg.composeDir})`);
  const identity = parseCompose((await hostCommand(cfg, ["cat", `${cfg.composeDir}/${mainCompose}`], 20_000)).stdout);
  const img = parseImage((await hostCommand(cfg, imageIdArgv(cfg.container), 20_000)).stdout);
  if (!img) throw new P5Error(`docker inspect ${cfg.container} gave no image`);
  const meta = (await hostCommand(cfg, imageMetaArgv(img.id), 20_000)).stdout.trim().split("|");
  const created = meta[0] ?? "?";
  const imageBytes = Number(meta[1]) || 0;
  const version = await srvVersion(cfg);
  const takeImage = needsSave(last.image, img.id);
  const takeProgram = version !== "?" && needsSave(last.program, version);
  const [programKb, freeKb] = (await hostCommand(cfg, sizesArgv(cfg, root), 300_000)).stdout.trim().split("\n").map(Number);
  const stamp = timeStamp();
  if (!opts.confirm) {
    return {
      confirmationRequired: true as const,
      plan: [
        `config-small: ${files.filter((f) => f.kind === "S").length} SQLite database(s) via sqlite3 .backup + integrity_check, ${files.filter((f) => f.kind === "F").length} plain config file(s); index/, joblog/, ltfsindex/ excluded`,
        `compose: ${cfiles.join(", ")} from composeDir`,
        takeImage ? `image: docker save ${img.name} | gzip (id ${imageShort(img.id)} differs from last saved ${last.image ? imageShort(last.image) : "none"})` : `image: skipped, id ${imageShort(img.id)} already saved`,
        version === "?" ? "program: skipped, P5 version unknown (P5 not answering)" : takeProgram ? `program: tar of ${programDir(cfg)} without config/, logs, temp (version ${version} differs from last saved ${last.program ?? "none"})` : `program: skipped, version ${version} already saved`,
        "kit-small.tar.gz = config-small + compose + manifest; manifest.json, SHA256SUMS, VERIFIED",
        `keep ${DR_KEEP} generations, ${DR_IMAGE_KEEP} images, ${DR_IMAGE_KEEP} program trees; flock, nice, ionice`,
      ],
      destination: `${root}/${stamp}/`,
      p5Version: version,
      sizes: { configSmallMB: mb(smallBytes), imageMB: takeImage ? mb(imageBytes) : 0, programMB: takeProgram ? Math.round((programKb || 0) / 1024) : 0, freeSpaceMB: Number.isFinite(freeKb) ? Math.round(freeKb / 1024) : null },
      sizeNote: verdict === "large" ? `config-small is above ${DR_WARN_MB} MB, more than expected` : null,
      note: "Re-run with confirm:true (CLI --yes).",
    };
  }
  const head = manifestHead({ p5Version: version, image: { name: img.name, id: img.id, created }, identity, composeFiles: cfiles }, stamp);
  const script = genScript({ src, composeDir: cfg.composeDir, root, stamp, head, composeFiles: cfiles, maxMb: DR_MAX_MB });
  const r = await hostCommand(cfg, runArgv(root, script), RUN_MS);
  if (r.rc === 75) throw new P5Error("another p5_dr_kit is running (lock held)");
  if (r.rc !== 0) throw new P5Error(`p5_dr_kit failed (exit ${r.rc}); the failed generation is marked FAILED, older ones were kept`, r.stderr);
  const [, dir, , kitBytes, kitSha] = r.stdout.trim().split("\n").pop()!.split(" ");
  const out: Record<string, unknown> = { confirmationRequired: false as const, destination: dir, kitSmall: { file: `${dir}/kit-small.tar.gz`, bytes: Number(kitBytes), sha256: kitSha }, p5Version: version };
  if (takeImage) {
    const mj = JSON.stringify({ name: img.name, id: img.id, created, savedAs: img.name });
    const ir = await hostCommand(cfg, runArgv(root, imageScript({ root, ref: img.name, id: img.id, meta: mj })), RUN_MS);
    if (ir.rc !== 0) throw new P5Error(`image save failed (exit ${ir.rc}); kit-small is complete`, ir.stderr);
    out.image = ir.stdout.trim().split("\n").pop();
  } else out.image = "unchanged, not saved";
  if (takeProgram) {
    const pr = await hostCommand(cfg, runArgv(root, programScript({ root, dir: programDir(cfg), version })), RUN_MS);
    if (pr.rc !== 0) throw new P5Error(`program tree save failed (exit ${pr.rc}); kit-small is complete`, pr.stderr);
    out.program = pr.stdout.trim().split("\n").pop();
  } else out.program = version === "?" ? "skipped, version unknown" : "unchanged, not saved";
  return out;
}
