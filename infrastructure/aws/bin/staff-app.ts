#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { g02Synthesizer } from '../lib/asset-staging.js';
import {
  StaffImageStack,
  StaffPortalStack,
} from '../lib/staff-portal-stack.js';

const app = new App();
app.node.setContext('@aws-cdk/core:defaultCrossStackReferences', 'strong');
const env = { account: '528301714999', region: 'ap-southeast-1' };

const images = new StaffImageStack(app, 'Des424G02StaffImage', {
  env,
  synthesizer: g02Synthesizer(),
});

const imageTag = app.node.tryGetContext('staffImageTag');
if (imageTag !== undefined) {
  const requiredContext = (key: string): string => {
    const value: unknown = app.node.tryGetContext(key);
    if (typeof value !== 'string' || !value) {
      throw new Error(`${key} is required with staffImageTag.`);
    }
    return value;
  };
  if (typeof imageTag !== 'string' || !imageTag) {
    throw new Error('staffImageTag must be a nonempty Git commit SHA.');
  }
  new StaffPortalStack(app, 'Des424G02StaffPortal', {
    env,
    synthesizer: g02Synthesizer(),
    repository: images.repository,
    imageTag,
    cloudFrontPrefixListId: requiredContext('cloudFrontPrefixListId'),
    vpcId: requiredContext('staffVpcId'),
    publicSubnetIds: [
      requiredContext('staffPublicSubnetA'),
      requiredContext('staffPublicSubnetB'),
    ],
    availabilityZones: [
      requiredContext('staffAzA'),
      requiredContext('staffAzB'),
    ],
  });
}
