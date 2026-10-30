/** DNS-label names, deliberately separate from UI display text and shell code. */
const RESERVED = new Set(["localhost", "localhost6", "local", "wpad", "broadcasthost", "ip6-localhost", "ip6-loopback", "invalid", "test", "example"]);
export function normalizeAssistantName(value: string): string {
  const name = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) || !/[a-z]/.test(name) || RESERVED.has(name)) {
    throw new Error("Assistentenname: 1–63 Zeichen (a–z, 0–9, Bindestrich), mindestens ein Buchstabe; kein reservierter Name.");
  }
  return name;
}
export function assistantUrls(value: string) {
  const name = normalizeAssistantName(value);
  return { local: `http://${name}.localhost/ui/`, bare: `http://${name}/ui/` };
}
