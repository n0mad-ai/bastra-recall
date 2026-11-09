/** macOS File Provider may fail a dataless read with EDEADLK / errno -11.
 * This classifies the read failure; it never materializes or modifies a file. */
export function isCloudPlaceholderError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: string; errno?: number; message?: string };
  return e.code === "EDEADLK" || (process.platform === "darwin" &&
    (e.errno === -11 || e.errno === 11 || /Unknown system error -11/.test(e.message ?? "")));
}
export const CLOUD_OFFLINE_GUIDANCE = "Make the vault folder available offline.";
