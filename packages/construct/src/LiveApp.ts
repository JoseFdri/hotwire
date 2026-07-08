import { Duration, RemovalPolicy, Stack, Token } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import { scratchBucketName, topicPrefix } from "@bifrost/core";

const CONTEXT_KEY = "bifrost:live";

/** True when the app was synthesized with `-c bifrost:live=true` (or the legacy `-c live=true`). */
export function isLiveMode(scope: Construct): boolean {
  const value = scope.node.tryGetContext(CONTEXT_KEY) ?? scope.node.tryGetContext("live");
  return value === true || value === "true";
}

export interface LiveAppProps {
  /** Logical app name used to namespace IoT topics. Defaults to the CDK app's outdir-derived name. */
  appName?: string;
  stage: string;
}

/**
 * Shared per-stack infrastructure for live dev: the IoT Core endpoint lookup, an S3 scratch bucket
 * for oversized payloads, and the IAM permissions every `LiveFunction` stub needs to reach them.
 * One instance is created (and reused) per Stack — use `LiveApp.getOrCreate` rather than the
 * constructor directly unless you need more than one.
 */
export class LiveApp extends Construct {
  static getOrCreate(scope: Construct, props: LiveAppProps): LiveApp {
    const stack = Stack.of(scope);
    const id = "BifrostApp";
    const existing = stack.node.tryFindChild(id) as LiveApp | undefined;
    return existing ?? new LiveApp(stack, id, props);
  }

  readonly appName: string;
  readonly stage: string;
  readonly scratchBucket: s3.Bucket;
  readonly iotEndpoint: string;

  constructor(scope: Construct, id: string, props: LiveAppProps) {
    super(scope, id);

    this.appName = props.appName ?? Stack.of(this).stackName;
    this.stage = props.stage;

    const { account, region } = Stack.of(this);
    if (Token.isUnresolved(account) || Token.isUnresolved(region)) {
      throw new Error(
        "bifrost: LiveFunction/LiveApp requires the Stack to have a concrete `env: { account, region }` " +
          "(not environment-agnostic) — the local CLI needs to independently derive the same scratch bucket " +
          "name and IoT region your stack deploys to.",
      );
    }

    this.scratchBucket = new s3.Bucket(this, "ScratchBucket", {
      bucketName: scratchBucketName(account, region, this.appName, this.stage),
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: Duration.days(1) }],
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    const endpointLookup = new cr.AwsCustomResource(this, "IotEndpoint", {
      onCreate: {
        service: "Iot",
        action: "DescribeEndpoint",
        parameters: { endpointType: "iot:Data-ATS" },
        physicalResourceId: cr.PhysicalResourceId.fromResponse("endpointAddress"),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
    });
    this.iotEndpoint = endpointLookup.getResponseField("endpointAddress");
  }

  /** Grants a Lambda's execution role (or any grantable) permission to connect and use this app's topic namespace. */
  grantIotAccess(grantable: iam.IGrantable): void {
    const region = Stack.of(this).region;
    const account = Stack.of(this).account;
    const topicPathPrefix = topicPrefix(this.appName, this.stage);

    grantable.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["iot:Connect"],
        resources: [`arn:aws:iot:${region}:${account}:client/*`],
      }),
    );
    grantable.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["iot:Publish"],
        resources: [`arn:aws:iot:${region}:${account}:topic/${topicPathPrefix}/*`],
      }),
    );
    grantable.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["iot:Subscribe"],
        resources: [`arn:aws:iot:${region}:${account}:topicfilter/${topicPathPrefix}/*`],
      }),
    );
    grantable.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["iot:Receive"],
        resources: [`arn:aws:iot:${region}:${account}:topic/${topicPathPrefix}/*`],
      }),
    );

    this.scratchBucket.grantReadWrite(grantable);
  }
}

/** Absolute path to the stub package's compiled handler, for use as a Lambda `entry`. */
export function resolveStubEntry(): string {
  return require.resolve("@bifrost/stub/dist/handler.js");
}
