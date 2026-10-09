/**
 * Which requests does the safe switch make for a given BASTRA_OLLAMA_URL?
 * (model-decision-delta.test.ts) Runs in its own process because ollama.ts
 * reads that variable once, at import. fetch is replaced: nothing leaves this
 * process. Prints one JSON line: the result and every request it tried.
 *
 * argv: configuredUrl settingsPath
 */
const [configured, settingsPath] = process.argv.slice(2);
process.env.BASTRA_OLLAMA_URL = configured;
const requests: { url: string; redirect: string }[] = [];
globalThis.fetch = (async (url: unknown, opts?: { redirect?: string }) => {
  requests.push({ url: String(url), redirect: opts?.redirect ?? "follow" });
  const body = String(url).includes("/api/version")
    ? { version: "fixture" }
    : String(url).includes("/api/tags")
      ? { models: [{ name: "new:4b" }] }
      : { message: { content: "ok" } };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { enableGenerationModel } = await import("../../src/cli/ollama.js");
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (() => true) as typeof process.stdout.write; // progress lines are not part of the answer
const result = await enableGenerationModel(
  "new:4b",
  { dryRun: false, verify: true, recommendationId: "fixture-rec" },
  settingsPath,
  { find: () => "/fake/bin/ollama", pull: () => { throw new Error("no pull in this fixture"); } },
);
write(JSON.stringify({ result, requests }) + "\n");
