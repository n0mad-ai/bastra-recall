import type { ParsedArgs } from './types.js';
import { rulebookCliCall } from './rulebook-proposals-cmd.js';
import { ReviewSaveSuggestionArgs } from '../save-suggestion-review.js';
/** Like rule confirmation, CLI user direction is an attestation by the agent. */
export async function cmdSaveSuggestions(args:ParsedArgs):Promise<number>{
 try {
  const [,decision,id,origin,evidence,...extra]=args.positional;
  if(extra.length)throw new Error('Unexpected arguments');
  const input=ReviewSaveSuggestionArgs.parse({id,decision,write_origin:origin,...(evidence?{evidence}:{})});
  const result=args.dryRun?{dry_run:true,tool:'review_save_suggestion',input}:await rulebookCliCall('review_save_suggestion',input);
  process.stdout.write(JSON.stringify(result,null,2)+'\n');return 0;
 }catch{process.stderr.write('usage: bastra suggestions reject <proposal_id> user-directed "explicit user rejection" | reset <proposal_id> user-directed\n');return 1;}
}
