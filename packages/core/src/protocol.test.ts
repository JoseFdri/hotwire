import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PutObjectCommand, GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import {
  INLINE_PAYLOAD_THRESHOLD_BYTES,
  fromBodyRef,
  gunzipJson,
  gzipJson,
  toBodyRef,
  type ScratchStore,
} from "./protocol.js";

class FakeS3Client {
  store = new Map<string, Buffer>();

  async send(command: unknown): Promise<unknown> {
    if (command instanceof PutObjectCommand) {
      this.store.set(command.input.Key!, Buffer.from(command.input.Body as Uint8Array));
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const data = this.store.get(command.input.Key!);
      if (!data) throw new Error(`FakeS3Client: no object at ${command.input.Key}`);
      return { Body: { transformToByteArray: async () => new Uint8Array(data) } };
    }
    throw new Error(`FakeS3Client: unsupported command ${String(command)}`);
  }
}

function fakeScratch(): { scratch: ScratchStore; s3: FakeS3Client } {
  const s3 = new FakeS3Client();
  return { scratch: { s3: s3 as unknown as S3Client, bucket: "test-bucket" }, s3 };
}

describe("gzipJson / gunzipJson", () => {
  it("round-trips arbitrary JSON values", () => {
    const value = { a: 1, b: [1, 2, 3], c: "hello", d: null, e: { nested: true } };
    expect(gunzipJson(gzipJson(value))).toEqual(value);
  });
});

describe("toBodyRef / fromBodyRef", () => {
  it("keeps small payloads inline and never touches S3", async () => {
    const { scratch, s3 } = fakeScratch();
    const gz = gzipJson({ hello: "world" });

    const ref = await toBodyRef(gz, scratch, "some/key");
    expect(ref.kind).toBe("inline");
    expect(s3.store.size).toBe(0);

    const back = await fromBodyRef(ref, scratch);
    expect(gunzipJson(back)).toEqual({ hello: "world" });
  });

  it("offloads payloads over the inline threshold to S3", async () => {
    const { scratch, s3 } = fakeScratch();
    // High-entropy hex data so gzip can't compress it below the inline threshold.
    const big = { data: randomBytes(INLINE_PAYLOAD_THRESHOLD_BYTES * 2).toString("hex") };
    const gz = gzipJson(big);
    expect(gz.length).toBeGreaterThan(INLINE_PAYLOAD_THRESHOLD_BYTES);

    const ref = await toBodyRef(gz, scratch, "some/key");
    expect(ref.kind).toBe("s3");
    expect(s3.store.size).toBe(1);

    const back = await fromBodyRef(ref, scratch);
    expect(gunzipJson(back)).toEqual(big);
  });
});
