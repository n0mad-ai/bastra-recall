/** Run only at deploy on an explicitly selected draft store. */
import {resolve} from 'node:path';
import {rejectInjectedDrafts} from '../src/draft-store.js';
const path=process.argv[2];
if(!path)throw new Error('Usage: node --import tsx packages/daemon/scripts/reject-injected-drafts.ts /absolute/path/to/drafts.json');
process.env.BASTRA_DRAFTS_PATH=resolve(path);
console.log(JSON.stringify({rejected:await rejectInjectedDrafts(),store:resolve(path)}));
