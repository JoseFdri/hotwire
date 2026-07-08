import { join } from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { LiveFunction } from "../src/LiveFunction.js";

const FIXTURE_ENTRY = join(__dirname, "fixtures", "handler.ts");

function synth(live: boolean): { template: Template; fn: LiveFunction } {
  const app = new App({ context: live ? { "bifrost:live": "true" } : {} });
  const stack = new Stack(app, "TestStack", { env: { account: "123456789012", region: "us-east-1" } });
  const fn = new LiveFunction(stack, "MyFn", {
    entry: FIXTURE_ENTRY,
    handler: "handler",
    stage: "dev",
  });
  return { template: Template.fromStack(stack), fn };
}

describe("LiveFunction", () => {
  it("prod mode: deploys the real handler with no live-dev footprint", () => {
    const { template } = synth(false);

    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.not(Match.objectLike({ BIFROST_FUNCTION_ID: Match.anyValue() })),
      },
    });

    // No IoT permissions should be granted anywhere in the stack.
    const policies = template.findResources("AWS::IAM::Policy");
    for (const policy of Object.values(policies)) {
      const json = JSON.stringify(policy);
      expect(json).not.toContain("iot:Connect");
    }

    // No scratch bucket should exist.
    template.resourceCountIs("AWS::S3::Bucket", 0);
  });

  it("dev mode: deploys the stub with IoT wiring and a scratch bucket", () => {
    const { template } = synth(true);

    template.hasResourceProperties("AWS::Lambda::Function", {
      Timeout: 900,
      Environment: {
        Variables: Match.objectLike({
          BIFROST_APP: "TestStack",
          BIFROST_STAGE: "dev",
          BIFROST_FUNCTION_ID: "TestStack/MyFn",
        }),
      },
    });

    template.hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([Match.objectLike({ Action: "iot:Connect" })]),
        }),
      }),
    );

    template.resourceCountIs("AWS::S3::Bucket", 1);
  });

  it("dev mode: functionId is derived from the construct path", () => {
    const { fn } = synth(true);
    expect(fn.functionId).toBe("TestStack/MyFn");
  });
});
