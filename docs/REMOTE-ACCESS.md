# Remote access for ChatGPT

This guide connects ChatGPT on the web and on your phone to **your own** Bastra
Recall installation. It covers what gets exposed, how the login works, a
complete Cloudflare Tunnel setup, and how to check, manage and revoke access.

**Status:** included since release 1.1.8. ChatGPT on the web and in the phone
app is tested and connects through a Cloudflare Tunnel. Other MCP clients may
work over the same address but are not tested. There is no hosted Bastra relay:
you publish your own installation under your own domain.

Contents:

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Security model](#security-model)
- [Step 1: prepare the daemon](#step-1-prepare-the-daemon)
- [Step 2: create a Cloudflare Tunnel](#step-2-create-a-cloudflare-tunnel)
- [Step 3: run the tunnel as a service](#step-3-run-the-tunnel-as-a-service)
- [Step 4: verify from outside](#step-4-verify-from-outside)
- [Step 5: connect ChatGPT (web and phone)](#step-5-connect-chatgpt-web-and-phone)
- [Other clients](#other-clients)
- [Manage and revoke clients](#manage-and-revoke-clients)
- [Web UI through your own address (sign-in)](#web-ui-through-your-own-address-sign-in)
- [Troubleshooting](#troubleshooting)
- [Limits](#limits)

## How it works

Recall normally listens only on your computer (`http://127.0.0.1:6723`).
ChatGPT runs in OpenAI's cloud and cannot reach that address, not even from a
phone on the same Wi-Fi. So you give your Recall a public HTTPS address, and a
tunnel carries requests from that address to the daemon on your computer:

```text
ChatGPT (web / phone app)
   │  HTTPS  https://recall.example.com/api/v1/mcp
   ▼
Cloudflare edge  ── only /api/v1/ and three /.well-known/ paths pass ──
   │  outbound tunnel opened by cloudflared on your computer
   ▼
cloudflared  ──►  http://127.0.0.1:6723  (Recall daemon, your vault)
```

The tunnel connection is opened **from** your computer, so no port on your
router has to be opened. Your vault never leaves your computer; only the
answers to ChatGPT's tool calls travel back through the tunnel.

ChatGPT talks to Recall over **MCP** (the protocol AI assistants use to call
external tools) at `POST /api/v1/mcp`, using Streamable HTTP: stateless, one
JSON response per request, no event stream. It is the same set of tools the
local clients use, through the same dispatcher.

### The login (OAuth 2.1)

ChatGPT cannot send a fixed API token with each request. It expects an OAuth
login, so the daemon acts as its own small OAuth 2.1 authorization server for
this one endpoint. The issuer is your public address (for example
`https://recall.example.com`). What happens when you add the connector:

1. ChatGPT calls `POST /api/v1/mcp` without a token. The daemon answers `401`
   with a `WWW-Authenticate` header that points to its metadata document.
2. ChatGPT reads `/.well-known/oauth-protected-resource/api/v1/mcp` (which
   names the authorization server) and `/.well-known/oauth-authorization-server`
   (which names the endpoints below).
3. ChatGPT registers itself at `POST /api/v1/oauth/register` (dynamic client
   registration) and receives a `client_id`. Registration is refused unless
   every redirect address is on the [allowlist](#security-model).
4. Your browser opens `GET /api/v1/oauth/authorize` on your domain: the page
   **"Connect to Bastra Recall"**. It shows the client's name and the host the
   access will be sent to.
5. You enter your Recall API token (`bastra token`) and approve. The daemon
   sends your browser back to ChatGPT with a one-time code.
6. ChatGPT exchanges the code at `POST /api/v1/oauth/token`, proving with PKCE
   (S256) that it started the login. It receives an access token and a refresh
   token, both bound to your exact MCP address.
7. From then on ChatGPT sends `Authorization: Bearer <access token>` with every
   MCP call and renews the token on its own.

Your API token is typed only into the page on your own domain. ChatGPT never
sees it.

## Requirements

- Recall installed and running on a computer that is **on and online** whenever
  you want to use it from ChatGPT. On macOS, use `bastra autostart on` so the
  daemon runs permanently (see [Step 1](#step-1-prepare-the-daemon)).
- A domain whose DNS is managed by Cloudflare (a free Cloudflare account is
  enough for a tunnel). You can use a subdomain such as `recall.example.com`.
- `cloudflared`, Cloudflare's tunnel program. On macOS: `brew install cloudflared`.
- A ChatGPT account that can add custom MCP servers. Availability depends on
  OpenAI's plan and workspace settings; in a Business or Enterprise workspace
  an admin may have to allow custom connectors. This guide cannot tell you
  which plans OpenAI includes.

Other tunnels or reverse proxies (ngrok, Tailscale Funnel, nginx with a
certificate) can work too, as long as they meet the same rules: HTTPS on port
443 with a valid certificate, the original `Host` header passed through, and
only the paths listed below published. Only the Cloudflare setup below has been
tested.

## Security model

**What is published.** By default only two groups of paths, everything else
answers `404` at the tunnel. The web UI under `/ui` is a third, optional group;
it stays closed until you switch it on
([Web UI through your own address](#web-ui-through-your-own-address-sign-in)):

| Path | Who may use it |
|---|---|
| `/api/v1/*` | Needs a bearer token, except the three OAuth endpoints below |
| `/api/v1/oauth/register`, `/authorize`, `/token` | Public by design; each checks its own credentials (allowlist, API token on the approval page, PKCE) |
| `/.well-known/oauth-protected-resource/api/v1/mcp`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` | Public `GET` documents without secrets |

`/hook/*`, the vault map and every other local route stay unreachable. So does
`/ui`, unless you turn on the optional web UI access below.

**Two kinds of token** open `/api/v1/mcp`:

| Token | Where it comes from | What it opens |
|---|---|---|
| API token | `bastra token` (or `BASTRA_API_TOKEN`) | All of `/api/v1/*`: MCP and the REST routes. For tools you configure yourself, such as Claude Code or curl. |
| OAuth access token | The approval page | `/api/v1/mcp` only, and only at the exact address it was issued for. Every REST route answers `401` to it. |

**What an approved client can do.** The remote MCP door offers the `write` tool
set without task tools: `recall`, `load_memory`, `find_document`,
`read_document`, `find_code`, `find_affected_files`, `save_memory`,
`edit_memory`, `save_document`, `save_product_doc`, `review_draft` and
`validate_artifact`. In plain words: search and read your memories and
documents, save and edit memories, and check copy-ready text blocks.
It cannot archive, reorganise or delete memories, and it cannot open files on
your computer. Document writes additionally need `BASTRA_DOCUMENT_WRITE=1` in
the daemon's environment, as for local clients. Whatever ChatGPT retrieves is
processed by OpenAI like any other chat content; see [privacy](./PRIVACY.md).

**Who can approve.** Only someone who knows your API token. The approval page
shows the redirect host. Approve only if you just added the connector yourself
and the host is the product you are using (`chatgpt.com` for ChatGPT).

**Redirect allowlist.** A login can only send its code to `https` on
`chatgpt.com`, `chat.openai.com`, `claude.ai` or `claude.com`, or to plain
`http` on `localhost` / `127.0.0.1` (any port, for local tools). A client that
registers any other redirect address is refused. This stops someone from
registering a fake "ChatGPT" that sends your approval to their own server. For
a loopback redirect, the page warns that the receiver is a program on your own
computer.

**Guessing protection.** A login attempt ends after 5 wrong API tokens; the
client has to start over. Across all attempts, 100 wrong tokens within 15
minutes lock the form for the rest of that window (`429`).

**Lifetimes:**

| Item | Lifetime |
|---|---|
| Open login (approval page) | 10 minutes |
| One-time code | 2 minutes, single use; a reused code also revokes the access it bought |
| Access token | 1 hour |
| Refresh token | 30 days, replaced on every use; a replaced token is accepted once more within 60 seconds, after that its reuse revokes the whole grant |
| Registration that was never approved | Removed after 10 minutes |

Registered clients are capped at 100. A daemon restart drops half-finished
logins (the client simply starts over); approved clients survive restarts.

**Storage.** Clients and grants live in `oauth.json` in the Bastra data
directory (`~/.bastra/oauth.json`; `BASTRA_OAUTH_PATH` overrides the location).
Tokens are stored only as SHA-256 hashes, so the file cannot hand out a working
token. The daemon reads the file on every check, so `bastra oauth revoke` takes
effect on the next request without a restart.

**Rotating the API token** (`bastra token rotate`) does not revoke clients that
were already approved. Use [`bastra oauth revoke`](#manage-and-revoke-clients)
for that.

### The Host rule: why the tunnel must not rewrite `Host`

Local tools such as the MCP forwarder reach `/api/v1/*` without a token. The
daemon allows that only when the connection comes from `127.0.0.1` **and** the
`Host` header is `127.0.0.1`, `localhost` or `[::1]` (#526), and no forwarding
header is present (#1264): `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`,
`X-Forwarded-Proto`, `X-Real-IP` or `Via`. A tunnel running
on the same computer also connects from `127.0.0.1`, so the `Host` header is
what tells a tunnelled request from a local tool: requests through the tunnel
carry `Host: recall.example.com` and therefore need a token.

That protection only holds if the tunnel passes the public `Host` through
unchanged. **Do not** set cloudflared's `httpHostHeader` (or nginx's default
upstream Host, or `ngrok --host-header=rewrite`). A rewritten
`Host: 127.0.0.1` without forwarding headers would make requests from the
internet look like a local tool and skip the token check. Forwarding headers
disable that exception even with empty or localhost values; every other local
route (`/hook/*`, `/ui`, `/health`, `/tools` and the rest outside `/api/v1/*`,
except the public OAuth discovery documents under `/.well-known/`) also
requires the Bearer token when one of them is present. The one exception is
the optional [web UI access](#web-ui-through-your-own-address-sign-in): it is
off by default and only matches the exact host you set. Keep all other routes
private. The required `401` check in
[Step 4](#step-4-verify-from-outside) proves that unauthenticated requests are
rejected by your actual tunnel setup.

**Never publish Recall through a proxy or port forward that sets `Host` to a
loopback address and adds no forwarding header** — for example nginx with a
bare `proxy_pass`, `ssh -L` or `socat`. The daemon cannot tell such a request
from a local tool, so it gets in without a token. Publish only `/api/v1/*` and
the OAuth discovery documents listed in the [security model](#security-model).

Deutsch: Die tokenlose Ausnahme gilt nur bei lokalem Peer und Loopback-Host
ohne Weiterleitungs-Header (`Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`,
`X-Forwarded-Proto`, `X-Real-IP`, `Via`). Jeder dieser Header erzwingt ein
gültiges Bearer-Token, auch mit leerem Wert oder localhost-Angabe; das gilt
ebenfalls für jede andere lokale Route außerhalb von `/api/v1/*` (`/hook/*`,
`/ui`, `/health`, `/tools` usw.; ausgenommen die öffentlichen
OAuth-Dokumente unter `/.well-known/`). Öffentliche Proxys müssen
den öffentlichen `Host` erhalten: Werden sowohl Host als auch Weiterleitungs-
Header entfernt, sieht der Daemon einen direkten lokalen Aufruf. Hooks und UI
bleiben privat. Der externe `401`-Test prüft den Schutz des tatsächlichen Tunnels.
**Veröffentliche Recall nie über einen Proxy oder eine Portweiterleitung, die
`Host` auf eine Loopback-Adresse setzt und keinen Weiterleitungs-Header
hinzufügt** – etwa nginx mit bloßem `proxy_pass`, `ssh -L` oder `socat`. Der
Daemon kann eine solche Anfrage nicht von einem lokalen Werkzeug
unterscheiden; sie kommt ohne Token durch. Veröffentliche nur `/api/v1/*` und
die OAuth-Dokumente aus dem [Sicherheitsmodell](#security-model).

`BASTRA_AUTH_LOOPBACK_SKIP=0` in the daemon's environment is optional extra
hardening: it requires the token from local callers too, so even a rewritten
Host would not get through. It has a cost: local MCP forwarders read the token
only from their own `BASTRA_API_TOKEN` environment variable, so every
registered local client (for example Claude Code, Claude Desktop or Codex) then needs that
variable in its MCP configuration, or its tool calls fail with `401`. With the
Host preserved and the `401` check passing, it is not needed.

## Step 1: prepare the daemon

1. Create the API token, if you do not have one yet, and keep it somewhere safe
   (a password manager):

   ```sh
   bastra token
   ```

2. Make the daemon run permanently. On macOS:

   ```sh
   bastra autostart on
   ```

   The managed service keeps the daemon running without its 30-minute idle
   shutdown, so ChatGPT can reach it at any time. A daemon that was started on
   demand by a client exits after 30 minutes without work, and the tunnel would
   then answer `502`.

3. The daemon reads the token at startup. If you created the token in step 1
   while the daemon was already running, restart it. With autostart on macOS:

   ```sh
   launchctl kickstart -k gui/$(id -u)/ai.n0mad.bastra-recall
   ```

4. Check locally: `bastra status` shows whether a token is set (without
   printing it).

## Step 2: create a Cloudflare Tunnel

Replace `recall.example.com` with your own hostname and `bastra-recall` with
any tunnel name you like.

1. Install and log in. The login opens a browser; pick the domain you want to
   use.

   ```sh
   brew install cloudflared
   cloudflared tunnel login
   ```

2. Create the tunnel. This prints a tunnel ID and writes a credentials file
   `~/.cloudflared/<TUNNEL-ID>.json`.

   ```sh
   cloudflared tunnel create bastra-recall
   ```

3. Write `~/.cloudflared/config.yml`:

   ```yaml
   # Only /api/v1/ and the three OAuth discovery documents reach Recall;
   # everything else gets 404. No httpHostHeader: the daemon must see the
   # public Host (see "The Host rule").
   tunnel: <TUNNEL-ID>
   credentials-file: /Users/<you>/.cloudflared/<TUNNEL-ID>.json
   ingress:
     - hostname: recall.example.com
       path: ^/api/v1/
       service: http://127.0.0.1:6723
     - hostname: recall.example.com
       path: ^/\.well-known/oauth-(protected-resource(/api/v1/mcp)?|authorization-server)$
       service: http://127.0.0.1:6723
     - service: http_status:404
   ```

   Use your real home folder in `credentials-file` (on Linux usually
   `/home/<you>/...`). If you changed Recall's port, change `6723` too.

4. Point the hostname at the tunnel. This creates the DNS record in Cloudflare:

   ```sh
   cloudflared tunnel route dns bastra-recall recall.example.com
   ```

5. Start the tunnel in the foreground to try it:

   ```sh
   cloudflared tunnel run bastra-recall
   ```

   Leave it running and continue with [Step 4](#step-4-verify-from-outside).
   Once everything works, stop it with Ctrl+C and set it up as a service.

Cloudflare's own documentation:
[create a locally managed tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/)
and the [configuration file](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/).

## Step 3: run the tunnel as a service

### macOS: a user LaunchAgent

A LaunchAgent starts the tunnel at login and restarts it if it stops. Save this
as `~/Library/LaunchAgents/com.example.cloudflared-recall.plist` (any label
works; keep the file name and `Label` the same). Adjust the paths: on Intel Macs
Homebrew installs to `/usr/local/bin/cloudflared` (`which cloudflared` shows
yours).

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.cloudflared-recall</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/cloudflared</string>
    <string>--no-autoupdate</string>
    <string>--config</string>
    <string>/Users/<you>/.cloudflared/config.yml</string>
    <string>tunnel</string>
    <string>run</string>
    <string>bastra-recall</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/Users/<you>/.cloudflared/recall-tunnel.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/<you>/.cloudflared/recall-tunnel.log</string>
</dict>
</plist>
```

Load it (it starts immediately and on every login):

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.cloudflared-recall.plist
```

Stop and unload it:

```sh
launchctl bootout gui/$(id -u)/com.example.cloudflared-recall
```

The log is in `~/.cloudflared/recall-tunnel.log`. A user LaunchAgent runs only
while you are logged in. The Mac must be awake and online for ChatGPT to reach
Recall; while it sleeps, ChatGPT's calls fail.

### Linux and Windows

Use cloudflared's own service setup (`cloudflared service install`), described
in [Run as a service](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/as-a-service/).
Remote access has not been tested on either system. Also note the
[platform support](../README.md#supported-platforms): Linux has no
bastra-managed daemon service yet ([#566](https://github.com/n0mad-ai/bastra-recall/issues/566)),
so a daemon started on demand by a client exits after 30 minutes without work.
On Linux, Recall cannot yet check which user account a local request comes from: every program of every user on the computer reaches the local service. Run it there only on a computer with a single user — not on a shared computer, and not in a container that shares its network with others. Private memories stay hidden from such callers there too.
Windows support is experimental; `bastra autostart on` there creates a
Task Scheduler task whose real-machine acceptance is still pending.

## Step 4: verify from outside

Run these from any machine, ideally one outside your home network (for example
a phone hotspot). Replace the hostname and `<token>`. **Do not connect ChatGPT
until all of them answer as shown.**

```sh
H=https://recall.example.com

# Without a token: must be 401. A 200 here means the Host header is being
# rewritten — stop and fix the tunnel (see "The Host rule").
curl -s -o /dev/null -w '%{http_code}\n' $H/api/v1/health                    # 401

# With the API token: 200.
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer <token>" $H/api/v1/health   # 200

# Local-only routes stay closed at the tunnel. (/ui answers 404 as long as
# you have not added the /ui rule from "Web UI through your own address".)
curl -s -o /dev/null -w '%{http_code}\n' $H/ui                               # 404
curl -s -o /dev/null -w '%{http_code}\n' $H/hook/recall                      # 404

# The MCP endpoint asks for a login and names its metadata.
curl -s -D - -o /dev/null -X POST $H/api/v1/mcp | grep -i -E '^HTTP|www-authenticate'
# HTTP/2 401
# www-authenticate: Bearer resource_metadata="https://recall.example.com/.well-known/oauth-protected-resource/api/v1/mcp", scope="mcp"

# The discovery document is public and names your address as issuer.
curl -s $H/.well-known/oauth-authorization-server
```

Optional: a full MCP call with the API token.

```sh
curl -s -X POST $H/api/v1/mcp \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Step 5: connect ChatGPT (web and phone)

The menu below is how ChatGPT looked in October 2026. OpenAI changes these
screens often; the older "Settings → Developer mode" path no longer exists.

1. On the web, open **chatgpt.com/plugins**, click **+** and choose to add (or
   create) a **custom MCP server**.
2. Enter a name (for example "Recall") and the server URL
   `https://recall.example.com/api/v1/mcp`.
3. Choose **OAuth** as authentication. Leave client ID and client secret
   **empty**: ChatGPT registers itself.
4. The page **"Connect to Bastra Recall"** opens on your domain. Check that the
   access will be sent to **chatgpt.com**. Enter your API token (`bastra token`)
   and click **Approve**.
5. Back in ChatGPT, the server is connected. In a chat, you can call it with
   `@Recall` (the name you chose), for example
   "@Recall what did I decide about the release date?".

**On the phone** there is nothing extra to set up: the connector belongs to
your ChatGPT account, so the ChatGPT app on your phone uses the same server
after you add it on the web. In the verified test on an iPhone, ChatGPT called
Recall on its own when a question needed it, without an @-mention.

To check the connection, ask for a memory you know exists and is not private,
once on the web and once on the phone.

## Other clients

### Claude Code with a static token

Tools that can send a fixed header don't need OAuth. They use the API token
directly. On the computer that runs Recall, the normal local setup
(`bastra install claude-code`) is simpler and needs no tunnel. For Claude Code
on **another** computer:

```sh
claude mcp add --transport http recall-remote https://recall.example.com/api/v1/mcp \
  --header "Authorization: Bearer <token>"
```

The API token opens all of `/api/v1/`, not only MCP, so only put it on machines
you control.

### Custom GPT Actions (legacy)

OpenAI retires Custom GPTs on 2026-12-11, and their actions do not carry over.
The earlier Custom GPT Action route is kept for reference in
[the REST contract guide](./openapi-generation.md#legacy-custom-gpt-action);
use the MCP connection above instead.

## Manage and revoke clients

```sh
bastra oauth list            # every approved client: id, name, redirect host, last use
bastra oauth list --json
bastra oauth revoke <client_id>
bastra oauth revoke all
```

A revoked client loses all its tokens with the next request; no restart is
needed. To use it again, remove and re-add the connector in ChatGPT and approve
again with the API token. `bastra oauth list` also shows registrations that
were never approved ("never approved"); they disappear after 10 minutes on
their own.

If you suspect your API token leaked: run `bastra token rotate`, restart the
daemon (see [Step 1](#step-1-prepare-the-daemon)), then `bastra oauth revoke all`
and reconnect the clients you trust.

To switch remote access off completely, stop the tunnel (`launchctl bootout …`
on macOS). Nothing can reach the daemon from outside while the tunnel is down.

## Web UI through your own address (sign-in)

You can also open the web UI (`bastra map`) from outside, for example on your
phone, through the same tunnel. This is optional and off by default.

### What changes

- The web UI now has a **sign-in with user name and password**. One account,
  one vault. There are no further users.
- **Without an account nothing changes.** On your computer the web UI opens as
  before, and from outside nothing is reachable: even with the tunnel rule in
  place, every `/ui` request answers `403` until an account exists.
- **With an account, the sign-in applies on your computer too.** `bastra map`
  then shows the sign-in page first.
- The account only protects `/ui`. `/api/v1`, the MCP forwarders, hooks and the
  command line work as before, with the same tokens.

### Step by step

1. **Create the account** on the computer that runs Recall, in a terminal:

   ```sh
   bastra account setup
   ```

   It asks for a user name, then for the password twice (hidden). The password
   needs at least 15 characters and at most 1024 bytes. It is read only from
   the terminal, never from arguments, environment or a pipe. Without a
   terminal the command stops with a message. It never overwrites an existing
   account.

2. **Switch on remote access** with your public address (`https://` only, no
   path, no `localhost`):

   ```sh
   bastra ui remote on https://recall.example.com
   ```

   This takes effect at once; no restart. `bastra ui remote status` shows the
   current state.

3. **Let `/ui` through the tunnel.** Add one rule to the `ingress` list in
   `~/.cloudflared/config.yml`, before the last rule (`http_status:404`):

   ```yaml
   ingress:
     - hostname: recall.example.com
       path: ^/api/v1/
       service: http://127.0.0.1:6723
     - hostname: recall.example.com
       path: ^/\.well-known/oauth-(protected-resource(/api/v1/mcp)?|authorization-server)$
       service: http://127.0.0.1:6723
     - hostname: recall.example.com
       path: ^/ui(/|$)
       service: http://127.0.0.1:6723
     - service: http_status:404
   ```

   Then restart the tunnel (macOS: `launchctl kickstart -k gui/$(id -u)/com.example.cloudflared-recall`,
   with your own label). Publish only `/ui` additionally; do not open anything
   else.

4. **Check the proxy settings.** Whatever you use in front of Recall must:
   - pass the public host through **unchanged** (the same rule as in
     [The Host rule](#the-host-rule-why-the-tunnel-must-not-rewrite-host)), and
     the host must match the address from step 2 exactly;
   - set `X-Forwarded-Proto: https`. Requests for the public host without it
     are refused.

   In Cloudflare, also switch on **Always Use HTTPS** for the domain (SSL/TLS →
   Edge Certificates), so the password is never sent over plain `http`.

5. **Sign in.** Open `https://recall.example.com/ui/` in a browser and sign in.

### Verify

From a machine outside your network (replace the hostname):

```sh
H=https://recall.example.com

# The sign-in page is reachable.
curl -s -o /dev/null -w '%{http_code}\n' $H/ui/login                 # 200

# Without a session, no data: 401 for data routes ...
curl -s -o /dev/null -w '%{http_code}\n' $H/ui/graph                 # 401
curl -s -o /dev/null -w '%{http_code}\n' $H/ui/health                # 401

# ... and the closed routes answer 403 even after sign-in.
curl -s -o /dev/null -w '%{http_code}\n' $H/ui/settings              # 403

# Hooks stay closed.
curl -s -o /dev/null -w '%{http_code}\n' $H/hook/recall              # 404
```

A page request without a session (with `Accept: text/html`) is redirected to
`/ui/login` instead of answering `401`. If `/ui/graph` returns data without a
session, stop: switch remote access off (below) and check the proxy.

### Switch off

```sh
bastra ui remote off
```

This clears the address, takes effect at once and ends every session that
came through the tunnel. Then remove the `/ui` rule from the `ingress` list and
restart the tunnel. Your account and local sessions stay.

### Security model of the web UI

**Reachable from the internet** (only after sign-in, except the sign-in page
itself): the memory browser, graph, search, tasks, reports, chat and the other
pages of the web UI.

**Never reachable from the internet**, with or without a session (answer
`403`): settings (`/ui/settings`), the assistant address, the folder picker
(`/ui/fs`), vault import (`/ui/import-vault`) and the first-account setup
page. Hooks and `/health` are not published at all. Change these things on
your computer.

Private memories are shown after sign-in, **also from outside**. Whoever signs
in sees your whole vault in the web UI. Treat the password like the key to it.

**Sessions:**

| Item | Lifetime |
|---|---|
| Normal session | 24 hours at most, and it ends after 2 hours without use |
| "Stay signed in on this device" | 30 days at most |

Background polls of the page do not extend a session. Sessions survive a daemon
restart. A session made on your computer does not work through the tunnel, and
the other way round.

The session cookie is `HttpOnly` and `SameSite=Strict`. Through the tunnel it is
also `Secure`, and answers carry `Strict-Transport-Security`. Every write
request needs the session's CSRF header; through the tunnel it must also carry
exactly your public address as `Origin`.

**Protection against password guessing.** Counted per source (through
Cloudflare: the address from `CF-Connecting-IP`; IPv6 per /64 network):

- 5 wrong passwords within 15 minutes lock that source for 15 minutes. Every
  further lock doubles the time, up to 24 hours.
- 20 wrong passwords within 24 hours from all outside sources together close
  the sign-in from outside for 1 hour. Every further lock doubles the time, up
  to 24 hours. A wrong user name counts too.
- At most 30 attempts per minute from outside, and one password check runs at
  a time (4 more may wait). Beyond that the answer is `429` with `Retry-After`.
- Sign-in on your computer is only limited to 5 attempts per minute. The outside
  locks never block it, and existing sessions stay valid during a lock.

Behind a proxy that does not send `CF-Connecting-IP`, all outside requests
count as one source, so a single guesser can lock everyone out. Cloudflare sends
the header.

**Passwords.** At least 15 characters, at most 1024 bytes; nothing is cut off.
Stored as an Argon2id hash (64 MiB, 3 passes), never the password itself.

**Where the hash lives.** In Recall's local app database (`recall.db`). A backup
of that database contains the password hash and the session records. Treat such
backups like the vault. The JSON export of the database leaves these tables out.

### Locked out? Lost the password?

On your computer only:

```sh
bastra account status           # account, sessions, active locks, remote on/off
bastra account unlock           # clear all locks and counters
bastra account reset-password   # new password (asks twice, hidden); ends all sessions
```

### See and revoke devices

```sh
bastra account devices          # id, kind, origin, last use, expires, label
bastra account revoke <id>      # end one session (an unambiguous start of the id, 6+ characters, works)
bastra account logout-all       # end all sessions
```

In the web UI on your computer, the same is under **Settings → Account and
devices**. These settings are not available through the tunnel.
A password change in the web UI or `reset-password` ends all sessions.

Deutsch: Die Weboberfläche ist über die eigene Adresse optional von außen
erreichbar, geschützt durch Anmeldung mit Nutzername und Passwort (ein Konto,
mindestens 15 Zeichen). Ohne Konto bleibt lokal alles wie bisher und von außen
ist nichts erreichbar; mit Konto ist auch lokal eine Anmeldung nötig. Ablauf:
`bastra account setup`, dann `bastra ui remote on https://<eigene-adresse>`,
dann am Tunnel zusätzlich nur `/ui` durchlassen (cloudflared: `path: ^/ui(/|$)`),
den öffentlichen Host unverändert weitergeben, `X-Forwarded-Proto: https`
setzen und bei Cloudflare „Always Use HTTPS" einschalten. Aus: `bastra ui remote
off` und Regel entfernen. Von außen nie erreichbar: Einstellungen,
Ordnerzugriff, Vault-Import, Assistenten-Adresse, Hooks, Health. Private
Erinnerungen sind nach der Anmeldung auch von außen sichtbar. Sitzungen: 24
Stunden, 2 Stunden Leerlauf, „auf diesem Gerät angemeldet bleiben" 30 Tage.
Gegen Passwort-Raten gibt es Sperren (5 Fehlversuche in 15 Minuten sperren die
Quelle 15 Minuten, 20 in 24 Stunden sperren die Anmeldung von außen 1 Stunde;
jede weitere Sperre verdoppelt die Zeit bis höchstens 24 Stunden). Bei
Aussperrung hilft nur lokal `bastra account unlock` oder `reset-password`;
Geräte widerrufst du mit `bastra account devices` und `revoke` oder in den
Einstellungen unter „Konto und Geräte". Der Passwort-Prüfwert liegt in der
lokalen App-Datenbank; Sicherungen davon enthalten ihn.

## Troubleshooting

**`curl …/api/v1/health` without a token returns `200`.** The tunnel rewrites
the `Host` header. Remove `httpHostHeader` (or the equivalent proxy setting)
and retest. Do not connect anything until this returns `401`.

**`502` or `530` from Cloudflare.** The tunnel is up but the daemon is not
answering, or the tunnel is down. Check `bastra status`, `bastra autostart status`
and the tunnel log (`~/.cloudflared/recall-tunnel.log`). Is the Mac asleep?

**`404` for `/api/v1/mcp`.** The ingress rule for `^/api/v1/` is missing or the
hostname in `config.yml` does not match the one you entered in ChatGPT.

**ChatGPT says it cannot find an authorization server or fails before the
approval page.** The three `/.well-known/` documents must be published (second
ingress rule). `curl https://recall.example.com/.well-known/oauth-authorization-server`
must return JSON whose `issuer` is your public address with `https://`.

**The approval page says "Unknown client".** The registration expired (10
minutes) or was revoked. Remove the connector in ChatGPT and add it again.

**"This sign-in request expired or was already used".** The login took longer
than 10 minutes, or the daemon was restarted in between. Start the connection
again.

**"Wrong API token" / "Too many wrong tokens".** Run `bastra token` on the
computer that runs Recall and copy the token exactly. After 5 wrong attempts
the login has to be started again; after 100 wrong attempts in 15 minutes the
form is locked for the rest of that window.

**"This daemon has no API token".** Run `bastra token`, restart the daemon and
start the connection again.

**ChatGPT worked, then stopped after weeks.** A refresh token that is not used
for 30 days expires. Reconnect. Also check `bastra oauth list` that the client
was not revoked.

**You changed the hostname.** Tokens are bound to the exact address. Remove the
connector and add it again with the new URL.

**Local Claude Code / Codex tools fail with `401` after you set
`BASTRA_AUTH_LOOPBACK_SKIP=0`.** That setting requires the token from local
forwarders too; add `BASTRA_API_TOKEN` to each client's MCP configuration, or
remove the setting (see [The Host rule](#the-host-rule-why-the-tunnel-must-not-rewrite-host)).

## Limits

- **Your computer must be on, awake and online.** Recall's vault lives there;
  there is no copy in the cloud.
- **No hosted relay.** You need your own domain and tunnel. Bastra does not run
  a public endpoint for your vault.
- **Single user.** Whoever knows the API token can approve clients. There are
  no separate user accounts or per-client permissions; every approved client
  gets the same tool set. The web UI has one account and no further users.
- **No task tools remotely.** Task tools need a local caller and their own
  credentials, so the remote door leaves them out.
- **Untested:** the ChatGPT Android app, Linux and Windows hosts,
  and tunnels other than Cloudflare.
- ChatGPT plan and workspace restrictions are set by OpenAI and may change.
