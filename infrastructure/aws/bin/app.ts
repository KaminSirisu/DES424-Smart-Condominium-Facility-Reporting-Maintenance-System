#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { g02Synthesizer } from '../lib/asset-staging.js';
import { ScfrmsDevStack } from '../lib/scfrms-dev-stack.js';

const app = new App();
const env = { account: '528301714999', region: 'ap-southeast-1' };

new ScfrmsDevStack(app, 'Des424G02ScfrmsDev', {
  env,
  synthesizer: g02Synthesizer(),
});
