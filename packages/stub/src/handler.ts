import type { Context, Handler } from "aws-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import {
  connectIot,
  fromBodyRef,
  gunzipJson,
  gzipJson,
  requestTopic,
  responseTopic,
  scratchKey,
  toBodyRef,
  type LiveTransport,
  type RequestEnvelope,
  type ResponseEnvelope,
} from "@local-lambda/core";

/**
 * Deployed in place of the real handler when a `LiveFunction` is synthesized in dev mode. Forwards
 * every invocation to whichever local CLI is currently subscribed, waits for the result, and
 * returns it — so callers (API Gateway, SQS, etc.) see a normal Lambda response.
 */

const RESPONSE_DEADLINE_BUFFER_MS = 1_500;

let transportPromise: Promise<LiveTransport> | undefined;

function getTransport(): Promise<LiveTransport> {
  if (!transportPromise) {
    transportPromise = connectIot({
      endpoint: requireEnv("LOCAL_LAMBDA_IOT_ENDPOINT"),
      region: process.env.LOCAL_LAMBDA_REGION,
      clientId: `stub-${process.env.AWS_LAMBDA_LOG_STREAM_NAME ?? Math.random().toString(36).slice(2)}`,
    }).catch((err) => {
      // Allow retry on the next invocation instead of caching a failed connection forever.
      transportPromise = undefined;
      throw err;
    });
  }
  return transportPromise;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`local-lambda stub: missing required env var ${name}`);
  return value;
}

export const handler: Handler = async (event, context: Context) => {
  const appName = requireEnv("LOCAL_LAMBDA_APP");
  const stage = requireEnv("LOCAL_LAMBDA_STAGE");
  const functionId = requireEnv("LOCAL_LAMBDA_FUNCTION_ID");
  const bucket = requireEnv("LOCAL_LAMBDA_SCRATCH_BUCKET");

  const scratch = { s3: new S3Client({}), bucket };
  const transport = await getTransport();

  const requestId = context.awsRequestId;
  const deadlineMs = Date.now() + Math.max(context.getRemainingTimeInMillis() - RESPONSE_DEADLINE_BUFFER_MS, 0);

  const body = await toBodyRef(gzipJson(event), scratch, scratchKey(requestId, "request"));
  const envelope: RequestEnvelope = {
    v: 1,
    requestId,
    functionId,
    deadlineMs,
    context: {
      awsRequestId: context.awsRequestId,
      functionName: context.functionName,
      functionVersion: context.functionVersion,
      invokedFunctionArn: context.invokedFunctionArn,
      memoryLimitInMB: context.memoryLimitInMB,
      logGroupName: context.logGroupName,
      logStreamName: context.logStreamName,
    },
    body,
  };

  const respTopic = responseTopic(appName, stage, functionId, requestId);

  const response = await new Promise<ResponseEnvelope>((resolve, reject) => {
    const timer = setTimeout(() => {
      transport.unsubscribe(respTopic).catch(() => {});
      reject(
        new Error(
          "local-lambda: no local dev session responded before the deadline. " +
            "Is `local-lambda dev` running and connected?",
        ),
      );
    }, Math.max(deadlineMs - Date.now(), 0));

    transport
      .subscribe(respTopic, (payload) => {
        clearTimeout(timer);
        transport.unsubscribe(respTopic).catch(() => {});
        try {
          resolve(JSON.parse(payload.toString("utf8")) as ResponseEnvelope);
        } catch (err) {
          reject(err);
        }
      })
      .then(() => transport.publish(requestTopic(appName, stage, functionId), Buffer.from(JSON.stringify(envelope), "utf8")))
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });

  if (!response.ok) {
    const err = new Error(response.error?.message ?? "local-lambda: handler failed");
    err.name = response.error?.name ?? "Error";
    if (response.error?.stack) err.stack = response.error.stack;
    throw err;
  }

  return gunzipJson(await fromBodyRef(response.body!, scratch));
};
