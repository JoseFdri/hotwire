import { Duration, Stack, type IInspectable, type TreeInspector } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import { requestTopic } from "@local-lambda/core";
import { isLiveMode, LiveApp, resolveStubEntry } from "./LiveApp.js";

export interface LiveFunctionProps extends Omit<nodejs.NodejsFunctionProps, "code"> {
  /** Path to the real handler's source file, e.g. `functions/orders.ts`. */
  entry: string;
  /** Stage name, used to namespace IoT topics so multiple stages/developers don't collide. */
  stage: string;
  /** Logical app name for topic namespacing. Defaults to the enclosing stack name. */
  appName?: string;
}

function sanitizeTopicSegment(nodePath: string): string {
  return nodePath.replace(/[+#\0]/g, "-");
}

/**
 * Drop-in replacement for `NodejsFunction`. In normal deploys it behaves identically. When
 * synthesized with `-c local-lambda:live=true`, it instead deploys a thin stub that forwards each
 * invocation to whichever local `local-lambda dev` session is connected, so the real handler runs
 * on the developer's machine against live source.
 */
export class LiveFunction extends Construct implements IInspectable {
  readonly function: nodejs.NodejsFunction;
  readonly functionId: string;
  private readonly discoveryAttributes?: Record<string, string>;

  constructor(scope: Construct, id: string, props: LiveFunctionProps) {
    super(scope, id);

    this.functionId = sanitizeTopicSegment(this.node.path);

    if (!isLiveMode(this)) {
      this.function = new nodejs.NodejsFunction(this, "Function", props);
      return;
    }

    const liveApp = LiveApp.getOrCreate(this, { stage: props.stage, appName: props.appName });

    this.function = new nodejs.NodejsFunction(this, "Function", {
      ...props,
      entry: resolveStubEntry(),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.minutes(15),
      environment: {
        ...props.environment,
        LOCAL_LAMBDA_IOT_ENDPOINT: liveApp.iotEndpoint,
        LOCAL_LAMBDA_REGION: Stack.of(this).region,
        LOCAL_LAMBDA_APP: liveApp.appName,
        LOCAL_LAMBDA_STAGE: liveApp.stage,
        LOCAL_LAMBDA_FUNCTION_ID: this.functionId,
        LOCAL_LAMBDA_SCRATCH_BUCKET: liveApp.scratchBucket.bucketName,
      },
    });

    liveApp.grantIotAccess(this.function);

    // Synth-time-only values (no deploy-time tokens) so the CLI can read them straight out of
    // cdk.out/tree.json without needing a deploy first. The IoT endpoint isn't included here
    // because it's only resolved at deploy time (custom resource) — the CLI looks it up itself.
    this.discoveryAttributes = {
      functionId: this.functionId,
      entry: props.entry,
      handler: props.handler ?? "handler",
      appName: liveApp.appName,
      stage: liveApp.stage,
      requestTopic: requestTopic(liveApp.appName, liveApp.stage, this.functionId),
    };
  }

  /** Surfaces discovery attributes into cdk.out/tree.json for the `local-lambda` CLI to read. */
  inspect(inspector: TreeInspector): void {
    if (!this.discoveryAttributes) return;
    inspector.addAttribute("local-lambda:function", this.discoveryAttributes);
  }
}
