import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface DiscoveredFunction {
  functionId: string;
  entry: string;
  handler: string;
  appName: string;
  stage: string;
  requestTopic: string;
}

export interface SynthOptions {
  appDir: string;
  stage: string;
  context?: Record<string, string>;
}

interface TreeNode {
  id: string;
  path: string;
  attributes?: Record<string, unknown>;
  children?: Record<string, TreeNode>;
}

/** Runs `cdk synth -c bifrost:live=true` and reads discovery attributes back out of tree.json. */
export async function discoverLiveFunctions(options: SynthOptions): Promise<DiscoveredFunction[]> {
  const outDir = await mkdtemp(join(tmpdir(), "bifrost-synth-"));
  try {
    await runCdkSynth(options, outDir);
    const treePath = join(outDir, "tree.json");
    if (!existsSync(treePath)) {
      throw new Error(`bifrost: cdk synth did not produce tree.json in ${outDir}`);
    }
    const tree = JSON.parse(await readFile(treePath, "utf8")) as { tree: TreeNode };
    const found: DiscoveredFunction[] = [];
    walk(tree.tree, found);
    return found;
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

function walk(node: TreeNode, found: DiscoveredFunction[]): void {
  const attr = node.attributes?.["bifrost:function"];
  if (attr) found.push(attr as DiscoveredFunction);
  for (const child of Object.values(node.children ?? {})) {
    walk(child, found);
  }
}

function runCdkSynth(options: SynthOptions, outDir: string): Promise<void> {
  const cdkBin = resolveCdkBin(options.appDir);
  const args = [
    ...cdkBin.prefixArgs,
    "synth",
    "--quiet",
    "-o",
    outDir,
    "-c",
    "bifrost:live=true",
    "-c",
    `stage=${options.stage}`,
  ];
  for (const [k, v] of Object.entries(options.context ?? {})) {
    args.push("-c", `${k}=${v}`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(cdkBin.cmd, args, {
      cwd: options.appDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`bifrost: cdk synth failed (exit ${code}):\n${stderr}`));
    });
  });
}

function resolveCdkBin(appDir: string): { cmd: string; prefixArgs: string[] } {
  const binName = process.platform === "win32" ? "cdk.cmd" : "cdk";
  const localBin = join(appDir, "node_modules", ".bin", binName);
  if (existsSync(localBin)) return { cmd: localBin, prefixArgs: [] };
  return { cmd: "npx", prefixArgs: ["--yes", "cdk"] };
}
