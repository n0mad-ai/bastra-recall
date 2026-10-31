import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const README_RELEASE_LINE = /^\*\*Version (\S+) (is available|ist verfügbar)\.\*\*/gm;
export const README_RELEASE_TARGET_LINE = /^\*\*(Release target|Release-Ziel): (\S+)\.\*\*/gm;
export const isPrereleaseVersion = version => version.split("+")[0].includes("-");

/** Release prose must identify the same version as the packages. */
export function checkReleaseDocs(root, version) {
  if (isPrereleaseVersion(version)) return;
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  for (const phrase of ["is available", "ist verfügbar"]) {
    const lines = [
      ...[...readme.matchAll(README_RELEASE_LINE)].filter(match => match[2] === phrase).map(match => match[1]),
      ...[...readme.matchAll(README_RELEASE_TARGET_LINE)].filter(match => match[1] === (phrase === "is available" ? "Release target" : "Release-Ziel")).map(match => match[2]),
    ];
    if (lines.length !== 1 || lines[0] !== version) {
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
