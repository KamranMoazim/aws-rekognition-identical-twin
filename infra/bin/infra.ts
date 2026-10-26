import { App } from 'aws-cdk-lib';
import { TwinResolverStack } from '../lib/twin-resolver-stack.js';

const app = new App();

// Face Liveness is available in us-east-1; keep everything in one region.
new TwinResolverStack(app, 'TwinResolverStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
});
