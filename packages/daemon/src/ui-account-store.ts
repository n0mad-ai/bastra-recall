/**
 * #1198 — the one web UI account (Daniel, 26.11.2026: one account, one vault,
 * user name and password). Lives in table ui_account of the app database
 * (migration v4); the password is kept only as an Argon2id check value
 * (ui-password.ts).
 *
 * - An existing account is never overwritten: create fails with
 *   "account-exists".
 * - setPassword raises credential_version; sessions bound to an older version
 *   stop counting (ui_sessions.credential_version).
 * - status() distinguishes "none", "present" and "damaged". Damaged storage
 *   (unreadable table, invalid user name or check value) means locked, never
 *   open: verifyLogin then refuses.
 *
 * User names: 1–64 Unicode code points, no control characters, no leading or
 * trailing white space; stored and compared in NFC so the same name typed on
 * different systems matches. Case is kept as typed (case folding depends on the
 * language). No language-specific lists.
 */
import type { AppDatabase } from "./app-database.js";
import {
  dummyVerifyUiPassword,
  hashUiPassword,
  isUiPasswordHash,
  uiPasswordProblem,
  verifyUiPassword,
  type UiPasswordProblem,
} from "./ui-password.js";

const UI_USERNAME_MAX_CHARS = 64;

export type UiUsernameProblem = "username-empty" | "username-too-long" | "username-invalid";
type UiAccountProblem = "account-exists" | "no-account" | UiUsernameProblem | UiPasswordProblem;

export type UiAccountStatus =
  | { state: "none" }
  | { state: "present"; username: string; credentialVersion: number; createdAt: number; updatedAt: number }
  | { state: "damaged" };

export type UiAccountResult = { ok: true; credentialVersion: number } | { ok: false; problem: UiAccountProblem };
export type UiLoginResult = { ok: true; credentialVersion: number } | { ok: false };

/** null when the name may be used; otherwise the rule it breaks. */
export function uiUsernameProblem(username: unknown): UiUsernameProblem | null {
  if (typeof username !== "string") return "username-invalid";
  // UTF-16 units >= code points: cheap bound before normalizing long input.
  if (username.length > UI_USERNAME_MAX_CHARS * 2) return "username-too-long";
  if (/[\p{Cc}\p{Cs}]/u.test(username) || /^\s|\s$/u.test(username)) return "username-invalid";
  const chars = [...username.normalize("NFC")].length;
  if (chars === 0) return "username-empty";
  return chars > UI_USERNAME_MAX_CHARS ? "username-too-long" : null;
}

export class UiAccountStore {
  constructor(private readonly db: AppDatabase) {}

  status(): UiAccountStatus {
    return this.read().status;
  }

  private read(): { status: UiAccountStatus; hash?: string } {
    try {
      const row = this.db.sqlite
        .prepare("SELECT username,password_hash,credential_version,created_at,updated_at FROM ui_account WHERE id=1")
        .get();
      if (!row) return { status: { state: "none" } };
      const credentialVersion = Number(row.credential_version);
      if (
        typeof row.username !== "string" ||
        uiUsernameProblem(row.username) !== null ||
        !isUiPasswordHash(row.password_hash) ||
        !Number.isSafeInteger(credentialVersion) ||
        credentialVersion < 1
      )
        return { status: { state: "damaged" } };
      return {
        status: {
          state: "present",
          username: row.username,
          credentialVersion,
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
        },
        hash: String(row.password_hash),
      };
    } catch {
      // Unreadable storage locks the UI rather than opening it.
      return { status: { state: "damaged" } };
    }
  }

  /** First account only; an existing (or damaged) account row is never replaced. */
  async create(username: unknown, password: unknown): Promise<UiAccountResult> {
    const problem = uiUsernameProblem(username) ?? uiPasswordProblem(password);
    if (problem) return { ok: false, problem };
    if (this.hasRow()) return { ok: false, problem: "account-exists" };
    const hash = await hashUiPassword(password as string);
    const now = Date.now();
    const inserted = this.db.transaction(() =>
      Number(
        this.db.sqlite
          .prepare(
            `INSERT INTO ui_account(id,username,password_hash,credential_version,created_at,updated_at)
             VALUES(1,?,?,1,?,?) ON CONFLICT(id) DO NOTHING`
          )
          .run((username as string).normalize("NFC"), hash, now, now).changes
      )
    );
    return inserted === 1 ? { ok: true, credentialVersion: 1 } : { ok: false, problem: "account-exists" };
  }

  /** New password for the existing account; raises credential_version. Also the local repair path for a damaged check value. */
  async setPassword(password: unknown): Promise<UiAccountResult> {
    const problem = uiPasswordProblem(password);
    if (problem) return { ok: false, problem };
    if (!this.hasRow()) return { ok: false, problem: "no-account" };
    const hash = await hashUiPassword(password as string);
    const row = this.db.transaction(() =>
      this.db.sqlite
        .prepare(
          `UPDATE ui_account SET password_hash=?, credential_version=credential_version+1, updated_at=?
           WHERE id=1 RETURNING credential_version`
        )
        .get(hash, Date.now())
    );
    return row ? { ok: true, credentialVersion: Number(row.credential_version) } : { ok: false, problem: "no-account" };
  }

  /**
   * Same Argon2id cost whether the name is unknown, the account missing or
   * damaged, or the password wrong; the result does not say which.
   */
  async verifyLogin(username: unknown, password: unknown): Promise<UiLoginResult> {
    const { status: account, hash } = this.read();
    if (
      account.state !== "present" ||
      typeof username !== "string" ||
      uiUsernameProblem(username) !== null ||
      username.normalize("NFC") !== account.username
    ) {
      await dummyVerifyUiPassword(password);
      return { ok: false };
    }
    return (await verifyUiPassword(password, hash))
      ? { ok: true, credentialVersion: account.credentialVersion }
      : { ok: false };
  }

  private hasRow(): boolean {
    return !!this.db.sqlite.prepare("SELECT 1 FROM ui_account WHERE id=1").get();
  }
}
