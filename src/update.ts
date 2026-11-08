/**
 * archiware update [--check] — update to the latest GitHub Release.
 * Distribution is the release tarball only (no npm registry): this fetches the
 * latest release tag from the GitHub API and re-runs the install line.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { VERSION } from "./version.js";

function repoSlug(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const url: string = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url ?? "";
    const m = url.match(/github\.com[/:]([^/]+\/[^/.]+)/);
    return m && !m[1].startsWith("OWNER/") ? m[1] : null;
  } catch {
    return null;
  }
}

/** True when a is a newer x.y.z than b. */
export function isNewer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

export async function runUpdate(checkOnly: boolean): Promise<number> {
  const slug = repoSlug();
  if (!slug) {
    console.error('package.json "repository" does not name a GitHub repo yet; re-run the install line from the README instead.');
    return 1;
  }
  let latest: string;
  try {
    const res = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": "archiware-mcp" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    latest = String(((await res.json()) as { tag_name?: string }).tag_name ?? "");
  } catch (e) {
    console.error(`cannot read the latest release of ${slug}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  console.log(`installed ${VERSION}, latest ${latest.replace(/^v/, "")}`);
  if (!isNewer(latest, VERSION)) {
    console.log("up to date");
    return 0;
  }
  if (checkOnly) {
    console.log("update available (run `archiware update`)");
    return 0;
  }
  const url = `https://github.com/${slug}/releases/latest/download/archiware-mcp.tgz`;
  console.log(`npm i -g ${url}`);
  return new Promise((resolve) => {
    execFile("npm", ["i", "-g", url], (e, out, err) => {
      process.stdout.write(out);
      process.stderr.write(err);
      resolve(e ? 1 : 0);
    });
  });
}
