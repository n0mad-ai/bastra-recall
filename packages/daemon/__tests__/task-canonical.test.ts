import {test} from "node:test";
import assert from "node:assert/strict";
import {canonicalTaskValue} from "../src/task-canonical.js";
test("task canonical JSON is deeply order-independent, distinguishes values and preserves array order",()=>{
 const a={decision:{revision:"v1",option:"A"},challenge:{nonce:"n",domain:"personal"},scope:{name:"fixture",kind:"personal"}};
 const b={scope:{kind:"personal",name:"fixture"},challenge:{domain:"personal",nonce:"n"},decision:{option:"A",revision:"v1"}};
 assert.equal(canonicalTaskValue(a),canonicalTaskValue(b));assert.notEqual(canonicalTaskValue(a),canonicalTaskValue({...b,decision:{...b.decision,option:"B"}}));
 assert.notEqual(canonicalTaskValue(["a","b"]),canonicalTaskValue(["b","a"]));assert.equal(canonicalTaskValue({optional:undefined,id:"x"}),canonicalTaskValue({id:"x"}));
});
