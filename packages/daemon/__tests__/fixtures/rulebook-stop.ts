/** Rulebook requests continue the host in either supported wire format.
 * Copy-repair feedback is independent and must not count as a rulebook request. */
export function rulebookStopRequested(out: {decision?:string;hookSpecificOutput?:{hookEventName?:string;additionalContext?:string}}):boolean {
 return out.decision==='block'||(out.hookSpecificOutput?.hookEventName==='Stop'&&!!out.hookSpecificOutput.additionalContext?.includes('rulebook_check'));
}
