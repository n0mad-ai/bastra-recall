/**
 * Recall Pulse: the Android app (the WebView shell, repo bastra-recall-android)
 * may use /ui only with `ui.android_app` on. The web UI itself stays free in
 * any browser, locally and through the public address.
 *
 * The shell appends ANDROID_APP_MARKER to the WebView's user agent. This is a
 * product switch, not a security boundary: a user agent can be spoofed, and
 * whoever drops the marker just gets the free web UI. Nothing heavier
 * (fingerprinting and the like) on purpose.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "./http-util.js";
import { getPrimaryLanguage, getUiAndroidApp } from "./settings.js";
import { androidAppWordsIn, type AndroidAppWords } from "./ui-android-app-words.js";
import { isPageNavigation } from "./webui.js";

/** The user-agent token of the shell (WebViewSetup.kt): `BastraRecallShell/<versionName>`. */
const ANDROID_APP_MARKER = /\bBastraRecallShell\//;

const ANDROID_APP_ON_COMMAND = "bastra config set ui.android_app true";

/**
 * Answers a /ui request of the Android app while the switch is off: 403 with a
 * notice page for a page navigation, 403 `{"error":"pulse-required"}` for
 * everything else. true = answered here. Runs before any account, session or
 * data handling, so nothing about the vault or the account leaves.
 */
export async function refuseAndroidAppWithoutPulse(
  req: IncomingMessage,
  res: ServerResponse,
  method: string
): Promise<boolean> {
  if (!ANDROID_APP_MARKER.test(String(req.headers["user-agent"] ?? ""))) return false;
  if (await getUiAndroidApp()) return false;
  res.setHeader("Cache-Control", "no-store");
  if (!isPageNavigation(req, method)) {
    sendJson(res, 403, { error: "pulse-required" });
    return true;
  }
  const html = noticePage(androidAppWordsIn(await getPrimaryLanguage()));
  res.writeHead(403, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  });
  res.end(html);
  return true;
}

/** Self-contained: no script, no asset, nothing from the vault. */
function noticePage(w: AndroidAppWords): string {
  return `<!doctype html>
<html lang="${w.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${w.title}</title>
<style>
body{margin:0;padding:24px 16px;font:16px/1.5 system-ui,sans-serif;background:#f6f6f4;color:#1c1c1a}
main{max-width:34rem;margin:0 auto}
code{display:block;padding:12px;border-radius:8px;background:#e8e8e4;font-size:15px;overflow-wrap:anywhere}
@media (prefers-color-scheme:dark){body{background:#151514;color:#ececea}code{background:#262624}}
</style>
</head>
<body>
<main>
<h1>${w.heading}</h1>
<p>${w.body}</p>
<p>${w.howTo}</p>
<code>${ANDROID_APP_ON_COMMAND}</code>
</main>
</body>
</html>
`;
}
