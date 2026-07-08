import { join } from "node:path";
import { Stack, StackProps, CfnOutput } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import { Construct } from "constructs";
import { LiveFunction } from "@bifrost/construct";

export interface BasicApiStackProps extends StackProps {
  stage: string;
}

export class BasicApiStack extends Stack {
  constructor(scope: Construct, id: string, props: BasicApiStackProps) {
    super(scope, id, props);

    const hello = new LiveFunction(this, "HelloFunction", {
      entry: join(__dirname, "..", "functions", "hello.ts"),
      handler: "handler",
      stage: props.stage,
    });

    const api = new apigw.LambdaRestApi(this, "Api", {
      handler: hello.function,
    });

    new CfnOutput(this, "ApiUrl", { value: api.url });
  }
}
