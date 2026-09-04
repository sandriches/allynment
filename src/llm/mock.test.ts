import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLlmClient, StaticLlmClient } from "./mock.js";
import type { LlmRequest } from "./client.js";

const req: LlmRequest = { purpose: "test-purpose", system: "sys", user: "hello" };

describe("MockLlmClient", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spec-drift-mock-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws on a missing recording instead of hitting the network", async () => {
    const mock = new MockLlmClient(dir);
    await expect(mock.complete(req)).rejects.toThrow(/no recording/);
  });

  it("records a response and replays it", async () => {
    const mock = new MockLlmClient(dir);
    const recorder = mock.record(new StaticLlmClient(() => '{"ok":true}'));

    const live = await recorder.complete(req);
    expect(live.text).toBe('{"ok":true}');

    const replayed = await mock.complete(req);
    expect(replayed).toEqual(live);
  });

  it("keys recordings on the full request, so a changed prompt misses", async () => {
    const mock = new MockLlmClient(dir);
    await mock.record(new StaticLlmClient(() => "a")).complete(req);
    await expect(mock.complete({ ...req, user: "different" })).rejects.toThrow(/no recording/);
  });

  it("produces a stable key for identical requests", () => {
    expect(MockLlmClient.keyFor(req)).toBe(MockLlmClient.keyFor({ ...req }));
    expect(MockLlmClient.keyFor(req)).not.toBe(MockLlmClient.keyFor({ ...req, purpose: "other" }));
  });
});
