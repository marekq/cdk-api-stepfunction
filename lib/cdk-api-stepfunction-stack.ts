import { Construct, Duration, Stack, StackProps } from '@aws-cdk/core';
import { CustomState, LogLevel, StateMachine, StateMachineType } from '@aws-cdk/aws-stepfunctions';
import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs';
import { Architecture, Runtime, Tracing } from '@aws-cdk/aws-lambda';
import { AttributeType, Table } from '@aws-cdk/aws-dynamodb';
import { LambdaInvoke } from '@aws-cdk/aws-stepfunctions-tasks';
import { LogGroup } from '@aws-cdk/aws-logs';

export class CdkApiStepfunctionStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Create dynamodb table, with primary key set to 'id'
    const ddbTable = new Table(this, 'Table', {
      partitionKey: {
        name: 'id',
        type: AttributeType.STRING
      },
      sortKey: {
        name: 'name',
        type: AttributeType.STRING
      },
    });

    // Option 1 - put record using Lambda (512MB, nodejs connection reuse)
    const ddbGetLambda = new NodejsFunction(this, 'DdbPutFunction', {
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

    // Create Fetch Lambda Step
    const lamdbdaPutToDDB = new LambdaInvoke(this, 'lamdbdaPutToDDB', { 
      lambdaFunction: ddbGetLambda, 
      outputPath: '$.Payload'
    });

    // Option 2 - Create SF SDK Step to put DDB record
    const sdkPutToDDB = new CustomState(this, 'sdkPutToDDB', {
      stateJson: {
        Type: 'Task',
        Resource: 'arn:aws:states:::dynamodb:putItem',
        Parameters: {
          TableName: ddbTable.tableName,
          Item: {
            id: {
              "S": 'sfPut'
            },
            name: {
              "S": "sfPut"
            }
          },
        },
        ResultPath: '$.Payload'
      }
    })

    // Create SF definition (do Lambda put, followed by SF SDK put to DynamoDB)
    const sfDefinition = lamdbdaPutToDDB.next(sdkPutToDDB);

    // Create State Machine log group
    const logGroup = new LogGroup(this, 'SfLogGroup');

    // Create express state machine
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

    // Grant DDB read/write access to State Machine and Lambda
    ddbTable.grantReadWriteData(stateMachine);
    ddbTable.grantReadWriteData(ddbGetLambda);
  }
}