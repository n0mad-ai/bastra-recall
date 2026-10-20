import { test } from "node:test";
import { strict as assert } from "node:assert";
import { actionServerUrl } from "../scripts/gpt-action-url.js";

test("accepts public domains and IPs, normalizes the API suffix", () => {
  for (const input of ["https://recall.example.com", "https://recall.example.com/", "https://recall.example.com/api/v1", "https://recall.example.com/api/v1/"]) {
    assert.equal(actionServerUrl(input), "https://recall.example.com/api/v1");
  }
  assert.equal(actionServerUrl("https://8.8.8.8:443"), "https://8.8.8.8/api/v1");
  assert.equal(actionServerUrl("https://[2606:4700:4700::1111]"), "https://[2606:4700:4700::1111]/api/v1");
});
test("rejects addresses a cloud Action cannot reach", () => {
  for (const host of ["localhost", "LOCALHOST.", "sub.localhost", "recall.local", "recall.lan", "recall.internal", "recall", "127.0.0.1", "127.1", "2130706433", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.5", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "[2::1]", "[::1]", "[::]", "[fd00::1]", "[fe80::1]", "[::ffff:127.0.0.1]"]) {
    assert.throws(() => actionServerUrl(`https://${host}`), /Localhost and LAN/, host);
  }
  assert.throws(() => actionServerUrl("http://recall.example.com"), /HTTPS/);
  assert.throws(() => actionServerUrl("https://recall.example.com:8443"), /port 443/);
  assert.throws(() => actionServerUrl("not a URL"), /HTTPS/);
});
test("never embeds credentials or token-bearing URL components", () => {
  for (const input of ["https://user:SECRET@recall.example.com", "https://recall.example.com?token=SECRET", "https://recall.example.com/#SECRET"]) {
    assert.throws(() => actionServerUrl(input), error => error instanceof Error && /Keep credentials/.test(error.message) && !error.message.includes("SECRET"));
  }
  assert.throws(() => actionServerUrl("https://recall.example.com/wrong/path"), /other paths/);
});
