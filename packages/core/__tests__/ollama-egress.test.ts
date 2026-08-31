/**
 * Tests for src/ollama-egress.ts — the shared loopback/opt-in guard (#124/#125),
 * plus its enforcement on the embedding provider (the #125 gap).
 *
 * Run: npx tsx --test packages/core/__tests__/ollama-egress.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { assertLocalOrOptIn } from "../src/ollama-egress.js";
import { OllamaEmbeddingProvider } from "../src/embeddings.js";

function withoutOptIn(fn: () => void): void {
  const prev = process.env.BASTRA_ALLOW_REMOTE_OLLAMA;
  delete process.env.BASTRA_ALLOW_REMOTE_OLLAMA;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.BASTRA_ALLOW_REMOTE_OLLAMA;
    else process.env.BASTRA_ALLOW_REMOTE_OLLAMA = prev;
  }
}

function withOptIn(fn: () => void): void {
  const prev = process.env.BASTRA_ALLOW_REMOTE_OLLAMA;
  process.env.BASTRA_ALLOW_REMOTE_OLLAMA = "1";
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.BASTRA_ALLOW_REMOTE_OLLAMA;
    else process.env.BASTRA_ALLOW_REMOTE_OLLAMA = prev;
  }
}

// ─── the guard itself (mirrors the reranker's #124 tests) ──────────

test("assertLocalOrOptIn allows loopback endpoints", () => {
  for (const u of ["http://localhost:11434", "http://127.0.0.1:11434", "http://[::1]:11434"]) {
    assert.doesNotThrow(() => assertLocalOrOptIn(u), `${u} should be allowed`);
  }
});

test("assertLocalOrOptIn refuses a non-loopback endpoint unless opted in", () => {
  withoutOptIn(() => {
    assert.throws(() => assertLocalOrOptIn("http://10.0.0.5:11434"), /non-loopback/);
  });
  withOptIn(() => {
    assert.doesNotThrow(() => assertLocalOrOptIn("http://10.0.0.5:11434"));
  });
});

test("assertLocalOrOptIn lets a malformed URL through (fetch reports it, behaviour unchanged)", () => {
  assert.doesNotThrow(() => assertLocalOrOptIn("not a url"));
});

// ─── the #125 gap: the embedding provider must enforce it too ──────

test("OllamaEmbeddingProvider: loopback baseURL (and the default) construct fine", () => {
  withoutOptIn(() => {
    assert.doesNotThrow(() => new OllamaEmbeddingProvider({}));
    assert.doesNotThrow(() => new OllamaEmbeddingProvider({ baseURL: "http://127.0.0.1:11434" }));
  });
});

test("OllamaEmbeddingProvider: a remote baseURL is refused unless opted in (#125)", () => {
  withoutOptIn(() => {
    assert.throws(() => new OllamaEmbeddingProvider({ baseURL: "http://10.0.0.5:11434" }), /non-loopback/);
  });
  withOptIn(() => {
    assert.doesNotThrow(() => new OllamaEmbeddingProvider({ baseURL: "http://10.0.0.5:11434" }));
  });
});

// ─── #365 item 8: the guard classifies the HOST, not a string prefix ──────
//
// `/^127\./` matched the hostname *text*, so every DNS name starting with
// "127." read as loopback. The table below is the measured behaviour of
// `new URL().hostname` + `net.isIP` — each row is one bypass or one
// false negative the prefix test produced.

/** Hostnames that merely LOOK like loopback — DNS names, resolvable anywhere. */
const SPOOFED_LOOPBACK = [
  "http://127.evil.example:11434",
  "http://127.0.0.1.evil.example:11434",
  "http://127.0.0.1.nip.io:11434",
  "http://127.0.0.1.example.com:11434",
  "http://localhost.evil.example:11434",
];

/** Genuinely local endpoints the prefix test refused. */
const REAL_LOOPBACK_MISSED = [
  "http://0.0.0.0:11434", // real OLLAMA_HOST value: bind-all, reaches this box
  "http://localhost.:11434", // RFC 1035 fully-qualified root dot
  "http://[::ffff:127.0.0.1]:11434", // IPv4-mapped IPv6 (Node folds it to ::ffff:7f00:1)
  "http://[::ffff:7f00:1]:11434", // …and its already-folded spelling
  "http://[0:0:0:0:0:ffff:127.0.0.1]:11434", // uncompressed mapped form
  "http://[::]:11434", // IPv6 bind-all
];

test("assertLocalOrOptIn refuses hostnames that only look like loopback (#365 item 8)", () => {
  withoutOptIn(() => {
    for (const u of SPOOFED_LOOPBACK) {
      assert.throws(() => assertLocalOrOptIn(u), /non-loopback/, `${u} must be refused`);
    }
  });
});

test("assertLocalOrOptIn allows the loopback forms the prefix test missed (#365 item 8)", () => {
  withoutOptIn(() => {
    for (const u of REAL_LOOPBACK_MISSED) {
      assert.doesNotThrow(() => assertLocalOrOptIn(u), `${u} should be allowed`);
    }
  });
});

test("assertLocalOrOptIn keeps allowing every loopback spelling it allowed before", () => {
  withoutOptIn(() => {
    for (const u of [
      "http://localhost:11434",
      "http://LOCALHOST:11434",
      "http://127.0.0.1:11434",
      "http://127.255.255.254:11434",
      "http://127.1:11434", // Node's URL parser normalises to 127.0.0.1
      "http://2130706433:11434", // …as it does the integer form
      "http://[::1]:11434",
    ]) {
      assert.doesNotThrow(() => assertLocalOrOptIn(u), `${u} should be allowed`);
    }
  });
});

test("assertLocalOrOptIn still refuses genuinely remote hosts, IPv6 included", () => {
  withoutOptIn(() => {
    for (const u of [
      "http://10.0.0.5:11434",
      "http://0.0.0.1:11434", // adjacent to the 0.0.0.0 exception, not local
      "http://[2001:db8::1]:11434",
      "http://[::ffff:169.254.1.1]:11434", // mapped, but not mapped loopback
      "http://ollama.localhost:11434", // RFC 6761 subdomain: resolver-dependent, opt-in only
    ]) {
      assert.throws(() => assertLocalOrOptIn(u), /non-loopback/, `${u} must be refused`);
    }
  });
});

test("the opt-in still overrides every refusal", () => {
  withOptIn(() => {
    for (const u of [...SPOOFED_LOOPBACK, "http://10.0.0.5:11434"]) {
      assert.doesNotThrow(() => assertLocalOrOptIn(u));
    }
  });
});

test("an unparseable host still falls through to fetch (documented, unchanged)", () => {
  withoutOptIn(() => {
    // 127.256.1.1 is not a valid IPv4 literal and Node rejects the whole URL.
    assert.doesNotThrow(() => assertLocalOrOptIn("http://127.256.1.1:11434"));
  });
});

test("OllamaEmbeddingProvider refuses a spoofed-loopback baseURL (#365 item 8)", () => {
  withoutOptIn(() => {
    assert.throws(
      () => new OllamaEmbeddingProvider({ baseURL: "http://127.0.0.1.nip.io:11434" }),
      /non-loopback/,
    );
    assert.doesNotThrow(() => new OllamaEmbeddingProvider({ baseURL: "http://0.0.0.0:11434" }));
  });
});
