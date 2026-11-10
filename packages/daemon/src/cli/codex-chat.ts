import { findCodexExecutable } from './codex-cli.js';
import { startCodexChatBridge } from '../codex-chat-bridge.js';
import { registerCodexChat, closeCodexChat } from '../task-chat-registry.js';
import { showHelp } from './help-text.js';

/** Arguments belong to Codex; Bastra never rewrites its user configuration. */
export async function cmdCodexChat(args:string[]):Promise<number> {
 const separator=args.indexOf('--'),options=separator<0?args:args.slice(0,separator);
 if(options.includes('--help')||options.includes('-h')){showHelp('codex');return 0;}
 const binary=findCodexExecutable();if(!binary){process.stderr.write('Codex CLI is not installed. Install it, then start your chat with bastra codex.\n');return 1;}
 return startCodexChatBridge({binary,args:args[0]==='--'?args.slice(1):args,
  onRegister:session=>registerCodexChat(session),onClose:(sessionId,generation)=>closeCodexChat({sessionId,generation})});
}
