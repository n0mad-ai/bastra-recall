/**
 * Seeded inputs for the #1528 differential test of `redactSecrets`.
 *
 * The generator is pure: the same seed gives the same inputs on every machine,
 * without git or network. Provider-shaped prefixes are assembled from chunks
 * at runtime, so the source holds no literal credential (push protection).
 * Every value is invented. Changing anything here changes the inputs, which
 * the test detects through the frozen input digest.
 */
import { createHash } from "node:crypto";
import { NETWORK_ROWS } from "./network-redaction-corpus.js";

export interface DifferentialCase {
  input: string;
  home?: string;
}

const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const HEX = "0123456789abcdef";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const join = (...parts: string[]): string => parts.join("");

/** xorshift32, the same generator as the frozen seeded token corpus. */
export function createRandom(seed: number): { int(n: number): number; pick<T>(list: readonly T[]): T } {
  let state = seed >>> 0 || 1;
  const next = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  return { int: (n) => next() % n, pick: (list) => list[next() % list.length] };
}

type Random = ReturnType<typeof createRandom>;
const draw = (r: Random, alphabet: string, n: number): string =>
  Array.from({ length: n }, () => alphabet[r.int(alphabet.length)]).join("");

/** Values that sit on both sides of every heuristic: opaque, readable, located, referenced. */
const VALUES: ReadonlyArray<(r: Random) => string> = [
  (r) => draw(r, B62, 8 + r.int(40)),
  (r) => draw(r, HEX, r.pick([31, 32, 40, 48, 64])),
  (r) => draw(r, B62 + "+/", 20 + r.int(30)) + r.pick(["", "=", "=="]),
  (r) => join(r.pick(["sk", "sk-pr"]), r.pick(["-", "oj-"]), draw(r, B62, 6 + r.int(30))),
  (r) => join("gh", r.pick(["p", "o", "u", "s", "r"]), "_", draw(r, B62, 6 + r.int(30))),
  (r) => join(r.pick(["AK", "AS"]), "IA", draw(r, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 14 + r.int(4))),
  (r) => join("xo", "x", r.pick(["b", "p", "a"]), "-", draw(r, LOWER + "0123456789-", 6 + r.int(20))),
  (r) => join("ey", "J", draw(r, B62, 6 + r.int(20)), ".", draw(r, B62, 4 + r.int(20)), ".", draw(r, B62 + "-_", r.int(30))),
  (r) => join(r.pick(["AI", "gl", "np", "hf", "dckr"]), r.pick(["za", "pat-", "m_", "_", "_pat_"]), draw(r, B62, 6 + r.int(26))),
  (r) => join(String(100000 + r.int(900000)), ":", draw(r, B62 + "-_", 28 + r.int(6))),
  (r) => join("SG", ".", draw(r, B62, 4 + r.int(10)), ".", draw(r, B62, 4 + r.int(10))),
  (r) => r.pick(["hunter2", "sommerhaus2019", "fixture meadow", "Tr0ub4dor&3", "correct horse battery", "pa ss"]),
  (r) => r.pick(["WPA2", "WPA3", "true", "false", "0", "1", "bitte", "siehe unten", "[REDACTED]"]),
  (r) => r.pick(["$DB_PASSWORD", "${API_TOKEN}", "$x", "${not valid}", "$(cat secret)"]),
  (r) => r.pick(["./config/app.yml", "~/keys/id_ed25519", "../up/file.txt", "C:\\Users\\x\\a.txt", "/etc/ssl/key.pem"]),
  (r) => r.pick(["https://example.test/path", "s3://bucket/key", "mailto:a@example.test", "example.test:8443"]),
  (r) => r.pick(["getUserTokenValue", "parseHTTPResponse", "XMLHttpRequest2", "camelCaseIdentifier", "aB", "ABc"]),
  (r) => r.pick(["MY_ENV_NAME", "some-kebab-name", "snake_case_name", "Title-Case-Words", "v1.2.3"]),
  (r) => join(draw(r, HEX, 8), "-", draw(r, HEX, 4), "-", draw(r, HEX, 4), "-", draw(r, HEX, 4), "-", draw(r, HEX, 12)),
  (r) => join(draw(r, LOWER, 3 + r.int(6)), "@", draw(r, LOWER, 3 + r.int(6)), ".test"),
  (r) => join(draw(r, B62, 4 + r.int(8)), "\u200b", draw(r, B62, 8 + r.int(16))),
  (r) => join(draw(r, LOWER + "0123456789", 6), "/", draw(r, B62, 10), "/", draw(r, B62 + "._-", 8)),
  (r) => join(r.pick(["Bearer ", "Basic ", "Token ", "Digest "]), draw(r, B62 + "=", 10 + r.int(30))),
  (r) => r.pick(["|", ">", "|-", ">+", "|2"]) + "\n  " + draw(r, B62, 12) + r.pick(["", "\n  " + draw(r, B62, 10)]) + "\nnext: 1",
  (r) => join("\\", draw(r, B62, 10)),
  (r) => draw(r, B62 + "!#$%*+^~?", 6 + r.int(14)),
  (r) => draw(r, LOWER, 3 + r.int(10)),
  (r) => join(draw(r, B62, 6), "\\\n", draw(r, B62, 10)),
  (r) => join("user", r.int(9).toString(), ":", draw(r, B62, 6 + r.int(14))),
  (r) => join(draw(r, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", 4 + r.int(6)), draw(r, LOWER, 4 + r.int(6)), draw(r, "0123456789", r.int(4))),
];
const value = (r: Random): string => VALUES[r.int(VALUES.length)](r);

const KEYS = [
  "password", "PASSWORD", "db_password", "passwd", "passphrase", "user_pwd", "myPass", "adminPwd", "pass",
  "apiKey", "api_key", "API-KEY", "access_key_id", "secretKey", "private_key", "accountKey", "token", "auth_token",
  "secret", "client_secret", "cookie", "credential", "key", "Key", "psk", "PSK", "psk2", "psk_value", "PSK_HOME",
  "wifi_key", "pre-shared-key", "presharedKey", "usePsk", "psk_mode", "pskIdentity", "Authorization",
  "proxy-authorization", "x-authorization", "host", "model", "target", "name", "value", "title", "path", "url",
  "monkey", "keyboard", "passage", "sort key", "pass\u200bword",
];
const SEPARATORS = ["=", ": ", " = ", ":", "=\n  ", ":\n", " : ", "= "];

function quote(r: Random, v: string): string {
  switch (r.int(10)) {
    case 0:
      return `"${v}"`;
    case 1:
      return `'${v}'`;
    case 2:
      return "`" + v + "`";
    case 3:
      return `\\"${v}\\"`;
    case 4:
      return `"${v.slice(0, 4)}" + "${v.slice(4)}"`;
    case 5:
      return `"${v}\\"tail"`;
    default:
      return v;
  }
}

function assignment(r: Random): string {
  const k = r.pick(KEYS);
  const key = r.int(5) === 0 ? `"${k}"` : r.int(8) === 0 ? `'${k}'` : k;
  return `${key}${r.pick(SEPARATORS)}${quote(r, value(r))}`;
}

/** Command, URL, header and prose forms that reach the specialised passes. */
const FORMS: ReadonlyArray<(r: Random, v: string) => string> = [
  (r, v) => `${r.pick(["https", "postgres", "redis", "ssh", "git+ssh"])}://${r.pick(["user", "u.ser", ""])}:${v}@${r.pick(["db.example.test", "[::1]", "host:5432", "h"])}${r.pick(["", "/path", "?x=1", "#f", "/a@b"])}`,
  (r, v) => `https://example.test/${r.pick(["cb", "api/v1"])}?${r.pick(["token", "api_key", "page", "psk", "access_token"])}=${v}&${r.pick(["next", "password"])}=${value(r)}#frag`,
  (r, v) => `curl ${r.pick(["-u", "--user", "--proxy-user", "-sSLu", "-su", "--user="])}${r.pick([" ", ""])}${r.pick(["admin", "me"])}:${v} ${r.pick(["https://example.test", "-X POST", "| jq ."])}`,
  (r, v) => `http ${r.pick(["-a", "--auth", "--auth="])}${r.pick([" ", ""])}me:${v} example.test`,
  (r, v) => `curl -H ${quote(r, `Authorization: ${r.pick(["Bearer", "Basic", "token"])} ${v}`)} https://example.test`,
  (r, v) => `${r.pick(["Authorization", "authorization", "Proxy-Authorization"])}: ${r.pick(["Bearer ", "Digest username=\"a\", response=\"", "Basic ", ""])}${v}${r.pick(["", "\"", "\r\nX: 1", "}"])}`,
  (r, v) => `${r.pick(["mysql", "mariadb", "sshpass", "docker login", "ssh", "psql", "/usr/bin/mysql"])} ${r.pick(["-p", "-p ", "-u root -p"])}${v} ${r.pick(["db", "-h host", ""])}`,
  (r, v) => `${r.pick(["tool", "app", "deploy"])} --${r.pick(["password", "token", "api-key", "user", "secret", "client-secret", "port"])}${r.pick(["=", " "])}${quote(r, v)}`,
  (r, _v) => `-----BEGIN ${r.pick(["PRIVATE KEY", "RSA PRIVATE KEY", "CERTIFICATE"])}-----\n${draw(r, B62, 40)}\n${r.pick(["-----END PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----", ""])}`,
  (r, v) => `nmcli dev wifi connect ${r.pick(["Home", '"My Net"'])} password ${quote(r, v)}`,
  (r, v) => `networksetup -setairportnetwork en0 ${r.pick(["Home", '"My Net"'])} ${quote(r, v)}`,
  (r, v) => `uci set wireless.@wifi-iface[0].key=${quote(r, v)}`,
  (r, v) => `${r.pick(["", "\n"])}  crypto isakmp key ${v} address 10.0.0.1`,
  (r, v) => `    Key Content            : ${v}`,
  (r, v) => `WiFi.begin(${quote(r, "Home")}, ${quote(r, v)});`,
  (r, v) => `#define WIFI_PSK ${quote(r, v)}`,
  (r, v) => `{"psks": [${quote(r, v)}, "${value(r)}"]}`,
  (r, v) => `WIFI:T:WPA;S:${r.pick(["Home", "My;Net"])};P:${v};;`,
  (r, v) => `${r.pick(["wifi-sec.psk", "802-11-wireless-security.psk", "-psk", "pre-shared-key", "wpa-psk"])} ${quote(r, v)} ${value(r)}`,
  (r, v) => `<${r.pick(["psk", "keyMaterial", "pre-shared-key", "PSK"])}>${v}</${r.pick(["psk", "keyMaterial", "pre-shared-key"])}>`,
  (r, v) => `${r.pick(["Der", "The", "Это", "この"])} ${r.pick(["PSK", "Pre-Shared Key", "pre shared key"])} ${r.pick(["ist", "is", "lautet", ":", "="])} ${quote(r, v)}${r.pick([".", "", "!", "?"])}`,
  (r, v) => `${r.pick(["ssh", "kubectl logs", "model:", "target =", "host:"])} ${v}`,
  (r, v) => `export ${r.pick(["API_TOKEN", "VALUE", "STRIPE", "DATABASE_URL"])}=${quote(r, v)}`,
  (r, v) => `{"key": ${quote(r, v)}, "value": "${value(r)}"}`,
  (r, v) => `sort by key: ${v}`,
  (r, v) => `${r.pick(["nimm", "use", "token"])} ${v} ${r.pick(["dafür", "here", ""])}`,
  (r, v) => `${r.pick(["password", "token", "psk"])}:\n${r.pick(["  ", ""])}${v}\n${r.pick(["other: 1", "  " + value(r)])}`,
  (r, v) => `${r.pick(["password", "secret"])}=${v}\\\n  ${value(r)}`,
  (r, v) => `Ist PSK ${r.pick(["=", ":"])} ${v}${r.pick(["?", ""])}`,
  (r, v) => `/Users/fixture/${r.pick(["proj", "keys"])}/${r.pick(["a.txt", "id_rsa"])} ${r.pick(["token=", "path "])}${v}`,
  (r, v) => `<${r.pick(["Password", "secret"])}>${v}</${r.pick(["Password", "secret"])}>`,
  (r, v) => `${draw(r, LOWER, 4)} ${v} ${draw(r, LOWER, 5)}`,
];
function form(r: Random): string {
  const v = value(r);
  return FORMS[r.int(FORMS.length)](r, v);
}

/** Small structural edits of a base string: what a near-miss input looks like. */
function mutate(r: Random, base: string): string {
  if (!base) return value(r);
  const at = r.int(base.length + 1);
  switch (r.int(10)) {
    case 0:
      return base.slice(0, at) + r.pick([" ", "\n", "\t", "\r\n", ";", ",", "&", "?", "#"]) + base.slice(at);
    case 1:
      return base.slice(0, at) + r.pick(['"', "'", "`", "\\", "=", ":", "@", "$", "{", "}"]) + base.slice(at);
    case 2:
      return base.slice(0, at) + base.slice(Math.min(base.length, at + 1 + r.int(4)));
    case 3:
      return base.slice(0, at);
    case 4:
      return base.toUpperCase();
    case 5:
      return base.toLowerCase();
    case 6:
      return `${r.pick(["Hier: ", "Note — ", "  ", "> ", "- "])}${base}${r.pick([" bitte prüfen.", ")", "\n", ""])}`;
    case 7:
      return base.slice(0, at) + "\u200b" + base.slice(at);
    case 8:
      return base.slice(0, at) + draw(r, B62, 1 + r.int(30)) + base.slice(at);
    default:
      return base.replace(/[=:]/, r.pick(["=", ":", " = ", "=\n", ": "]));
  }
}

const HOMES = [undefined, undefined, undefined, "/Users/fixture", "/home/fixture", "/"] as const;

/** `count` inputs from `seed`: assignments, forms, mixtures and mutations of both. */
export function* differentialCases(seed: number, count: number): Generator<DifferentialCase> {
  const r = createRandom(seed);
  const network = NETWORK_ROWS.map((row) => row.input);
  for (let i = 0; i < count; i++) {
    let input: string;
    switch (r.int(6)) {
      case 0:
        input = assignment(r);
        break;
      case 1:
        input = form(r);
        break;
      case 2:
        input = [assignment(r), form(r), assignment(r)].slice(0, 2 + r.int(2)).join(r.pick(["\n", " ", "; ", "&", "\n\n"]));
        break;
      case 3:
        input = mutate(r, r.int(2) ? assignment(r) : form(r));
        break;
      case 4:
        input = mutate(r, mutate(r, r.int(4) ? form(r) : r.pick(network)));
        break;
      default:
        input = r.pick(network) + r.pick(["\n", " ", "; "]) + (r.int(2) ? assignment(r) : form(r));
    }
    const home = r.pick(HOMES);
    if (home === undefined) {
      yield { input };
      continue;
    }
    // The home path inside the text, before every boundary `abbreviateHome` knows and one it does not.
    if (r.int(2)) input += ` ${home}${r.pick(["/a.txt", "\\b", ":", ")", ",", ";", "'", '"', "`", " ", "", "x", "-old"])}`;
    yield { input, home };
  }
}

/** The frozen run: changing either number generates different inputs. */
export const SEED = 1528;
export const COUNT = 20_000;

/** Four bytes of SHA-256 over the exact output and its redacted-character count. */
export function caseHash(result: { text: string; redactedChars: number }): Buffer {
  return createHash("sha256").update(`${result.text}\u0000${result.redactedChars}`).digest().subarray(0, 4);
}

/** SHA-256 over every input and home, so a drifted generator is told apart from a changed redaction. */
export function inputDigest(cases: readonly DifferentialCase[]): string {
  const hash = createHash("sha256");
  for (const c of cases) hash.update(`${c.input}\u0000${c.home ?? ""}\u0001`);
  return hash.digest("hex");
}
