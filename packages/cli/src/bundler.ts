import * as esbuild from "esbuild";

export interface HandlerBundle {
  outfile: string;
  onRebuild(cb: () => void): void;
  stop(): Promise<void>;
}

/**
 * esbuild in watch mode, bundling a single handler entry to one ESM file. The first build
 * completes before this resolves; subsequent successful rebuilds fire `onRebuild` listeners so the
 * caller can respawn the worker running that handler.
 */
export async function watchBundle(entry: string, outfile: string, absWorkingDir: string): Promise<HandlerBundle> {
  const listeners = new Set<() => void>();
  let isFirstBuild = true;

  const ctx = await esbuild.context({
    entryPoints: [entry],
    outfile,
    absWorkingDir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    sourcemap: "inline",
    logLevel: "silent",
    plugins: [
      {
        name: "local-lambda-notify",
        setup(build) {
          build.onEnd((result) => {
            if (result.errors.length > 0) {
              console.error(`local-lambda: build error in ${entry}:`, result.errors);
              return;
            }
            if (isFirstBuild) {
              isFirstBuild = false;
              return;
            }
            for (const cb of listeners) cb();
          });
        },
      },
    ],
  });

  await ctx.rebuild();
  await ctx.watch();

  return {
    outfile,
    onRebuild(cb) {
      listeners.add(cb);
    },
    async stop() {
      await ctx.dispose();
    },
  };
}
