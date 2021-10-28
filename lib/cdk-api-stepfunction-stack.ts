import { Construct, Duration, RemovalPolicy, Stack, StackProps } from '@aws-cdk/core';
import { LogLevel, Parallel, Pass, StateMachine, StateMachineType, Succeed } from '@aws-cdk/aws-stepfunctions';
import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs';
import { Architecture, Runtime, Tracing } from '@aws-cdk/aws-lambda';
import { AttributeType, Table } from '@aws-cdk/aws-dynamodb';
import { DynamoAttributeValue, DynamoGetItem, LambdaInvoke } from '@aws-cdk/aws-stepfunctions-tasks';
import { LogGroup } from '@aws-cdk/aws-logs';

export class CdkApiStepfunctionStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Create DynamoDB table, with primary key set to 'id' and sort key to 'name'
    const ddbTable = new Table(this, 'Table', {
      removalPolicy: RemovalPolicy.DESTROY,
      partitionKey: {
        name: 'id',
        type: AttributeType.STRING,
      }
    });

    // Option 1 - Get DDB record using Lambda (512MB, nodejs connection reuse)
    const ddbGetLambda = new NodejsFunction(this, 'DdbGetFunction', {
      entry: 'src/lambda/index.ts',
      handler: 'handler',
      runtime: Runtime.NODEJS_14_X,
      memorySize: 512,
      tracing: Tracing.ACTIVE,
      timeout: Duration.seconds(5),
      architecture: Architecture.ARM_64,
      environment: {
        DYNAMODB_TABLE: ddbTable.tableName,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1'
      }
    });

    // Create Get DDB Lambda Step
    const lambdaGetDdbRecord = new LambdaInvoke(this, 'DdbRecordLambda', { 
      lambdaFunction: ddbGetLambda, 
      resultPath: '$.lambdaGet'
    });

    // Option 2 - Create SF SDK Step to get DDB record
    const sdkGetDdbRecord = new DynamoGetItem(this, 'DdbRecordSdkGet', {
      table: ddbTable,
      key: { 
        id: DynamoAttributeValue.fromString("lambdaGet") 
      },
      resultPath: '$.sdkGet'
    });

    // Create SF definition (do parallel get from Lambda and SF SDK to DynamoDB)
    const sfDefinition = new Parallel(this, 'sfDefinition');
    sfDefinition.branch(lambdaGetDdbRecord)
    sfDefinition.branch(sdkGetDdbRecord)
    .next(new Pass(this, 'End', {
      /*
      parameters: {
        'lambdaGet.$': '$.lambdaGet',
        'sdkGet.$': '$.sdkGet'
      }
      */
    }));

    // Create State Machine log group
    const logGroup = new LogGroup(this, 'SfLogGroup');

    // Create express state machine with logging enabled
    const stateMachine = new StateMachine(this, 'StateMachine', {
      definition: sfDefinition,
      tracingEnabled: true,
      stateMachineType: StateMachineType.EXPRESS,
      timeout: Duration.minutes(1),
      logs: {
        destination: logGroup,
        level: LogLevel.ALL
      },
    });

    // Grant DynamoDB read access to State Machine and Lambda
    ddbTable.grantReadData(stateMachine);
    ddbTable.grantReadData(ddbGetLambda);
  }
}
