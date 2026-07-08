import { gzipSync, gunzipSync } from "node:zlib";
import type { S3Client } from "@aws-sdk/client-s3";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

/**
 * AWS IoT Core caps a single MQTT publish (topic + payload) at 128 KB. We inline anything that
 * comfortably fits and offload everything else to S3, referencing it by key instead of chunking
 * across multiple MQTT messages (simpler, no reassembly/ordering to get wrong).
 */
export const INLINE_PAYLOAD_THRESHOLD_BYTES = 80 * 1024;

export type BodyRef =
  | { kind: "inline"; dataBase64: string }
  | { kind: "s3"; bucket: string; key: string };

export interface LambdaContextSubset {
  awsRequestId: string;
  functionName: string;
  functionVersion: string;
  invokedFunctionArn: string;
  memoryLimitInMB: string;
  logGroupName: string;
  logStreamName: string;
}

export interface RequestEnvelope {
  v: 1;
  requestId: string;
  functionId: string;
  /** Epoch ms after which the caller gives up waiting for a response. */
  deadlineMs: number;
  context: LambdaContextSubset;
  body: BodyRef;
}

export interface ResponseEnvelope {
  v: 1;
  requestId: string;
  ok: boolean;
  body?: BodyRef;
  error?: { message: string; name: string; stack?: string };
}

export function gzipJson(value: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(value), "utf8"));
}

export function gunzipJson<T>(buf: Buffer): T {
  return JSON.parse(gunzipSync(buf).toString("utf8")) as T;
}

export interface ScratchStore {
  s3: S3Client;
  bucket: string;
}

/** Wraps a gzip buffer as an inline or S3-backed BodyRef depending on size. */
export async function toBodyRef(
  gzipped: Buffer,
  scratch: ScratchStore,
  key: string,
): Promise<BodyRef> {
  if (gzipped.length <= INLINE_PAYLOAD_THRESHOLD_BYTES) {
    return { kind: "inline", dataBase64: gzipped.toString("base64") };
  }
  await scratch.s3.send(
    new PutObjectCommand({
      Bucket: scratch.bucket,
      Key: key,
      Body: gzipped,
      ContentType: "application/gzip",
    }),
  );
  return { kind: "s3", bucket: scratch.bucket, key };
}

/** Resolves a BodyRef back to its gzip buffer, fetching from S3 when necessary. */
export async function fromBodyRef(ref: BodyRef, scratch: ScratchStore): Promise<Buffer> {
  if (ref.kind === "inline") {
    return Buffer.from(ref.dataBase64, "base64");
  }
  const result = await scratch.s3.send(
    new GetObjectCommand({ Bucket: ref.bucket, Key: ref.key }),
  );
  const bytes = await result.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

export function topicPrefix(appName: string, stage: string): string {
  return `bifrost/${appName}/${stage}`;
}

export function requestTopic(appName: string, stage: string, functionId: string): string {
  return `${topicPrefix(appName, stage)}/${functionId}/request`;
}

export function responseTopic(
  appName: string,
  stage: string,
  functionId: string,
  requestId: string,
): string {
  return `${topicPrefix(appName, stage)}/${functionId}/response/${requestId}`;
}

export function responseTopicFilter(appName: string, stage: string, functionId: string): string {
  return `${topicPrefix(appName, stage)}/${functionId}/response/+`;
}

export function scratchKey(requestId: string, direction: "request" | "response"): string {
  return `bifrost/${requestId}/${direction}.json.gz`;
}
