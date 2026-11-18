/**
 * `bastra token` — print the daemon's REST API token, minting one on first use.
 *
 * Browser / REST clients (e.g. the bastra.io web app reaching the local daemon
 * over the Browser-Bridge) authenticate with this as a `Bearer` token. Together
 * with the Origin-gate + CORS-allowlist in http.ts it's what lets a hosted site
 * talk to 127.0.0.1 safely: a stray website can't guess the token and isn't on
 * the allowlist. `bastra token rotate` issues a fresh token (the old one stops
 * working); `bastra token clear` removes it entirely (browser/REST clients are
 * locked out). The daemon reads the token at startup, so restart it after
 * issuing, rotating, or clearing — the next recall respawns it.
 *
 * stdout = the bare token (script-friendly); stderr = the human hint.
 */
import { ensureApiToken, clearApiToken, addCorsOrigin, normalizeCorsOrigin } from "../settings.js";
import { tokenWords } from "./token-words.js";

export async function cmdToken(args: { sub: string | null; json: boolean; origin?: string | null }): Promise<number> {
  const w = await tokenWords();
  if (args.sub && args.sub !== "rotate" && args.sub !== "show" && args.sub !== "clear") {
    process.stderr.write(w.unknownSub(args.sub));
    return 2;
  }

  if (args.sub === "clear") {
    const cleared = await clearApiToken();
    if (args.json) {
      process.stdout.write(JSON.stringify({ cleared }) + "\n");
      return 0;
    }
    if (cleared) {
      process.stdout.write(w.cleared);
      process.stderr.write(w.restartToDrop);
    } else {
      process.stdout.write(w.noneSet);
    }
    return 0;
  }

  const rotate = args.sub === "rotate";
  const token = await ensureApiToken({ rotate });

  // Optional one-step onboarding: also allowlist the browser Origin so the web
  // app can reach the daemon without hand-editing the launchd plist / env.
  // addCorsOrigin validates + warns on stderr when the value isn't a real
  // origin; allowedOrigin is the normalized form (null when invalid/absent).
  let allowedOrigin: string | null = null;
  if (args.origin != null) {
    await addCorsOrigin(args.origin);
    allowedOrigin = normalizeCorsOrigin(args.origin);
  }

  if (args.json) {
    process.stdout.write(
      JSON.stringify({ token, rotated: rotate, ...(args.origin != null ? { origin: allowedOrigin } : {}) }) + "\n"
    );
    return 0;
  }
  process.stdout.write(token + "\n");
  process.stderr.write((rotate ? w.rotated : "") + (allowedOrigin ? w.allowedOrigin(allowedOrigin) : "") + w.paste);
  return 0;
}
