/** Eval child network boundary: only its assigned loopback daemon port is allowed. */
import { Socket } from 'node:net';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const original = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  const a = Array.isArray(args[0]) ? args[0] : args;
  const first = a[0];
  const port = typeof first === 'object' && first !== null ? first.port : first;
  const host = typeof first === 'object' && first !== null ? first.host : typeof a[1] === 'string' ? a[1] : 'localhost';
  if (Number(port) === 6723 || Number(port) !== Number(process.env.BASTRA_HTTP_PORT) || !['localhost','127.0.0.1','::1'].includes(host ?? 'localhost')) {
    appendFileSync(join(process.env.BASTRA_MEASUREMENT_ROOT, 'blocked-network.jsonl'), JSON.stringify({ host, port })+'\n', { mode: 0o600 });
    queueMicrotask(() => this.destroy(Object.assign(new Error('measurement network boundary'), { code: 'ECONNREFUSED' })));
    return this;
  }
  return original.apply(this,args);
};
