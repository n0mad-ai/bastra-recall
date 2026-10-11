/** Package tests have one URL-derived root, matching the root-suite fixtures. */
import {spawn} from "node:child_process";
import {readdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {join} from "node:path";
import {once} from "node:events";
const root=fileURLToPath(new URL("../../../",import.meta.url)),dir=join(root,"packages","daemon","__tests__");
const files=(await readdir(dir)).filter(n=>n.endsWith(".test.ts")).sort().map(n=>join(dir,n));
const child=spawn(process.execPath,["--import","tsx","--import",join(root,"scripts","test-env.mjs"),"--test",...process.argv.slice(2),...files],{cwd:root,env:process.env,stdio:"inherit"});
const [code,signal]=await once(child,"exit");if(signal)process.kill(process.pid,signal);else process.exitCode=code??1;
