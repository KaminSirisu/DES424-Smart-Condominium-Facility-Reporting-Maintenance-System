import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { g02Synthesizer } from '../lib/asset-staging.js';
import {
  StaffImageStack,
  StaffPortalStack,
} from '../lib/staff-portal-stack.js';

const env = { account: '528301714999', region: 'ap-southeast-1' };

function templates(): { images: Template; portal: Template } {
  const app = new App({
    context: { '@aws-cdk/core:defaultCrossStackReferences': 'strong' },
  });
  const images = new StaffImageStack(app, 'TestImages', {
    env,
    synthesizer: g02Synthesizer(),
  });
  const portal = new StaffPortalStack(app, 'TestPortal', {
    env,
    synthesizer: g02Synthesizer(),
    repository: images.repository,
    imageTag: 'abcdef012345',
    cloudFrontPrefixListId: 'pl-12345678',
  });
  return {
    images: Template.fromStack(images),
    portal: Template.fromStack(portal),
  };
}

describe('staff portal stacks', () => {
  it('creates a private immutable ECR repository first', () => {
    const { images } = templates();
    images.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'des424-g02-scfrms-staff',
      ImageTagMutability: 'IMMUTABLE',
      ImageScanningConfiguration: { ScanOnPush: true },
    });
    images.resourceCountIs('AWS::ECS::Service', 0);
  });

  it('runs one x86-64 Fargate task without a NAT gateway', () => {
    const { portal } = templates();
    portal.resourceCountIs('AWS::EC2::NatGateway', 0);
    portal.resourceCountIs('AWS::ECS::Service', 1);
    portal.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 1,
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'ENABLED' }),
      },
    });
    portal.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '256',
      Memory: '512',
      RuntimePlatform: {
        CpuArchitecture: 'X86_64',
        OperatingSystemFamily: 'LINUX',
      },
    });
    portal.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/healthz',
    });
  });

  it('exposes the static site through CloudFront HTTPS only', () => {
    const { portal } = templates();
    portal.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      SourcePrefixListId: 'pl-12345678',
      FromPort: 80,
      ToPort: 80,
    });
    portal.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
          AllowedMethods: ['GET', 'HEAD'],
        }),
      }),
    });
    const resources = portal.findResources('AWS::EC2::SecurityGroupIngress');
    expect(Object.keys(resources)).toHaveLength(2);
  });

  it('rejects a mutable image tag and a missing prefix-list ID', () => {
    const app = new App();
    const images = new StaffImageStack(app, 'Images', {
      env,
      synthesizer: g02Synthesizer(),
    });
    expect(
      () =>
        new StaffPortalStack(app, 'BadTag', {
          env,
          repository: images.repository,
          imageTag: 'latest',
          cloudFrontPrefixListId: 'pl-12345678',
        }),
    ).toThrow('staffImageTag');
    expect(
      () =>
        new StaffPortalStack(app, 'BadPrefix', {
          env,
          repository: images.repository,
          imageTag: 'abcdef012345',
          cloudFrontPrefixListId: '',
        }),
    ).toThrow('cloudFrontPrefixListId');
  });
});
