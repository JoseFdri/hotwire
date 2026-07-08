/**
 * Deterministic scratch-bucket name derived from account/region/app/stage. Both the CDK construct
 * (at synth time, where account/region must be concrete — not tokens) and the CLI (which resolves
 * its own account via STS and region via the AWS config chain) compute this independently, so the
 * name never needs to round-trip through `cdk synth` output.
 */
export function scratchBucketName(account: string, region: string, appName: string, stage: string): string {
  const raw = `local-lambda-${appName}-${stage}-${account}-${region}`.toLowerCase();
  const sanitized = raw.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.slice(0, 63).replace(/-+$/g, "");
}
