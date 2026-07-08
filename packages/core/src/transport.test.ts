import { describe, expect, it } from "vitest";
import { topicMatches } from "./transport.js";

describe("topicMatches", () => {
  it("matches exact topics", () => {
    expect(topicMatches("a/b/c", "a/b/c")).toBe(true);
    expect(topicMatches("a/b/c", "a/b/d")).toBe(false);
    expect(topicMatches("a/b/c", "a/b")).toBe(false);
  });

  it("matches single-level wildcard +", () => {
    expect(topicMatches("a/+/c", "a/xyz/c")).toBe(true);
    expect(topicMatches("a/+/c", "a/xyz/zzz/c")).toBe(false);
    expect(topicMatches("a/+/c", "a/c")).toBe(false);
  });

  it("matches multi-level wildcard #", () => {
    expect(topicMatches("a/#", "a/b/c/d")).toBe(true);
    expect(topicMatches("a/#", "a")).toBe(true);
    expect(topicMatches("a/#", "b/c")).toBe(false);
  });
});
