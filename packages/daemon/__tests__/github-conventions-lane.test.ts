import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createServer} from "node:http";
import {githubWriteActions} from "../src/bash-pre-analysis.js";
import {runBashPreLane} from "../src/bash-pre-lane.js";
test("#1330: GitHub command recognition respects executable heads and shell quoting",async()=>{
 for(const command of ["gh issue create --body 'fixture'","gh pr edit 42 --title fixture","cd /tmp && GH_HOST=example.test gh -R owner/repo issue edit 42 --title x","env GH_HOST=example.test /usr/bin/gh pr create --body-file /tmp/body",'"gh" issue create --title x'])assert.equal((await githubWriteActions(command)).length,1,command);
 for(const command of ["gh issue list","gh issue view 42","gh pr view 42","gh issue create --help","command -v gh issue create","echo 'gh issue create'","rg 'gh pr create' docs","cat <<'EOF'\ngh issue create\nEOF"] )assert.deepEqual(await githubWriteActions(command),[],command);
});
test("#1330: unavailable retrieval and nonpersistent state fail open",async t=>{
 const root=await mkdtemp(join(tmpdir(),"github-conventions-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const saved=process.env.BASTRA_HOOK_STATE_DIR; t.after(()=>{if(saved===undefined)delete process.env.BASTRA_HOOK_STATE_DIR;else process.env.BASTRA_HOOK_STATE_DIR=saved;});
 let unavailable=true;const server=createServer(async(q,r)=>{q.resume();if(unavailable){r.writeHead(503);r.end("unavailable");return;}r.end(JSON.stringify({hits:[{id:"invented-issue-rule",title:"Invented convention",type:"workflow",scope:"all-projects",summary:"Milestone, labels and bilingual body",score:150,matched_recall_when:true,anchor_strength:"strong"}],score_kind:"rrf"}));});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));const base=`http://127.0.0.1:${(server.address()as {port:number}).port}`;
 const payload={session_id:"github-fail-open",hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"gh issue create --title fixture"}};
 assert.equal(await runBashPreLane(payload,base),"{}");
 unavailable=false;const impossible=join(root,"not-a-directory");await writeFile(impossible,"fixture");process.env.BASTRA_HOOK_STATE_DIR=join(impossible,"state");assert.equal(await runBashPreLane(payload,base),"{}");
});

test("#1330 review: executable multiline bodies, expansions, compounds and wrappers are recognized",async()=>{
 const cases=[
  'gh pr create --body "$(cat <<\'EOF\'\nbody with $5 and `literal`\nEOF\n)"',
  "gh issue create --body-file - <<'EOF'\nfixture\nEOF",
  "cat > f <<'EOF'\nfixture\nEOF\ngh issue create -F f",
  "cat > f <<'EOF' && gh issue create -F f\nfixture\nEOF",
  'gh issue create --body "costs $5 and `printf fixture`"',
  "if true; then gh issue create --title fixture; fi", "for x in 1; do gh pr edit 42 --title fixture; done", "{ gh issue create --title fixture; }", "! gh issue create --title fixture",
  'out=$(gh issue create --title fixture)', "bash -c 'gh issue create --title fixture'", "sudo -u fixture gh issue create --title fixture", "time gh issue create --title fixture", "nice -n 15 gh pr create --title fixture", "printf x | xargs gh issue create --title fixture",
  "gh issue create --body '--help'", "gh issue comment 42 --body fixture", "gh pr review 42 --approve", 'echo "$(gh issue create --title fixture)"', "bash <<'EOF'\ngh issue create --title fixture\nEOF", "gh pr edit 42 --title '-h'", "gh api repos/fixture/repo/issues -X POST -f title=fixture", "gh api --method POST repos/fixture/repo/pulls -f title=fixture",
 ];
 for(const command of cases)assert.ok((await githubWriteActions(command)).length>0,command);
 for(const command of ["echo 'gh issue create'", "grep 'gh pr create' file", "git commit -m 'gh issue create'", 'git commit -m "$(cat <<\'EOF\'\ngh issue create\nEOF\n)"', "cat <<'EOF'\ngh issue create\nEOF", "gh issue create --help", "gh api repos/fixture/repo/issues -X GET", "echo '$(gh issue create)'", "gh issue view 42 --json body --jq '.body'"] )assert.deepEqual(await githubWriteActions(command),[],command);
});
