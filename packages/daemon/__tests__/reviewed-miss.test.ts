import assert from "node:assert/strict";
import test from "node:test";
import { classifyReviewedMiss } from "../src/learned-recall/reviewed-miss.js";

test("a reviewed miss resolved by a vault memory can enter the existing bridge mint path", () => {
  assert.deepEqual(classifyReviewedMiss({
    kind: "reviewed-recall-miss/v1",
    review: "miss",
    query: "where is the deployment rail",
    resolution: { kind: "vault-memory", memoryId: "deploy-rail" },
  }), { kind: "bridge-reach", query: "where is the deployment rail", memoryId: "deploy-rail" });
});

test("an external source stays a curator note candidate", () => {
  assert.deepEqual(classifyReviewedMiss({
    kind: "reviewed-recall-miss/v1",
    review: "miss",
    query: "where is the deployment rail",
    resolution: { kind: "external-source", sourceRef: "sha256:0123456789abcdef" },
  }), { kind: "note-candidate", sourceRef: "sha256:0123456789abcdef", reason: "external-source-is-not-a-memory" });
});

test("unreviewed and path-bearing inputs fail closed", () => {
  assert.deepEqual(classifyReviewedMiss({
    kind: "reviewed-recall-miss/v1",
    review: "uncertain",
    query: "rail",
    resolution: { kind: "vault-memory", memoryId: "deploy-rail" },
  }), { kind: "reject", reason: "not-a-reviewed-miss" });
  assert.deepEqual(classifyReviewedMiss({
    kind: "reviewed-recall-miss/v1",
    review: "miss",
    query: "rail",
    resolution: { kind: "external-source", sourceRef: "/private/rail.md" },
  }), { kind: "reject", reason: "invalid-resolution" });
});
