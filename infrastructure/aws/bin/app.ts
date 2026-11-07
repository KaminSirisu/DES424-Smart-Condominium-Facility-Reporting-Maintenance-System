#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { ScfrmsDevStack } from '../lib/scfrms-dev-stack.js';

const app = new App();

new ScfrmsDevStack(app, 'Des424G02ScfrmsDev', {
  env: { account: '528301714999', region: 'ap-southeast-1' },
});
