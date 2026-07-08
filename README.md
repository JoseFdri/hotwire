# local-lambda

Live Lambda Dev for AWS CDK — the same "edit code, no redeploy" workflow SST's Live Lambda Dev
gives you, but for plain CDK apps. Real AWS resources (API Gateway, SQS, EventBridge, ...) invoke
your Lambda, but the handler actually runs on your machine, against your live source.

## Why

Without this, iterating on a Lambda means `cdk deploy` on every change — minutes per cycle, no
breakpoints, no fast feedback. `local-lambda` deploys a thin **stub** in place of your real
handler. The stub forwards every invocation to your laptop, your real handler runs there (hot
reloaded on save), and the result flows back through the same real trigger. To API Gateway/SQS/etc.
it looks like a normal Lambda that's just a bit slower.

## How it works

```
 Real trigger (API GW, SQS, ...)
          │
          ▼
 ┌────────────────────┐        AWS IoT Core         ┌──────────────────────────────┐
 │  Stub Lambda        │◄──── MQTT over WSS ───────►│  local-lambda dev (your laptop) │
 │  (deployed in dev   │                             │  - esbuild bundles + watches   │
 │   mode)              │                             │  - runs handler in a worker    │
 └────────────────────┘                             │  - hot reload on save          │
                                                      └──────────────────────────────┘
```

- **Transport is AWS IoT Core** (MQTT over WebSocket, SigV4-authenticated) — no server to run, no
  inbound ports needed on your machine, reachable from behind NAT/VPN.
- **The stub** publishes the event to a topic, waits for a response on another topic, and returns it
  — so the real caller gets a normal Lambda response.
- **The CLI** discovers which functions are "live" by running `cdk synth` and reading metadata your
  construct exposes, connects to IoT, and for each live function: bundles+watches its handler with
  esbuild and runs it in a worker thread, restarting the worker on every rebuild.
- **Large payloads**: MQTT caps a single message at 128 KB. Anything under that goes inline; bigger
  payloads (e.g. a large API response or SQS batch) are transparently offloaded through an S3
  scratch bucket instead of hand-rolled across multiple MQTT messages.
- **Discovery without a deploy**: your construct emits function metadata into `cdk.out/tree.json`
  (via `IInspectable`) rather than a hand-maintained config file, so it can never drift from your
  actual stack. The IoT endpoint and the S3 scratch bucket name are *not* read from synth output
  (they're only known after deploy) — the CLI independently recomputes them the same way the
  construct does, from your AWS account/region.
- **Zero footprint in prod**: `LiveFunction` only behaves differently when synthesized with
  `-c local-lambda:live=true`. Without that flag it's a plain `NodejsFunction` — no stub, no IoT
  permissions, no scratch bucket.

## Requirements

- Node.js 20+, an existing CDK v2 app (TypeScript), Node.js/TypeScript Lambda handlers.
- Every `Stack` using `LiveFunction` must have a **concrete `env`** (not environment-agnostic):
  ```ts
  new MyStack(app, "MyStack", {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  });
  ```
  This is required because the local CLI derives the IoT region and the scratch bucket name from
  your account/region — it can't do that if the stack's environment isn't known until deploy time.
- Your local AWS credentials (`AWS_PROFILE`/SSO/etc.) must target the **same account and region**
  the live-mode stack is deployed to.

## Install into an existing CDK project

```bash
npm install --save-dev local-lambda
npm install @local-lambda/construct
```

## Usage

**1. Replace `NodejsFunction` with `LiveFunction`** for whichever functions you want live-dev on:

```ts
import { join } from "node:path";
import { LiveFunction } from "@local-lambda/construct";

const hello = new LiveFunction(this, "HelloFunction", {
  entry: join(__dirname, "..", "functions", "hello.ts"),
  handler: "handler",
  stage: props.stage, // any string; namespaces IoT topics so stages/devs don't collide
});

new apigw.LambdaRestApi(this, "Api", { handler: hello.function });
```

`LiveFunction` accepts the same props as `NodejsFunction` (bundling, environment, memory, VPC,
etc.) — `entry` and `stage` are the only additions.

**2. Deploy once with live mode enabled:**

```bash
npx cdk deploy -c local-lambda:live=true -c stage=dev
```

This deploys the stub + supporting infra (S3 scratch bucket, IoT endpoint lookup, IAM grants) —
everything the CLI needs to talk to your function.

**3. Start the local dev loop:**

```bash
npx local-lambda dev --stage dev
```

This synthesizes your app, finds every `LiveFunction`, connects to IoT Core, and starts serving
invocations against your local handler source. Edit a handler file and save — the next invocation
picks it up immediately, no redeploy.

**4. Hit the real endpoint** (API Gateway URL, SQS queue, etc.) as usual. Requests execute your
local code and stream logs/results back to the terminal running `local-lambda dev`.

**5. Ship normally** — deploy without the context flag (or with it `false`) and you get the real
handler, no stub, no live-dev resources:

```bash
npx cdk deploy -c stage=prod
```

### CLI options

```
local-lambda dev --stage <stage> [--app <dir>] [--region <region>]
```

- `--stage` — must match the `stage` you deployed the stack with.
- `--app` — directory containing the CDK app (defaults to cwd).
- `--region` — override region resolution (defaults to your AWS config/credential chain).

## Limitations

- Node.js/TypeScript handlers only.
- One active local dev session per function at a time — if two people run `local-lambda dev`
  against the same deployed stage, whichever subscribes last "wins" invocations (use separate
  stages per developer, e.g. `--stage alice`).
- If `local-lambda dev` isn't running (or isn't connected), the deployed stub returns a clear error
  rather than hanging until timeout.
- Requires outbound network access to AWS IoT Core from your machine.

## Project layout

```
packages/
  core/       shared message protocol + IoT transport (used by stub and cli)
  stub/       the code deployed in place of your handler in dev mode
  construct/  the LiveFunction / LiveApp CDK constructs you consume
  cli/        the `local-lambda` CLI (the `dev` command)
examples/
  basic-api/  a minimal API Gateway + Lambda CDK app used for end-to-end testing
```

## Development

```bash
npm install        # installs and links all workspace packages
npm run build       # builds core → stub → construct → cli
npm run test        # unit tests (protocol round-trips) + CDK assertion tests
cd examples/basic-api && npx cdk synth -c local-lambda:live=true -c stage=dev
```
