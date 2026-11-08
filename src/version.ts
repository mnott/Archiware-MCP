import { readFileSync } from "node:fs";

/** Package version, read from package.json next to dist/. */
export const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
  } catch {
    return "unknown";
  }
})();
