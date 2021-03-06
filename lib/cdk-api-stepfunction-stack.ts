import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Choice, Condition, CustomState, JsonPath, LogLevel, Parallel, Pass, StateMachine, StateMachineType, Succeed } from 'aws-cdk-lib/aws-stepfunctions';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { DynamoAttributeValue, DynamoGetItem, LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { EventBus, Rule} from 'aws-cdk-lib/aws-events';
import { CloudWatchLogGroup } from 'aws-cdk-lib/aws-events-targets';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { StepFunctionsRestApi } from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';

export class CdkApiStepfunctionStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Create DynamoDB table, with primary key set to 'id' and sort key to 'name'
    const ddbTable = new Table(this, 'Table', {
      removalPolicy: RemovalPolicy.DESTROY,
      billingMode: BillingMode.PAY_PER_REQUEST,
      partitionKey: {
        name: 'orderid',
        type: AttributeType.STRING,
      }
    });

    // Create S3 bucket
    const s3bucket = new Bucket(this, 'Bucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      versioned: true,
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
    
    // Create new EventBridge
    const LogEventBridge = new EventBus(this, 'EventBridge');

    // Create EventBridge Rule to deliver CloudWatch logs
    const LogEventRule = new Rule(this, 'LogEventRule', {
      eventBus: LogEventBridge,
      enabled: true,      
      eventPattern: { source: ['custom.eventbus'] },
      targets: [
        new CloudWatchLogGroup(debugLogGroup)
      ]
    });

    // Function for put EventBridge record - input the log string to submit
    function putEventBridgeRecord (logstring: string) {
      
      // Put given log string to EventBridge
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
      
    // Get DynamoDB record from table
    const sdkGetDdbRecord = new DynamoGetItem(this, 'Get Record from DynamoDB', {
      table: ddbTable,
      key: { 
        orderid: DynamoAttributeValue.fromString(JsonPath.stringAt("$.body.orderid"))
      },
      resultPath: '$.sdkget'
    });

    // Check output of DynamoDB record
    const checkDdbRecord = new Choice(this, 'Check Order ID in DynamoDB')
    .when(Condition.isPresent('$.sdkget.Item'), 

      // Order ID was found in DynamoDB
      new Pass(this, 'PASS - Order ID found in DynamoDB', {
        inputPath: '$.sdkget.Item',
        parameters: {
          '$.sdkPut.Item': '$.sdkPut.Item'
        },
        resultPath: '$.recordFound'
      })

      .next(putEventBridgeRecord('LOG - Order ID found in DynamoDB'))
    )

    .otherwise(

      new Pass(this, "OrderID field not found in dynamodb", {
        parameters: {
          "error": "OrderID field not found in dynamodb",
          "request.$": "$"
        },
        outputPath: '$.error',
        resultPath: "$.error"
      })

      .next(putEventBridgeRecord('ERROR - OrderID not found in DynamoDB'))
    );


    // Create SF definition 
    const sfDefinition = new Choice(this, 'Check if method field exists')

    // Check if method field is present
    .when(Condition.isPresent('$.body.method'),
    
      // Check value of $.method field
      new Choice(this, 'Check value of method field')

      // If $.method field is 'GET'
      .when(Condition.stringEquals('$.body.method', 'get'), 
        
        new Choice(this, "Check if order id field is present")

        // Retrieve record from DynamoDB
        .when(Condition.isPresent('$.body.orderid'),
          sdkGetDdbRecord

          // Check if record was found in DynamoDB
          .next(checkDdbRecord)
        )

        .otherwise(

          new Pass(this, "No OrderID field found in input", {
            parameters: {
              "error": "No OrderID field found in input",
              "request.$": "$"
            },
            outputPath: '$.error',
            resultPath: "$.error"
          })

          // ERROR - OrderID field is not present in input
          .next(putEventBridgeRecord("ERROR - No OrderID field found in input"))
        )
      )
        
      // PUT condition found in input
      .when(Condition.stringEquals('$.body.method', 'put'),

        new Pass(this, "PUT request input received", {
          parameters: {
            "method": "put",
          },
          resultPath: "$.request"
        })

        .next(putEventBridgeRecord("LOG - PUT request input received"))
      )

      // ERROR - unknown method in input
      .otherwise(

        new Pass(this, "unknown method value found in input", {

          parameters: {
            "error": "unknown method value found in input",
          },
          resultPath: '$.error',
          outputPath: '$.error'

        })

        .next(putEventBridgeRecord("ERROR - unknown method value in input"))

      )
    )

    // ERROR - method field not present in request
    .otherwise(

      new Pass(this, "no method field found in input", {
        parameters: {
          "error": "no method field found in input",
        },
        resultPath: '$.error',
        outputPath: '$.error'
      })

      .next(putEventBridgeRecord("ERROR - no method field in input"))

    );

    // Create express state machine with logging enabled
    const stateMachine = new StateMachine(this, 'Dynamo_StateMachine', {
      definition: sfDefinition,
      tracingEnabled: true,
      stateMachineType: StateMachineType.EXPRESS,
      timeout: Duration.minutes(1),
      logs: {
        destination: SFlogGroup,
        level: LogLevel.ALL
      },
    });
    
    // Grant DynamoDB read access to State Machine
    ddbTable.grantReadData(stateMachine);

    // Grant State Machine with write access to debug log group
    debugLogGroup.grantWrite(stateMachine);

    // Grant State Machine with write access to EventBridge
    LogEventBridge.grantPutEventsTo(stateMachine);

    const sfRestApi = new StepFunctionsRestApi(this, 'StepFunctionsRestApi', {
      stateMachine: stateMachine,
      deploy: true
    });
  }
}
