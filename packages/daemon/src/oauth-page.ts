/**
 * #1279 Phase 2: the HTML of the OAuth consent page — the one place a human
 * approves a remote client. No script (the CSP in oauth-server.ts forbids it),
 * every interpolated value escaped. Shows the client's self-chosen name AND the
 * host it will be sent back to: the name is whatever the registrant claimed,
 * the redirect host is what actually receives the access.
 */

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#1d1d1f;background:#fafafa}
@media (prefers-color-scheme:dark){body{color:#eee;background:#1b1b1d}input{background:#2a2a2d;color:#eee}}
h1{font-size:1.3rem}code{font-size:.9em}.host{font-weight:600}.warn{color:#b45309}.err{color:#c62828}
input[type=password]{width:100%;box-sizing:border-box;padding:.5rem;font:inherit;margin:.25rem 0 1rem}
button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}
</style></head><body>${body}</body></html>`;
}

export function renderAuthorizePage(p: {
  requestId: string;
  clientName: string;
  redirectUri: string;
  error: string | null;
}): string {
  const u = new URL(p.redirectUri);
  const local = u.protocol === "http:";
  return page(
    "Connect to Bastra Recall",
    `<h1>Connect to Bastra Recall</h1>
<p><strong>${esc(p.clientName)}</strong> wants access to your recall memory (read and save).</p>
<p>Access will be sent to <span class="host">${esc(u.host)}</span>.${
      local ? ` <span class="warn">This is a program on your own computer — approve only if you started it.</span>` : ""
    }</p>
<p>Approve only if you just added this connector yourself.</p>
${p.error ? `<p class="err">${esc(p.error)}</p>` : ""}
<form method="post" action="/api/v1/oauth/authorize">
<input type="hidden" name="request" value="${esc(p.requestId)}">
<label for="t">Your Bastra API token (<code>bastra token</code>)</label>
<input id="t" type="password" name="api_token" autocomplete="off" autofocus>
<button type="submit" name="action" value="approve">Approve</button>
<button type="submit" name="action" value="deny">Deny</button>
</form>`,
  );
}

export function renderErrorPage(message: string): string {
  return page("Bastra Recall", `<h1>Bastra Recall</h1><p class="err">${esc(message)}</p>`);
}
