import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Release prose must identify the same version as the packages. */
export function checkReleaseDocs(root, version) {
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  for (const phrase of ["is available", "ist verfügbar"]) {
    const lines = [...readme.matchAll(/^\*\*Version (\S+) (is available|ist verfügbar)\.\*\*/gm)]
      .filter(match => match[2] === phrase);
    if (lines.length !== 1 || lines[0][1] !== version) {
      throw new Error(`README ${phrase}: expected exactly one release line for ${version}`);
    }
  }
  const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
  const heading = `## [${version}]`;
  const hasSection = changelog.split("\n").some(line =>
    line.startsWith(heading) && /^(?:\s|$)/.test(line.slice(heading.length)));
  if (!hasSection) {
    throw new Error(`CHANGELOG is missing a section for ${version}`);
  }
}
