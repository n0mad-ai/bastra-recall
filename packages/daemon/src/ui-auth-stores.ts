/**
 * #1198 — the web UI sign-in stores shared by this process: the account, the
 * sessions and exactly ONE password-guessing throttle (its queue lives in
 * memory, so a second instance would split it). The HTTP gate, the sign-in
 * routes, the CLI (`bastra account …`, `bastra ui remote …`) and the device
 * list in the settings use this module instead of opening their own.
 *
 * All three sit on one connection to the default app database (BASTRA_DB_PATH,
 * ~/.bastra/recall.db; an isolated file under the test runner). When the
 * database cannot be opened the result is null, and every caller treats null
 * as "locked": no sign-in, no session counts. A failed open is not cached, so
 * the next request tries again.
 */
import { openAppDatabase, type AppDatabase } from "./app-database.js";
import { UiAccountStore } from "./ui-account-store.js";
import { UiSessionStore } from "./ui-session.js";
import { UiLoginThrottle } from "./ui-login-throttle.js";

export interface UiAuthStores {
  db: AppDatabase;
  accounts: UiAccountStore;
  sessions: UiSessionStore;
  throttle: UiLoginThrottle;
}

let shared: UiAuthStores | null = null;

/** The process-wide stores, or null when the app database cannot be opened (= locked). */
export function uiAuthStores(): UiAuthStores | null {
  if (shared) return shared;
  try {
    const db = openAppDatabase();
    shared = {
      db,
      accounts: new UiAccountStore(db),
      sessions: new UiSessionStore(db),
      throttle: new UiLoginThrottle(db),
    };
    return shared;
  } catch {
    return null;
  }
}
