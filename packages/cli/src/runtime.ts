import { Worker } from "node:worker_threads";
import { join } from "node:path";

export interface WorkerContext {
  awsRequestId: string;
  functionName: string;
  functionVersion: string;
  invokedFunctionArn: string;
  memoryLimitInMB: string;
  logGroupName: string;
  logStreamName: string;
  deadlineMs: number;
}

export interface WorkerError {
  message: string;
  name: string;
  stack?: string;
}

export type WorkerResult = { ok: true; result: unknown } | { ok: false; error: WorkerError };

interface WorkerMessage {
  type: string;
  id?: number;
  ok?: boolean;
  result?: unknown;
  error?: WorkerError;
}

export interface HandlerWorker {
  invoke(event: unknown, context: WorkerContext): Promise<WorkerResult>;
  restart(): Promise<void>;
  terminate(): Promise<void>;
}

/** Runs a bundled handler in a worker thread; `restart()` tears down and respawns for hot reload. */
export function createHandlerWorker(bundlePath: string, handlerName: string): HandlerWorker {
  let worker: Worker;
  let ready: Promise<void>;
  let nextId = 1;
  const pending = new Map<number, (result: WorkerResult) => void>();

  function spawn() {
    worker = new Worker(join(__dirname, "worker-entry.js"), {
      workerData: { bundlePath, handlerName },
    });

    ready = new Promise((resolve) => {
      const onReady = (msg: { type: string }) => {
        if (msg.type === "ready") {
          worker.off("message", onReady);
          resolve();
        }
      };
      worker.on("message", onReady);
    });

    worker.on("message", (msg: WorkerMessage) => {
      if (msg.type !== "result" || msg.id === undefined) return;
      const resolve = pending.get(msg.id);
      if (!resolve) return;
      pending.delete(msg.id);
      resolve(msg.ok ? { ok: true, result: msg.result } : { ok: false, error: msg.error! });
    });

    worker.on("error", (err) => {
      for (const resolve of pending.values()) {
        resolve({ ok: false, error: { message: err.message, name: err.name, stack: err.stack } });
      }
      pending.clear();
    });
  }

  spawn();

  return {
    async invoke(event, context) {
      await ready;
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        worker.postMessage({ type: "invoke", id, event, context });
      });
    },
    async restart() {
      await worker.terminate();
      spawn();
      await ready;
    },
    async terminate() {
      await worker.terminate();
    },
  };
}
