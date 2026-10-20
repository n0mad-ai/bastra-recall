/** Validate repository-controlled V8 JSON before the fold iterates it. */
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

export interface RawScript {
  url?: string;
  functions?: Array<{ functionName?: string; ranges?: Array<{ count?: number }> }>;
}

/** Resolve compiled files through regular, bounded, nonblocking source maps. */
export function sourceResolver(repoRoot: string): (abs: string) => string {
  const cache = new Map<string, string>();
  return (abs) => {
    if (!/\.(js|mjs|cjs)$/.test(abs)) return abs;
    const hit = cache.get(abs);
    if (hit !== undefined) return hit;
    let out = abs;
    try {
      const mapPath = `${abs}.map`;
      const fd = openSync(mapPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      let text: string;
      try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.size > 16 * 1024 * 1024) return abs;
        text = readFileSync(fd, "utf8");
      } finally { closeSync(fd); }
      const m = JSON.parse(text) as { sources?: string[]; sourceRoot?: string };
      const src = (m.sources ?? [])
        .map((s) => resolve(dirname(mapPath), m.sourceRoot ?? "", s))
        .find((s) => !relative(repoRoot, s).startsWith(".."));
      if (src !== undefined) out = src;
    } catch {
      /* no map, or not one we can read: the .js path stands */
    }
    cache.set(abs, out);
    return out;
  };
}

