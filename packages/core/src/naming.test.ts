import { describe, expect, it } from "vitest";
import { scratchBucketName } from "./naming.js";

describe("scratchBucketName", () => {
  it("is deterministic for the same inputs", () => {
    const a = scratchBucketName("123456789012", "us-east-1", "MyApp", "dev");
    const b = scratchBucketName("123456789012", "us-east-1", "MyApp", "dev");
    expect(a).toBe(b);
  });

  it("differs across stages and apps", () => {
    const dev = scratchBucketName("123456789012", "us-east-1", "MyApp", "dev");
    const prod = scratchBucketName("123456789012", "us-east-1", "MyApp", "prod");
    expect(dev).not.toBe(prod);
  });

  it("produces a valid S3 bucket name", () => {
    const name = scratchBucketName("123456789012", "us-east-1", "My_Weird.App!!", "Dev Stage");
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^[a-z0-9-]+$/);
    expect(name.startsWith("-")).toBe(false);
    expect(name.endsWith("-")).toBe(false);
  });
});
