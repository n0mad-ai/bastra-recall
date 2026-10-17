/** Observe real daemon task data access and task timers, without production state. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const record = (kind, detail) => fs.appendFileSync(process.env.TASK_AUDIT, JSON.stringify({kind, detail})+'\n');
for (const api of [fs, fsp]) {
  for (const name of ['readFile','readFileSync','writeFile','writeFileSync','open','openSync','stat','statSync','lstat','lstatSync','readdir','readdirSync','mkdir','mkdirSync','rename','unlink','access','accessSync']) {
    const original = api[name]; if (!original) continue;
    api[name] = function(...args) {
      const path = String(args[0]);
      if (path === process.env.TASK_DATA_ROOT || path.startsWith(process.env.TASK_DATA_ROOT+'/')) record('fs:'+name,path);
      return Reflect.apply(original,this,args);
    };
  }
}
syncBuiltinESMExports();
for (const name of ['setTimeout','setInterval','setImmediate']) {
  const original = globalThis[name];
  globalThis[name] = function(...args) {
    const stack = new Error().stack;
    if (/task-runtime|task-delivery|startProactiveTaskJob/.test(stack)) record('timer:'+name,stack);
    return Reflect.apply(original,this,args);
  };
}
