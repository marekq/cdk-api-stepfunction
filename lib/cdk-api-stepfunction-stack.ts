import { Construct, Duration, RemovalPolicy, Stack, StackProps } from '@aws-cdk/core';
import { CustomState, LogLevel, Parallel, StateMachine, StateMachineType, Succeed } from '@aws-cdk/aws-stepfunctions';
import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs';
import { Architecture, Code, LayerVersion, Runtime, Tracing } from '@aws-cdk/aws-lambda';
import { AttributeType, Table } from '@aws-cdk/aws-dynamodb';
import { DynamoAttributeValue, DynamoGetItem, LambdaInvoke } from '@aws-cdk/aws-stepfunctions-tasks';
import { LogGroup, RetentionDays } from '@aws-cdk/aws-logs';
import { EventBus, Rule} from '@aws-cdk/aws-events';
import { CloudWatchLogGroup } from '@aws-cdk/aws-events-targets';

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

    // Create Debug LogGroup (for human readable state machine logs)
    const debugLogGroup = new LogGroup(this, 'DebugLogGroup', {
      removalPolicy: RemovalPolicy.DESTROY,
      retention: RetentionDays.ONE_WEEK
    });

    // Create State Machine log group (for full state machine logging)
    const SFlogGroup = new LogGroup(this, 'SfLogGroup', {
      removalPolicy: RemovalPolicy.DESTROY,
      retention: RetentionDays.ONE_WEEK
    });

    // Create EventBridge
    const LogEventBridge = new EventBus(this, 'EventBridge');
    const LogEventRule = new Rule(this, 'LogEventRule', {
      eventBus: LogEventBridge,
      description: 'Logs all events to CloudWatch Logs',
      enabled: true,      
      eventPattern: { source: ['custom.eventbus'] },
      targets: [
        new CloudWatchLogGroup(debugLogGroup)
      ]
    });
      
    // Option 1 - Get DDB record using Lambda (512MB, nodejs connection reuse)

    // Create Lambda layer with X-Ray tracing
    const lambdaLayers = new LayerVersion(this, 'XrayLayer', {
      code: Code.fromAsset('src/layer/'),
      compatibleRuntimes: [Runtime.NODEJS_14_X],
      layerVersionName: 'lambdaLayer',
      description: 'xray',
      removalPolicy: RemovalPolicy.DESTROY
    });

    // Create Lambda function for record retrieval
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
      },
      layers: [lambdaLayers],
      bundling: {
        externalModules: ['aws-sdk', 'aws-xray-sdk-core']
      }
    });

    // Create Get DDB Lambda Step
    const lambdaGetDdbRecord = new LambdaInvoke(this, 'DdbRecordLambda', { 
      lambdaFunction: ddbGetLambda, 
      resultSelector: {
        "LambdaRecordContent.$": "$.Payload"
      },
      resultPath: '$.lambdaPut'
    });

    // Option 2 - Create SF SDK Step to get DDB record
    const sdkGetDdbRecord = new DynamoGetItem(this, 'DdbRecordSdkGet', {
      table: ddbTable,
      key: { 
        id: DynamoAttributeValue.fromString("sdkGet") 
      },
      resultSelector: {
        "SdkrecordContent.$": "$.Item"
      },
      resultPath: '$.sdkPut'
    });


    // Function for put event bridge record - input the log string to submit
    function putEventBridgeRecord (logstring: string) {
      
      // Put map output event to EventBridge
      const putEventBridge = new CustomState(scope, logstring, {
        stateJson: {
          "Type": "Task",
          "Resource": "arn:aws:states:::events:putEvents",
          "Parameters": {
            "Entries": [
              {
                "EventBusName": LogEventBridge.eventBusName,
                "Detail": {
                  "event": logstring
                },
                "DetailType": "eventDelivery",
                "Source": "custom.eventbus"
              }
            ]
          },
          "ResultPath": "$." + logstring
        }
      })

      return putEventBridge;
    }

    // Create SF definition (do parallel get from Lambda and SF SDK to DynamoDB)
    const sfDefinition = new Parallel(this, 'sfDefinition');
    sfDefinition.branch(
      lambdaGetDdbRecord.next(putEventBridgeRecord("Submitted record using Lambda"))
    )
    sfDefinition.branch(
      sdkGetDdbRecord.next(putEventBridgeRecord("Submitted record using SF SDK request"))
    )
    .next(
      new Succeed(this, 'End')
    );

    // Create express state machine with logging enabled
    const stateMachine = new StateMachine(this, 'StateMachine', {
      definition: sfDefinition,
      tracingEnabled: true,
      stateMachineType: StateMachineType.EXPRESS,
      timeout: Duration.minutes(1),
      logs: {
        destination: SFlogGroup,
        level: LogLevel.ALL
      },
    });

    // Grant DynamoDB read access to State Machine and Lambda
    ddbTable.grantReadData(stateMachine);
    ddbTable.grantReadData(ddbGetLambda);

    // Grant State Machine with write access to debug log group
    debugLogGroup.grantWrite(stateMachine);

    // Grant State Machine with write access to EventBridge
    LogEventBridge.grantPutEventsTo(stateMachine);
  }
}
