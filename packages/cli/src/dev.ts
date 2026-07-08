import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DescribeEndpointCommand, IoTClient } from "@aws-sdk/client-iot";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { S3Client } from "@aws-sdk/client-s3";
import {
  connectIot,
  fromBodyRef,
  gunzipJson,
  gzipJson,
  responseTopic,
  scratchBucketName,
  scratchKey,
  toBodyRef,
  type LiveTransport,
  type RequestEnvelope,
  type ResponseEnvelope,
  type ScratchStore,
} from "@bifrost/core";
import { discoverLiveFunctions, type DiscoveredFunction } from "./discovery.js";
import { watchBundle, type HandlerBundle } from "./bundler.js";
import { createHandlerWorker, type HandlerWorker } from "./runtime.js";

export interface DevOptions {
  appDir: string;
  stage: string;
  region?: string;
}

interface RunningFunction {
  config: DiscoveredFunction;
  bundle: HandlerBundle;
  worker: HandlerWorker;
  scratch: ScratchStore;
}

export async function runDev(options: DevOptions): Promise<void> {
  console.log("bifrost: synthesizing CDK app to discover live functions...");
  const functions = await discoverLiveFunctions({ appDir: options.appDir, stage: options.stage });
  if (functions.length === 0) {
    console.log(
      "bifrost: no LiveFunction constructs found. Is your app synthesized with `-c bifrost:live=true`?",
    );
    return;
  }
  console.log(`bifrost: found ${functions.length} live function(s): ${functions.map((f) => f.functionId).join(", ")}`);

  const sts = new STSClient(options.region ? { region: options.region } : {});
  const region = options.region ?? (await sts.config.region());
  const { Account: account } = await sts.send(new GetCallerIdentityCommand({}));
  if (!account) throw new Error("bifrost: could not resolve the current AWS account (check your credentials)");

  const iot = new IoTClient({ region });
  const { endpointAddress } = await iot.send(new DescribeEndpointCommand({ endpointType: "iot:Data-ATS" }));
  if (!endpointAddress) throw new Error("bifrost: could not resolve the AWS IoT Core endpoint");

  console.log(`bifrost: connecting to IoT Core at ${endpointAddress}...`);
  const transport = await connectIot({
    endpoint: endpointAddress,
    region,
    clientId: `bifrost-cli-${process.pid}-${Date.now()}`,
  });

  const buildDir = await mkdtemp(join(tmpdir(), "bifrost-build-"));
  const running: RunningFunction[] = [];

  const shutdown = async () => {
    console.log("\nbifrost: shutting down...");
    await Promise.all(
      running.map(async (r) => {
        await transport.unsubscribe(r.config.requestTopic).catch(() => {});
        await r.bundle.stop().catch(() => {});
        await r.worker.terminate().catch(() => {});
      }),
    );
    await transport.close().catch(() => {});
    await rm(buildDir, { recursive: true, force: true }).catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  for (const config of functions) {
    const scratch: ScratchStore = {
      s3: new S3Client({ region }),
      bucket: scratchBucketName(account, region, config.appName, config.stage),
    };
    const outfile = join(buildDir, `${config.functionId.replace(/[^a-zA-Z0-9._-]/g, "_")}.mjs`);

    console.log(`[${config.functionId}] bundling ${config.entry}...`);
    const bundle = await watchBundle(config.entry, outfile, options.appDir);
    const worker = createHandlerWorker(outfile, config.handler);

    bundle.onRebuild(() => {
      console.log(`[${config.functionId}] rebuilt, restarting worker...`);
      worker.restart().catch((err) => console.error(`[${config.functionId}] failed to restart worker:`, err));
    });

    const entry: RunningFunction = { config, bundle, worker, scratch };
    running.push(entry);

    await transport.subscribe(config.requestTopic, (payload) => {
      handleRequest(transport, entry, payload).catch((err) => {
        console.error(`[${config.functionId}] error handling request:`, err);
      });
    });

    console.log(`[${config.functionId}] listening on ${config.requestTopic}`);
  }

  console.log("bifrost: ready. Waiting for invocations (Ctrl+C to stop)...");
}

async function handleRequest(transport: LiveTransport, entry: RunningFunction, payload: Buffer): Promise<void> {
  const { config, worker, scratch } = entry;
  const startedAt = Date.now();
  const envelope = JSON.parse(payload.toString("utf8")) as RequestEnvelope;

  const event = gunzipJson(await fromBodyRef(envelope.body, scratch));
  const result = await worker.invoke(event, {
    ...envelope.context,
    deadlineMs: envelope.deadlineMs,
  });

  const response: ResponseEnvelope = result.ok
    ? {
        v: 1,
        requestId: envelope.requestId,
        ok: true,
        body: await toBodyRef(gzipJson(result.result), scratch, scratchKey(envelope.requestId, "response")),
      }
    : { v: 1, requestId: envelope.requestId, ok: false, error: result.error };

  await transport.publish(
    responseTopic(config.appName, config.stage, config.functionId, envelope.requestId),
    Buffer.from(JSON.stringify(response), "utf8"),
  );

  const durationMs = Date.now() - startedAt;
  console.log(`[${config.functionId}] ${envelope.requestId} ${result.ok ? "ok" : "error"} in ${durationMs}ms`);
}
