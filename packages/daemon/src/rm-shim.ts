#!/usr/bin/env node
/** Entry of the archiving `rm` (shims/rm → here). The logic is in rm-archive.ts. */
import { runRmShim } from "./rm-archive.js";

process.exitCode = runRmShim(process.argv.slice(2));
