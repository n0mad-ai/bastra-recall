/**
 * #1198 — how every route under /ui is treated by the sign-in gate
 * (ui-auth-gate.ts). The table is the single place to look:
 *
 * - access "open": reachable without a session (the sign-in page, its static
 *   files, the sign-in state, the sign-in and the first-account setup).
 * - access "session": needs a valid session once an account exists. Without a
 *   session a page navigation is sent to /ui/login, a data route answers 401.
 * - localOnly: refused with 403 through the tunnel ("public-ui"), with or
 *   without a session.
 * - background: a poll that must not extend the session's idle window.
 * - Writing (any method but GET/HEAD) is derived from the request, not stored
 *   here; with a session it needs the X-Bastra-CSRF header, except where
 *   `noCsrf` is set (sign-in and setup run before a session exists).
 *
 * Matching runs on the path without the query. Prefix entries match the way
 * the handlers do (`startsWith`), so a policy never covers less than its
 * handler. A path without an explicit entry falls back to the static web UI
 * files: session required, not local-only. ui-route-policy.test.ts fails when
 * a /ui route literal in the routers has no explicit entry.
 */
export interface UiRoutePolicy {
  /** Exact path, or a prefix when `prefix` is set. */
  path: string;
  prefix?: boolean;
  access: "open" | "session";
  localOnly?: boolean;
  background?: boolean;
  noCsrf?: boolean;
}

function open(file: string): UiRoutePolicy {
  return { path: `/ui/${file}`, access: "open" };
}

/** Static files the sign-in page loads without a session (webui/app/…, served under /ui/). */
// Exactly what login.html links and login.js imports (ui-route-policy.test.ts
// derives that set from the files and compares), plus the fonts tokens.css loads.
export const UI_LOGIN_ASSETS: readonly UiRoutePolicy[] = [
  ...["img/favicon.ico", "img/favicon-32.png", "img/apple-touch-icon.png"].map(open),
  ...["css/tokens.css", "css/base.css", "css/dialogs.css", "css/auth.css"].map(open),
  ...["js/login.js", "js/dom.js", "js/i18n.js"].map(open),
  ...["en", "de", "views-en", "views-de", "oldviews-en", "oldviews-de", "auth-en", "auth-de"].map((name) =>
    open(`js/i18n/${name}.js`)
  ),
  { path: "/ui/fonts/", prefix: true, access: "open" },
];

export const UI_ROUTE_POLICY: readonly UiRoutePolicy[] = [
  // Sign-in (ui-auth-routes.ts).
  { path: "/ui/login", access: "open" },
  { path: "/ui/auth/state", access: "open" },
  { path: "/ui/auth/login", access: "open", noCsrf: true },
  { path: "/ui/auth/setup", access: "open", localOnly: true, noCsrf: true },
  { path: "/ui/auth/logout", access: "session" },
  { path: "/ui/auth/logout-all", access: "session" },
  { path: "/ui/auth/password", access: "session" },
  ...UI_LOGIN_ASSETS,
  // Local only: settings, assistant address, folder picker and folder import.
  { path: "/ui/settings", prefix: true, access: "session", localOnly: true },
  { path: "/ui/assistant-address", prefix: true, access: "session", localOnly: true },
  { path: "/ui/fs", prefix: true, access: "session", localOnly: true },
  { path: "/ui/import-vault", prefix: true, access: "session", localOnly: true },
  // Background polls.
  { path: "/ui/updates", prefix: true, access: "session", background: true },
  { path: "/ui/health", access: "session", background: true },
  { path: "/ui/import-count", access: "session", background: true },
  // Data routes.
  { path: "/ui/graph", access: "session" },
  { path: "/ui/graph/node", access: "session" },
  { path: "/ui/graph/semantic", access: "session" },
  { path: "/ui/tasks/", prefix: true, access: "session" },
  { path: "/ui/annotations", access: "session" },
  { path: "/ui/annotate", access: "session" },
  { path: "/ui/import", access: "session" },
  { path: "/ui/skills", access: "session" },
  { path: "/ui/areas", access: "session" },
  { path: "/ui/onboarding", access: "session" },
  { path: "/ui/telemetry", prefix: true, access: "session" },
  { path: "/ui/search", prefix: true, access: "session" },
  { path: "/ui/chat", access: "session" },
  { path: "/ui/chat/conversations", prefix: true, access: "session" },
  { path: "/ui/improve-text", access: "session" },
  { path: "/ui/save-memory", access: "session" },
  { path: "/ui/memory/edit", access: "session" },
  { path: "/ui/memory/archive", access: "session" },
  { path: "/ui/memory/restore", access: "session" },
  { path: "/ui/backdrop", prefix: true, access: "session" },
  { path: "/ui/vault-image", access: "session" },
  // The web UI page itself (index.html).
  { path: "/ui", access: "session" },
  { path: "/ui/", access: "session" },
];

/** Every other file of the web UI and the map engines (webui.ts): session required. */
const STATIC_FILES: UiRoutePolicy = { path: "/ui/", prefix: true, access: "session" };

/** The explicit entry for a path, or undefined when only the static-file fallback applies. */
export function uiRouteEntry(pathname: string): UiRoutePolicy | undefined {
  // Local-only entries first: no other entry may ever open one of their paths.
  const matches = (e: UiRoutePolicy) => (e.prefix ? pathname.startsWith(e.path) : pathname === e.path);
  return UI_ROUTE_POLICY.find((e) => e.localOnly && matches(e)) ?? UI_ROUTE_POLICY.find(matches);
}

/** The policy for a path under /ui (query already removed). */
export function uiRoutePolicy(pathname: string): UiRoutePolicy {
  return uiRouteEntry(pathname) ?? STATIC_FILES;
}
