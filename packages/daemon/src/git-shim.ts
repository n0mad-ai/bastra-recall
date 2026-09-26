#!/usr/bin/env node
/** Entry of bastra's git snapshots (shims/git → here). The logic is in git-archive.ts. */
import { runGitShim } from "./git-archive.js";

process.exitCode = runGitShim(process.argv.slice(2));
