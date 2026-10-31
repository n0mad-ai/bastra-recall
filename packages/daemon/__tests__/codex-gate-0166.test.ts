import test from 'node:test';
import assert from 'node:assert/strict';
import {codexGateSupported} from '../src/codex-gate-capability.js';
import {hookGateAvailable} from '../src/hook-surface.js';
import {hostCapabilities} from '../src/host-capabilities.js';
import {planCodexHooks,codexGateRegistered} from '../src/cli/adapters/codex.js';

test('0.166.0 is separately certified without opening a version range',()=>{
 for(const version of ['0.162.1','0.166.0']){
  assert.equal(codexGateSupported(version),true,version);
  assert.equal(hookGateAvailable({bastra_client:'codex',bastra_codex_version:version}),true);
  const hooks=planCodexHooks('install',{}, {includeStop:true,stubPresent:false,codexVersion:version}).after;
  assert.equal(codexGateRegistered(hooks,version),true);
 }
 for(const version of ['0.162.2','0.165.0','0.166.0-alpha.1','0.166.1','0.167.0','unknown',''])assert.equal(codexGateSupported(version),false,version);
});
test('0.166.0 evidence covers denial and Stop but does not certify fork or universal tool denial',()=>{
 const row=hostCapabilities('codex','0.166.0');
 assert.equal(row.runtime.verifiedVersion,'0.166.0');
 assert.equal(row.runtime.minimumVersion,'0.162.1');
 assert.equal(row.capabilities.pre_tool_deny.status,'supported');
 assert.equal(row.capabilities.stop_block.status,'supported');
 assert.equal(row.capabilities.session_fork.status,'unverified');
 assert.deepEqual(row.pre_tool_coverage.runtimeVerified,['exec_command (hook name Bash)','view_image']);
 assert.ok(row.pre_tool_coverage.documentedOnly.some(x=>x.includes('MCP')));
 assert.equal(hostCapabilities('codex','0.162.1').capabilities.session_fork.status,'supported');
});
