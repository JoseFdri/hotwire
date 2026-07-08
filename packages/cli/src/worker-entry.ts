import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

interface WorkerContext {
  awsRequestId: string;
  functionName: string;
  functionVersion: string;
  invokedFunctionArn: string;
  memoryLimitInMB: string;
  logGroupName: string;
  logStreamName: string;
  deadlineMs: number;
}

interface InvokeMessage {
  type: "invoke";
  id: number;
  event: unknown;
  context: WorkerContext;
}

function buildLambdaContext(ctx: WorkerContext) {
  return {
    ...ctx,
    getRemainingTimeInMillis: () => Math.max(ctx.deadlineMs - Date.now(), 0),
    callbackWaitsForEmptyEventLoop: true,
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };
}

async function main(): Promise<void> {
  const { bundlePath, handlerName } = workerData as { bundlePath: string; handlerName: string };
  const mod = await import(pathToFileURL(bundlePath).href);
  const handlerFn = mod[handlerName] ?? mod.default?.[handlerName];
  if (typeof handlerFn !== "function") {
    throw new Error(`local-lambda: exported handler "${handlerName}" not found in ${bundlePath}`);
  }

  parentPort!.on("message", async (msg: InvokeMessage) => {
    if (msg.type !== "invoke") return;
    try {
      const result = await handlerFn(msg.event, buildLambdaContext(msg.context));
      parentPort!.postMessage({ type: "result", id: msg.id, ok: true, result });
    } catch (err) {
      const e = err as Error;
      parentPort!.postMessage({
        type: "result",
        id: msg.id,
        ok: false,
        error: { message: e?.message ?? String(err), name: e?.name ?? "Error", stack: e?.stack },
      });
    }
  });

  parentPort!.postMessage({ type: "ready" });
}

main().catch((err) => {
  const e = err as Error;
  parentPort?.postMessage({
    type: "fatal",
    error: { message: e?.message ?? String(err), name: e?.name ?? "Error", stack: e?.stack },
  });
});
