#!/usr/bin/env node
import { resolve } from "node:path";
import { Command } from "commander";
import { runDev } from "./dev.js";

const program = new Command();

program.name("local-lambda").description("Live Lambda Dev for AWS CDK").version("0.0.0");

program
  .command("dev")
  .description("Run live functions locally, forwarding real invocations from deployed AWS resources")
  .requiredOption("--stage <stage>", "deployment stage (must match the stack you deployed with -c local-lambda:live=true)")
  .option("--app <dir>", "directory containing the CDK app", process.cwd())
  .option("--region <region>", "AWS region (defaults to your AWS config/credential chain)")
  .action(async (opts: { stage: string; app: string; region?: string }) => {
    try {
      await runDev({ appDir: resolve(opts.app), stage: opts.stage, region: opts.region });
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);
