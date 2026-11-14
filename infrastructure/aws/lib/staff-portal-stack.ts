import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_ecs_patterns as ecsPatterns,
  aws_logs as logs,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';

/** First deploy this small stack, then push an image tagged with the commit SHA. */
export class StaffImageStack extends Stack {
  readonly repository: ecr.Repository;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    this.repository = new ecr.Repository(this, 'Repository', {
      repositoryName: 'des424-g02-scfrms-staff',
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    new CfnOutput(this, 'RepositoryUri', {
      value: this.repository.repositoryUri,
    });
  }
}

export interface StaffPortalStackProps extends StackProps {
  repository: ecr.IRepository;
  imageTag: string;
  cloudFrontPrefixListId: string;
}

/** Static staff portal. All authenticated API calls go directly to HTTPS API Gateway. */
export class StaffPortalStack extends Stack {
  constructor(scope: Construct, id: string, props: StaffPortalStackProps) {
    super(scope, id, props);

    if (!/^[a-f0-9]{12,40}$/.test(props.imageTag)) {
      throw new Error(
        'staffImageTag must be a 12–40 character Git commit SHA.',
      );
    }
    if (!/^pl-[a-f0-9]+$/.test(props.cloudFrontPrefixListId)) {
      throw new Error('cloudFrontPrefixListId must be an AWS prefix-list ID.');
    }

    // Explicit subnets avoid CDK availability-zone lookups during local synth.
    const vpcResource = new ec2.CfnVPC(this, 'VpcResource', {
      cidrBlock: '10.82.0.0/16',
      enableDnsHostnames: true,
      enableDnsSupport: true,
    });
    const gateway = new ec2.CfnInternetGateway(this, 'InternetGateway');
    const gatewayAttachment = new ec2.CfnVPCGatewayAttachment(
      this,
      'GatewayAttachment',
      { vpcId: vpcResource.ref, internetGatewayId: gateway.ref },
    );
    const routeTable = new ec2.CfnRouteTable(this, 'PublicRouteTable', {
      vpcId: vpcResource.ref,
    });
    const internetRoute = new ec2.CfnRoute(this, 'InternetRoute', {
      routeTableId: routeTable.ref,
      destinationCidrBlock: '0.0.0.0/0',
      gatewayId: gateway.ref,
    });
    internetRoute.addResourceDependency(gatewayAttachment);
    const publicA = new ec2.CfnSubnet(this, 'PublicA', {
      vpcId: vpcResource.ref,
      cidrBlock: '10.82.0.0/24',
      availabilityZone: 'ap-southeast-1a',
      mapPublicIpOnLaunch: true,
    });
    const publicB = new ec2.CfnSubnet(this, 'PublicB', {
      vpcId: vpcResource.ref,
      cidrBlock: '10.82.1.0/24',
      availabilityZone: 'ap-southeast-1b',
      mapPublicIpOnLaunch: true,
    });
    const routeA = new ec2.CfnSubnetRouteTableAssociation(this, 'RouteA', {
      subnetId: publicA.ref,
      routeTableId: routeTable.ref,
    });
    const routeB = new ec2.CfnSubnetRouteTableAssociation(this, 'RouteB', {
      subnetId: publicB.ref,
      routeTableId: routeTable.ref,
    });
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId: vpcResource.ref,
      availabilityZones: ['ap-southeast-1a', 'ap-southeast-1b'],
      publicSubnetIds: [publicA.ref, publicB.ref],
      publicSubnetRouteTableIds: [routeTable.ref, routeTable.ref],
    });
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });
    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const task = new ecs.FargateTaskDefinition(this, 'Task', {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    const container = task.addContainer('StaffPortal', {
      image: ecs.ContainerImage.fromEcrRepository(
        props.repository,
        props.imageTag,
      ),
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'staff' }),
      healthCheck: {
        command: [
          'CMD-SHELL',
          'wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1',
        ],
      },
    });
    container.addPortMappings({ containerPort: 8080 });

    const service = new ecsPatterns.ApplicationLoadBalancedFargateService(
      this,
      'Service',
      {
        cluster,
        taskDefinition: task,
        desiredCount: 1,
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
        publicLoadBalancer: true,
        openListener: false,
        listenerPort: 80,
        assignPublicIp: true,
        taskSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        circuitBreaker: { rollback: true },
        healthCheckGracePeriod: Duration.seconds(60),
      },
    );
    service.targetGroup.configureHealthCheck({
      path: '/healthz',
      healthyHttpCodes: '200',
    });
    service.service.node.addDependency(internetRoute, routeA, routeB);
    // The ALB only serves public static assets to CloudFront. No login or API
    // request goes through it; the browser sends those to HTTPS API Gateway.
    service.loadBalancer.connections.allowFrom(
      ec2.Peer.prefixList(props.cloudFrontPrefixListId),
      ec2.Port.tcp(80),
      'CloudFront origin-facing servers',
    );

    const distribution = new cloudfront.Distribution(this, 'HttpsSite', {
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(service.loadBalancer, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        compress: true,
      },
    });

    new CfnOutput(this, 'StaffPortalUrl', {
      value: `https://${distribution.domainName}`,
    });
    new CfnOutput(this, 'ImageUri', {
      value: `${props.repository.repositoryUri}:${props.imageTag}`,
    });
  }
}
