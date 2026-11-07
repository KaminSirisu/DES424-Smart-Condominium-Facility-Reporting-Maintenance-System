import { CliCredentialsStackSynthesizer } from 'aws-cdk-lib';

/** Must match CodeAssets.BucketName in asset-staging.json. */
export const assetBucketName =
  'des424-g02-scfrms-cdk-assets-528301714999-ap-southeast-1';

export function g02Synthesizer(): CliCredentialsStackSynthesizer {
  return new CliCredentialsStackSynthesizer({
    fileAssetsBucketName: assetBucketName,
  });
}
