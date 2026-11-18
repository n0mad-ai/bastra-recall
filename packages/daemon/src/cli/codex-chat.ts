import { findCodexExecutable } from "./codex-cli.js";
import { startCodexChatBridge } from "../codex-chat-bridge.js";
import { registerCodexChat, closeCodexChat } from "../task-chat-registry.js";
import { showHelp } from "./help-text.js";
import { taskCliLanguage } from "./task-cli-words.js";

/** The words `bastra codex` prints by language.primary (#1602), English when
 *  unset or unlisted. Text the product writes — never matched against user text. */
export const CODEX_CHAT_WORDS = {
  en: { notInstalled: "Codex CLI is not installed. Install it, then start your chat with bastra codex.\n" },
  de: {
    notInstalled:
      "Die Codex-CLI ist nicht installiert. Installiere sie und starte deinen Chat dann mit bastra codex.\n",
  },
};
export const codexChatWordsIn = (language: string | undefined) =>
  CODEX_CHAT_WORDS[(language ?? "en") as keyof typeof CODEX_CHAT_WORDS] ?? CODEX_CHAT_WORDS.en;

/** Arguments belong to Codex; Bastra never rewrites its user configuration. */
export async function cmdCodexChat(args: string[], findBinary = findCodexExecutable): Promise<number> {
  const separator = args.indexOf("--"),
    options = separator < 0 ? args : args.slice(0, separator);
  if (options.includes("--help") || options.includes("-h")) {
    await showHelp("codex");
    return 0;
  }
  const binary = findBinary();
  if (!binary) {
    process.stderr.write(codexChatWordsIn(await taskCliLanguage().catch(() => "en")).notInstalled);
    return 1;
  }
  return startCodexChatBridge({
    binary,
    args: args[0] === "--" ? args.slice(1) : args,
    onRegister: (session) => registerCodexChat(session),
    onClose: (sessionId, generation) => closeCodexChat({ sessionId, generation }),
  });
}
