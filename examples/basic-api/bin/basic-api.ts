#!/usr/bin/env node
import "source-map-support/register";
import { App } from "aws-cdk-lib";
import { BasicApiStack } from "../lib/basic-api-stack";

const app = new App();
const stage = app.node.tryGetContext("stage") ?? "dev";

new BasicApiStack(app, `BasicApiStack-${stage}`, {
  stage,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
