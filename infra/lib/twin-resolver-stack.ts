import { CfnOutput, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rekognition from 'aws-cdk-lib/aws-rekognition';
import { Construct } from 'constructs';

/**
 * Everything AWS-side for the twin collision resolver.
 * `cdk destroy` removes all of it (collection + identity pool + role).
 *
 * The backend itself runs locally with your AWS profile; it is not deployed.
 */
export class TwinResolverStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    Tags.of(this).add('project', 'twin-resolver');

    // 1. Face collection. ExternalImageId on each face = our identity id.
    const collection = new rekognition.CfnCollection(this, 'FaceCollection', {
      collectionId: 'twin-resolver-faces',
    });
    collection.applyRemovalPolicy(RemovalPolicy.DESTROY);

    // 2. Identity pool so the browser's FaceLivenessDetector can stream video.
    //    Guests may ONLY call StartFaceLivenessSession; sessions are created
    //    and read by the backend, so a guest cannot fake a result.
    const identityPool = new cognito.CfnIdentityPool(this, 'LivenessIdentityPool', {
      identityPoolName: 'twin_resolver_liveness',
      allowUnauthenticatedIdentities: true,
    });
    identityPool.applyRemovalPolicy(RemovalPolicy.DESTROY);

    const guestRole = new iam.Role(this, 'LivenessGuestRole', {
      description: 'Browser guest role: start Face Liveness streams only',
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: { 'cognito-identity.amazonaws.com:aud': identityPool.ref },
          'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'unauthenticated' },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
    });
    guestRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['rekognition:StartFaceLivenessSession'],
        resources: ['*'],
      }),
    );

    new cognito.CfnIdentityPoolRoleAttachment(this, 'LivenessRoles', {
      identityPoolId: identityPool.ref,
      roles: { unauthenticated: guestRole.roleArn },
    });

    new CfnOutput(this, 'Region', { value: this.region });
    new CfnOutput(this, 'CollectionId', { value: collection.collectionId });
    new CfnOutput(this, 'IdentityPoolId', { value: identityPool.ref });
  }
}
