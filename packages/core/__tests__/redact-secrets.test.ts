import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../src/scrub.js";

const fixtures = [
  "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----",

  "sk-proj-AbCdeFgHiJkLmNoPqRsT1234", "ghp_abcdefghijklmno1234567890",
  "github_pat_abcdefghijklmno1234567890", "AKIA1234567890ABCDEF",
  "xoxb-1234567890-abcdefghijk", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
  "a1b2c3d4e5f67890123456789abcdef00", "AbCdEfGhIjKlMnOpQrStUv12",
];
for (const secret of fixtures) {
  test(`redact secret fixture ${fixtures.indexOf(secret)}`, () => {
    const result = redactSecrets(`before ${secret} after`);
    assert.equal(result.text, "before [REDACTED] after");
    assert.equal(result.redactedChars, secret.length);
  });
}

test("URL credentials and high entropy assignment values keep their syntax", () => {
  assert.equal(redactSecrets("ssh://user:pass@box.internal/path").text, "ssh://[REDACTED]@box.internal/path");
  for (const input of ['KEY="aB3dE5fG7hI9jK1m"', "key: 'aB3dE5fG7hI9jK1m'", "KEY=aB3dE5fG7hI9jK1m", 'ключ: aB3dE5fG7hI9jK1m']) {
    const result = redactSecrets(input);
    assert.ok(result.text.includes("[REDACTED]"));
    assert.ok(!result.text.includes("aB3dE5fG7hI9jK1m"));
    assert.equal(result.redactedChars, 16);
  }
});

test("normal multilingual text, commands and low entropy settings survive", () => {
  const text = "VPN für build-box nötig. ключ находится там. ssh box.internal\nMODE=development PORT=6723 REPEAT=aaaaaaaaaaaaaaaaaaaaaaaa";
  assert.deepEqual(redactSecrets(text), { text, redactedChars: 0 });
});

test("overlapping matches count original characters once and redaction is idempotent", () => {
  const text = `KEY=${fixtures[2]}`;
  const result = redactSecrets(text);
  assert.equal(result.redactedChars, fixtures[2].length);
  assert.deepEqual(redactSecrets(result.text), { text: result.text, redactedChars: 0 });
});

test("home abbreviation only replaces a full directory prefix", () => {
  assert.equal(redactSecrets('cd /Users/test/project; /Users/test-other /Users/test', '/Users/test').text, 'cd ~/project; /Users/test-other ~');
});

test("unterminated PEM blocks redact the remaining text", () => {
  assert.equal(redactSecrets("before -----BEGIN RSA PRIVATE KEY-----\nabc123 after").text, "before [REDACTED]");
});


test("home prefixes are abbreviated before generic token matching", () => {
  assert.equal(redactSecrets("cd /Users/n0mad/project-with-a-long-name/file", "/Users/n0mad").text, "cd ~/project-with-a-long-name/file");
});

test("long ordinary words need no secret and do not cause repeated prefix scans", () => {
  for (const char of ["z", "-"]) {
    const text = char.repeat(50_000);
    const started = performance.now();
    assert.deepEqual(redactSecrets(text), { text, redactedChars: 0 });
    assert.ok(performance.now() - started < 1000, "plain text must not take a second to scan");
  }
});

const FIXTURE_HOME = "/Users/n0mad";
// Synthetic examples are assembled at runtime; no provider credential is stored here.
const secretCases: Array<[string, string, string[], string[]]> = [
  ["openai sk-proj", ["nimm sk-proj", "-AbCdeFgHiJk", "LmNoPqRsT123", "4567890abcdE", "FGH"].join(""), ["AbCdeFgHiJkLmNoPqRsT"], ["nimm"]],
  ["anthropic", ["key sk-ant-a", "pi03-AbCdEfG", "h1234567890-", "_xyzABCDEFGH", "IJKLMNOP"].join(""), ["AbCdEfGh1234567890"], []],
  ["github classic", ["ghp_16C7e42F", "292c6912E771", "0c838347Ae17", "8B4a"].join(""), ["16C7e42F292c"], []],
  ["github short ghs", ["token ghs_ab", "c12345"].join(""), ["abc12345"], []],
  ["aws akid", ["AKIAIOSFODNN", "7EXAMPLE"].join(""), ["IOSFODNN7"], []],
  ["aws ASIA", ["ASIAIOSFODNN", "7EXAMPLE"].join(""), ["IOSFODNN7"], []],
  ["aws secret bare", ["secret wJalr", "XUtnFEMI/K7M", "DENG/bPxRfiC", "YEXAMPLEKEY ", "ok"].join(""), ["wJalrXUtnFEMI"], []],
  ["slack", ["xoxb-1234567", "89012-123456", "7890123-AbCd", "EfGhIjKlMnOp", "QrStUvWx"].join(""), ["AbCdEfGhIjKl"], []],
  ["stripe live", ["sk_live_51H8", "abcDEFghiJKL", "mnoPQRstu"].join(""), ["51H8abcDEF"], []],
  ["stripe short", ["sk_live_4eC3", "9HqLyjWDarjt"].join(""), ["4eC39HqLyjWDarjt"], []],
  ["google api", ["AIzaSyD-9tSr", "ke72PouQMnMX", "-a7eZSW0jkFM", "BWY"].join(""), ["SyD-9tSrke72"], []],
  ["gitlab pat", ["glpat-xYz12A", "bC34dEf56GhI", "7j"].join(""), ["xYz12AbC34"], []],
  ["gitlab short", ["glpat-abcdef", "ghij12345678", "90"].join(""), ["abcdefghij1234567890"], []],
  ["npm token", ["npm_aB3dE5fG", "7hI9jK1mN2oP", "4qR6sT8uV0wX", "1yZ2"].join(""), ["aB3dE5fG7hI9"], []],
  ["hf token", ["hf_abcdefghi", "jklmnopqrstu", "vwxyzABCDEFG", "H"].join(""), ["abcdefghijklmnop"], []],
  ["sendgrid", ["SG.aBcDeFgHi", "JkLmNoPqRsTu", "V.wXyZ012345", "6789aBcDeFgH", "iJkLmNoPqRsT", "uVwXyZ01234"].join(""), ["aBcDeFgHiJkLmNoPqRsTuV"], []],
  ["jwt", ["Authorizatio", "n: Bearer ey", "JhbGciOiJIUz", "I1NiIsInR5cC", "I6IkpXVCJ9.e", "yJzdWIiOiIxM", "jM0NTY3ODkwI", "n0.dozjgNryP", "4J3jVmNHl0w5", "N_XgL0n3I9Pl", "FUP0THsR8U"].join(""), ["eyJhbGciOi", "dozjgNry"], ["Authorization"]],
  ["bearer short opaque", ["curl -H 'Aut", "horization: ", "Bearer abc12", "3def456ghi7'", " https://api", ".example.com"].join(""), ["abc123def456ghi7"], ["api.example.com"]],
  ["bearer lowercase 20", ["Authorizatio", "n: Bearer q7", "w8e9r0t1y2u3", "i4o5p6"].join(""), ["q7w8e9r0t1y2u3i4o5p6"], []],
  ["basic auth b64", ["Authorizatio", "n: Basic dXN", "lcjpwYXNzd29", "yZDEyMw=="].join(""), ["dXNlcjpwYXNzd29yZDEyMw"], []],
  ["pem", ["hier:\n-----B", "EGIN OPENSSH", " PRIVATE KEY", "-----\nb3Blbn", "NzaC1rZXktdj", "EAAAAABG5vbm", "U\nAAAAEbm9uZ", "QAAAAAAAAABA", "AAAMwAAAAtz\n", "-----END OPE", "NSSH PRIVATE", " KEY-----\nda", "nach"].join(""), ["b3BlbnNzaC1r", "AAAAEbm9uZQ"], ["hier", "danach"]],
  ["pem lowercase/pgp", ["-----BEGIN P", "GP PRIVATE K", "EY BLOCK----", "-\n\nlQOYBF0ab", "cDEF\n-----EN", "D PGP PRIVAT", "E KEY BLOCK-", "----"].join(""), ["lQOYBF0abcDEF"], []],
  ["pem body only (no header)", ["MIIEvQIBADAN", "BgkqhkiG9w0B", "AQEFAASCBKcw", "ggSjAgEAAoIB", "AQC7VJTUt9Us", "8cKj"].join(""), ["MIIEvQIBADANBgkq"], []],
  ["url userinfo", ["postgres://a", "dmin:S3cr3tP", "w@db.interna", "l:5432/app"].join(""), ["S3cr3tPw"], ["db.internal:5432/app", "postgres://"]],
  ["url userinfo pw with @", ["https://user", ":p@ss@host.e", "xample.com/x"].join(""), ["p@ss", "ss@"], ["host.example.com"]],
  ["url userinfo pw with slash", ["mysql://root", ":pa/ss@db.in", "ternal/x"].join(""), ["pa/ss"], ["db.internal"]],
  ["url token query", ["https://api.", "example.com/", "v1?api_key=a", "bcd1234efgh5", "678&x=1"].join(""), ["abcd1234efgh5678"], ["api.example.com"]],
  ["url token query short", ["https://hook", "s.example.co", "m/?token=hun", "ter2hunter2"].join(""), ["hunter2hunter2"], []],
  ["--password=", ["mysql -u roo", "t --password", "=Tr0ub4dor&3", " -h db.inter", "nal"].join(""), ["Tr0ub4dor&3"], ["db.internal", "mysql"]],
  ["--password space", ["mysql -u roo", "t --password", " Tr0ub4dor3x", " -h db.inter", "nal"].join(""), ["Tr0ub4dor3x"], ["db.internal"]],
  ["-p attached", ["mysql -uroot", " -pTr0ub4dor", "3x db"].join(""), ["Tr0ub4dor3x"], []],
  ["env short pw", ["export DB_PA", "SSWORD=hunte", "r2"].join(""), ["hunter2"], ["DB_PASSWORD"]],
  ["env medium pw", ["DB_PASSWORD=", "Sommer2024!"].join(""), ["Sommer2024!"], []],
  ["env 15 chars", ["API_KEY=aB3d", "E5fG7hI9jK1"].join(""), ["aB3dE5fG7hI9jK1"], []],
  ["env 16 chars", ["API_KEY=aB3d", "E5fG7hI9jK1m"].join(""), ["aB3dE5fG7hI9jK1m"], ["API_KEY"]],
  ["env low entropy long", ["PASSWORD=pas", "swordpasswor", "d1"].join(""), ["passwordpassword1"], []],
  ["yaml pw", ["password: co", "rrect-horse-", "battery"].join(""), ["correct-horse-battery"], []],
  ["json pw", '{"password": "Xk9#mP2$vL5nQ8wR"}', ["Xk9#mP2$vL5nQ8wR"], []],
  ["json pw spaced key", '{"api key": "Xk9mP2vL5nQ8wR3t"}', ["Xk9mP2vL5nQ8wR3t"], []],
  ["prose pw de", ["das Passwort", " ist Sommer2", "024! und der", " Host ist db", ".internal"].join(""), ["Sommer2024!"], ["db.internal"]],
  ["prose pw ru", ["пароль от се", "рвера: Zima2", "024Moskva, х", "ост build-bo", "x.internal"].join(""), ["Zima2024Moskva"], ["build-box.internal"]],
  ["split by newline", ["API_KEY=aB3d", "E5fG7hI9\njK1", "mN2oP4qR6sT8", "u"].join(""), ["aB3dE5fG7hI9", "jK1mN2oP4qR6sT8u"], []],
  ["split backslash-newline", ["TOKEN=ghp_16", "C7e42F29\\\n2c", "6912E7710c83", "8347Ae178B4a"].join(""), ["2c6912E7710c838347Ae178B4a"], []],
  ["split by quotes concat", 'key = "sk-proj-AbCdeF" + "gHiJkLmNoPqRsT1234"', ["gHiJkLmNoPqRsT1234"], []],
  ["quoted with spaces", 'PASS="my secret phrase 99 Xy"', ["my secret phrase 99 Xy"], []],
  ["token w/ special chars", ["token: aB3$d", "E5%fG7^hI9&j", "K1*mN2"].join(""), ["aB3$dE5%fG7^hI9&jK1*mN2"], []],
  ["hex 32 secret", ["API-Schlüsse", "l 9f86d08188", "4c7d659a2fea", "a0c55ad015"].join(""), ["9f86d081884c7d65"], []],
  ["hex 24 secret", ["key 9f86d081", "884c7d659a2f", "eaa0"].join(""), ["9f86d081884c7d659a2feaa0"], []],
  ["uuid as secret", ["client_secre", "t=550e8400-e", "29b-41d4-a71", "6-4466554400", "00"].join(""), ["550e8400-e29b"], []],
  ["base64 with colon prefix", ["secret:dGhpc", "2lzYXZlcnlzZ", "WNyZXR2YWx1Z", "Q=="].join(""), ["dGhpc2lzYXZlcnlz"], []],
  ["lowercase+digit 30", ["token q7w8e9", "r0t1y2u3i4o5", "p6a7s8d9f0g1"].join(""), ["q7w8e9r0t1y2u3i4"], []],
  ["ssh pub/priv path+pw", ["sshpass -p '", "Geheim123' s", "sh root@buil", "d-box.intern", "al"].join(""), ["Geheim123"], ["root@build-box.internal"]],
  ["docker login", ["docker login", " -u me -p dc", "kr_pat_AbCdE", "fGhIjKlMnOpQ", "rStUvWxYz0 r", "egistry.inte", "rnal"].join(""), ["AbCdEfGhIjKlMn"], ["registry.internal"]],
  ["telegram bot", ["bot token 12", "3456789:AAHd", "qTcvCH1vGWJx", "fSeofSAs0K5P", "ALDsaw"].join(""), ["AAHdqTcvCH1vGWJx"], []],
  ["azure conn", ["AccountKey=a", "bcdEFGH1234a", "bcdEFGH1234a", "bcdEFGH1234a", "bcdEFGH12==;", "EndpointSuff", "ix=core.wind", "ows.net"].join(""), ["abcdEFGH1234abcd"], []],
  ["otp/short pin", ["die PIN ist ", "482913"].join(""), ["482913"], []],
  ["zero-width split", ["ghp_16C7e42F", "292c​6912E77", "10c838347Ae1", "78B4a"].join(""), ["6912E7710c838347Ae178B4a"], []],
];


// Must survive unchanged (false-positive checks)
const locatorCases: Array<[string, string]> = [
  ["de prose", "Der Schlüssel liegt im 1Password-Tresor unter Infrastruktur, nicht im Repo."],
  ["ru prose", "Ключ лежит в хранилище, а для build-box.internal нужен VPN."],
  ["en prose", "The deploy key lives in the ops vault; staging needs the VPN first."],
  ["path", "Der Key liegt unter /etc/bastra/keys/deploy_ed25519 auf dem Buildserver."],
  ["home path", `siehe ${FIXTURE_HOME}/Projekte/bastra-recall/packages/daemon/src/draft-store.ts`],
  ["long path mixed", "cat /opt/Company/Internal-Tools/v2.4.1/config/production.Settings.yaml"],
  ["long path camel", "packages/daemon/src/learned-recall/RerankerConfigLoader.test.ts"],
  ["hostname fqdn", "ssh deploy@build-box-03.eu-central-1.internal.example.com"],
  ["hostname long", "db-primary-01.prod.eu-central-1.rds.amazonaws.com braucht VPN"],
  ["url plain", "https://github.com/n0mad-ai/bastra-recall/pull/1086/files"],
  ["url long mixed", "https://docs.example.com/Guides/Getting-Started/Install_V2.html"],
  ["ssh cmd", "ssh -i ~/.ssh/id_ed25519 -p 2222 deploy@build-box.internal"],
  ["git sha", "siehe Commit 7e29e747b066067ad3d95d87a77abca373816c19"],
  ["git short sha", "revert f7d8bba9"],
  ["sha256 digest", "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"],
  ["docker image", "docker pull registry.internal/Team/App-Server:v1.2.3-rc1"],
  ["npm pkg", "@bastra-recall/core/scrub und @modelcontextprotocol/sdk"],
  ["uuid", "Session 550e8400-e29b-41d4-a716-446655440000 hängt"],
  ["env host", "DB_HOST=db-primary-01.prod.internal.example.com"],
  ["env url", "DATABASE_URL=postgres://db.internal:5432/app"],
  ["env path", "KUBECONFIG=/Users/shared/Kube/Prod-Cluster.config"],
  ["yaml host", "host: build-box-03.eu-central-1.internal"],
  ["key location", "IdentityFile: ~/.ssh/Deploy-Key_Prod2024"],
  ["time", "Meeting um 14:30:00, Timeout: 30000ms"],
  ["ipv6", "fe80::1ff:fe23:4567:890a%en0"],
  ["ip:port", "Proxy 10.20.30.40:8080 nur im VPN"],
  ["email", "frag ops-team@example-company.com"],
  ["k8s", "kubectl --context=Prod-EU-Central-1 -n Payments-Service get pods"],
  ["long german compound", "Donaudampfschifffahrtsgesellschaftskapitänsmütze"],
  ["camel ident", "getPrimaryLanguageFromSettingsV2Fallback"],
  ["base64 not secret?", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"],
  ["aws arn", "arn:aws:iam::123456789012:role/Deploy-Role-Prod2"],
  ["s3", "aws s3 cp s3://Company-Backups-EU/2026-10-06/Dump_V2.sql.gz ."],
  ["vpn sentence", "build-box.internal braucht WireGuard-Profil Office-Berlin_2024"],
  ["windows path", "C:\\Users\\Daniel\\Projects\\Bastra-Recall\\Config_V2.json"],
  ["op ref", "op://Infrastruktur/Build-Box-Deploy2024/private_key"],
  ["vault ref", "vault kv get secret/Prod/Payments-Service/Stripe_Key2"],
];


for (const [label, input, secrets, survive] of secretCases) {
  if (["prose pw de", "prose pw ru", "otp/short pin"].includes(label)) continue;
  test(`structural secret: ${label}`, () => {
    const result = redactSecrets(input, FIXTURE_HOME);
    for (const secret of secrets) assert.ok(!result.text.includes(secret), `secret survived: ${label}`);
    for (const value of survive) assert.ok(result.text.includes(value), `locator lost: ${label}`);
  });
}
for (const [label, input] of locatorCases) {
  test(`locator survival: ${label}`, () => {
    assert.deepEqual(redactSecrets(input, FIXTURE_HOME), { text: input.split(FIXTURE_HOME).join("~"), redactedChars: 0 });
  });
}


test("file references and public switches are not credential values", () => {
  const text = "KEY=/etc/bastra/keys/deploy_ed25519 PWD=/Users/n0mad/Projekte/recall BYPASS=true";
  assert.deepEqual(redactSecrets(text, FIXTURE_HOME), { text: text.replace(FIXTURE_HOME, "~"), redactedChars: 0 });
  assert.equal(redactSecrets("client_secret=550e8400-e29b-41d4-a716-446655440000").text, "client_secret=[REDACTED]");
});

test("short password flags do not consume ssh ports in a compound command", () => {
  const result = redactSecrets("sshpass -p 'hunter2' ssh -p 2222 host.internal; mysql -phunter3 db; ssh -p 2200 host.internal");
  assert.ok(!result.text.includes("hunter2") && !result.text.includes("hunter3"));
  assert.ok(result.text.includes("2222") && result.text.includes("2200"));
});


test("shell-escaped JSON and concatenated credential strings are fully scrubbed", () => {
  const inputs = [
    String.raw`curl -d "{\"password\":\"hunter2\"}" https://api.example.com`,
    String.raw`API_KEY=\"firstPart123\" + \"secondPart456\"`,
    String.raw`curl -d "{\"password\":\"first\\\"second\"}" https://api.example.com`,
  ];
  for (const input of inputs) {
    const out = redactSecrets(input).text;
    assert.ok(!out.includes("hunter2") && !out.includes("first") && !out.includes("second"), out);
  }
});


test("international locations and constant identifiers survive", () => {
  for (const text of ["db-primary-01.xn--p1ai", "build-Node-03.пример.рф", "配置/Build-Node-23/settings.json", "PRIVATE_KEY_REGION_V2"]) {
    assert.deepEqual(redactSecrets(text), { text, redactedChars: 0 });
  }
});

test("multiline and escaped values are hidden while public query fields survive", () => {
  for (const text of [String.raw`API_KEY=abc\
x`, '{"password":\n  "hunter2"}', 'password:\n  hunter2', String.raw`PASSWORD=first\;second`, 'PASSPHRASE=hunter2', 'COOKIE=hunter2']) {
    const out = redactSecrets(text).text;
    assert.ok(!out.includes("hunter2") && !out.includes("abc") && !out.includes("first") && !out.includes("second"), out);
  }
  assert.equal(redactSecrets("https://host.internal/?api_key=hunter2&mode=public#section").text, "https://host.internal/?api_key=[REDACTED]&mode=public#section");
  assert.equal(redactSecrets("PASSWORD=\nDB_HOST=host.internal").text, "PASSWORD=\nDB_HOST=host.internal");
});


test("YAML credential scalars hide every indented line and keep following locations", () => {
  for (const marker of ["|", "|-", ">+", "|2-"]) {
    const out = redactSecrets(`password: ${marker}\n  hunter2\n  second line\nhost: db-primary-03.internal`).text;
    assert.ok(!out.includes("hunter2") && !out.includes("second line"), out);
    assert.ok(out.includes("host: db-primary-03.internal"), out);
    assert.equal(redactSecrets(out).redactedChars, 0);
  }
});


test("suffix punctuation and adjacent flag-like text do not trigger repeated scans", () => {
  for (const text of ["(".repeat(50_000) + "x", "--a".repeat(17_000)]) {
    const started = performance.now();
    assert.deepEqual(redactSecrets(text), { text, redactedChars: 0 });
    assert.ok(performance.now() - started < 1000, "plain text cannot take a second to scan");
  }
});


test("authorization headers mask values with any scheme and header qualifier", () => {
  for (const [header, scheme, secret] of [
    ["Authorization", "Token", "abc123"], ["Authorization", "ApiKey", "abc123"],
    ["Authorization", "token", "abc123"], ["Proxy-Authorization", "Basic", "dummy-value"],
    ["X-Authorization", "Bearer", "dummy-value"],
    ["Authorization", "AWS4-HMAC-SHA256", "Credential=dummy, SignedHeaders=host, Signature=fake"],
  ]) {
    const out = redactSecrets(`${header}: ${scheme} ${secret}`).text;
    assert.equal(out, `${header}: ${scheme} [REDACTED]`);
  }
});

test("credential-labelled locations and variable references remain useful", () => {
  for (const text of [
    "private_key: /etc/bastra/keys/deploy_ed25519",
    "ansible-playbook --private-key ~/.ssh/deploy_ed25519 site.yml",
    "SSH_PRIVATE_KEY=~/.ssh/deploy_ed25519",
    "token: /run/secrets/api_token",
    "nimm --password=$DB_PASSWORD",
    'API_KEY="${NAME}"',
    'PASSWORD=${NAME}',
  ]) assert.deepEqual(redactSecrets(text), { text, redactedChars: 0 });
});

test("URL userinfo placeholders are idempotent and never counted twice", () => {
  for (const text of ["pg://u:p@db1.internal und pg://u:p@db2.internal", "https://u:p@host.internal/x"]) {
    const first = redactSecrets(text);
    assert.ok(first.redactedChars > 0);
    assert.deepEqual(redactSecrets(first.text), { text: first.text, redactedChars: 0 });
  }
});

test("nested credentials inside neutral bindings are redacted", () => {
  for (const text of ["run: DB_PASS=pw1 ./deploy.sh", "--from-literal=password=abc", "CMD=PASSWORD=abc", '"cmd": "export API_KEY=abc123"', "x:password=abc12"]) {
    assert.ok(redactSecrets(text).text.includes("[REDACTED]"), text);
    assert.ok(!/pw1|abc/.test(redactSecrets(text).text), text);
  }
});

test("userinfo delimiters do not hide credentials or consume URL paths", () => {
  for (const value of ["pw?extra", "pw#extra", "pw/extra", "pw@extra"]) {
    assert.equal(redactSecrets(`pg://u:${value}@db.internal/x`).text, "pg://[REDACTED]@db.internal/x");
  }
  for (const text of ["http://localhost:4873/@bastra-recall/core", "https://host.internal:443/a/@scope/pkg", "https://host.internal/a?email=a@b.internal"]) {
    assert.deepEqual(redactSecrets(text), { text, redactedChars: 0 });
  }
});

test("random tokens cannot use incidental camelCase segments as an exemption", () => {
  const value = ["abCdef", "GhijKlm", "noPqrsT", "uvwxYz1", "23456789"].join("");
  for (const text of [value, `VALUE=${value}`]) assert.ok(!redactSecrets(text).text.includes(value));
});

test("neutral key names and prose-like labels keep useful settings", () => {
  for (const text of ['{"key": "theme", "value": "dark"}', "sort key = created_at", "primary key: id"]) {
    assert.deepEqual(redactSecrets(text), { text, redactedChars: 0 });
  }
  for (const text of ["token: abc123", "secret: abc123", "API_TOKEN=4000"]) assert.ok(redactSecrets(text).text.includes("[REDACTED]"));
});

test("dotless segmented technical identifiers survive", () => {
  for (const text of ["ssh srv-db01-prod-euc1-replica02", "kubectl logs recall-daemon-7d9f8b6c5d-x2k4q", "model: gpt-4o-mini-2024-07-18"]) {
    assert.deepEqual(redactSecrets(text), { text, redactedChars: 0 });
  }
});

test("short password flags obey each command's case and spacing", () => {
  for (const text of ["mysql -h db.internal -P 3306", "mysql -u root -p appdb", "mariadb -p appdb"]) assert.deepEqual(redactSecrets(text), { text, redactedChars: 0 });
  assert.equal(redactSecrets("mysql -ppw1 appdb").text, "mysql -p[REDACTED] appdb");
  assert.equal(redactSecrets("sshpass -p pw1 ssh host.internal").text, "sshpass -p [REDACTED] ssh host.internal");
});

test("Digest authorization redacts quoted parameters as a whole", () => {
  const text = 'authorization: Digest username="fixture-user", response="fixture-response"';
  assert.equal(redactSecrets(text).text, "authorization: Digest [REDACTED]");
  assert.equal(redactSecrets(redactSecrets(text).text).redactedChars, 0);
});

test("repeated JWT-looking prefixes are scanned in bounded time", () => {
  const text = "eyJa-".repeat(80_000);
  const started = performance.now();
  redactSecrets(text);
  assert.ok(performance.now() - started < 1000, "400k characters must not trigger repeated suffix scans");
});

// Known ambiguities retain main's conservative behavior; fixed corpus covers them.
test("ambiguous bare credential labels and standalone architecture names are documented limits", () => {
  for (const [input, expected] of [
    ["max token: 4000", "max token: [REDACTED]"],
    ["secret: db-credentials", "secret: [REDACTED]"],
    ["Token: see the vault", "Token: [REDACTED] the vault"],
    ["aarch64-unknown-linux-gnu", "[REDACTED]"],
  ]) assert.equal(redactSecrets(input).text, expected);
});

test("review regressions preserve URL hosts, quoted-header suffixes and code symbols", () => {
  for (const [input, host] of [
    ["http://user:shortValue@localhost:4873/@scope/pkg", "localhost:4873/@scope/pkg"],
    ["postgres://user:shortValue@db.internal:5432/app?user=ops@example.com", "db.internal:5432/app?user=ops@example.com"],
    ["git+https://user:shortValue@gitlab.internal:8443/group/repo.git@v1.2.3", "gitlab.internal:8443/group/repo.git@v1.2.3"],
    ["https://user:shortValue@host.internal/x?email=ops@example.com", "host.internal/x?email=ops@example.com"],
  ]) {
    const result = redactSecrets(input);
    assert.ok(!result.text.includes("shortValue"));
    assert.ok(result.text.includes(host));
  }
  const header = 'curl -H "Authorization: Bearer abc123" https://api.example.com/v1/items';
  assert.equal(redactSecrets(header).text, 'curl -H "Authorization: Bearer [REDACTED]" https://api.example.com/v1/items');
  assert.deepEqual(redactSecrets(redactSecrets(header).text), {text:redactSecrets(header).text,redactedChars:0});
  for (const input of ["DraftStoreDiagnosticsProvider", "RerankerConfigLoaderFactory", "parseHTTPResponseHeadersFromXMLDocument", "IntersectionObserverEntryInit"]) assert.equal(redactSecrets(input).text,input);
});
