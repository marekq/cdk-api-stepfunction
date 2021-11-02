import { Construct, Duration, RemovalPolicy, Stack, StackProps } from '@aws-cdk/core';
import { Choice, Condition, CustomState, JsonPath, LogLevel, Parallel, Pass, StateMachine, StateMachineType, Succeed } from '@aws-cdk/aws-stepfunctions';
import { AttributeType, BillingMode, Table } from '@aws-cdk/aws-dynamodb';
import { DynamoAttributeValue, DynamoGetItem, LambdaInvoke } from '@aws-cdk/aws-stepfunctions-tasks';
import { LogGroup, RetentionDays } from '@aws-cdk/aws-logs';
import { EventBus, Rule} from '@aws-cdk/aws-events';
import { CloudWatchLogGroup } from '@aws-cdk/aws-events-targets';
import { Bucket } from '@aws-cdk/aws-s3';

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
    const sdkGetDdbRecord = new DynamoGetItem(this, 'SDK - Get Record from DynamoDB', {
      table: ddbTable,
      key: { 
        orderid: DynamoAttributeValue.fromString(JsonPath.stringAt("$.orderid"))
      },
      resultPath: '$.sdkget'
    });

    // Check output of DynamoDB record
    const checkDdbRecord = new Choice(this, 'Check Order ID in DynamoDB')
    .when(Condition.isPresent('$.sdkget.Item'), 

      // Order ID was found in DynamoDB
      new Pass(this, 'PASS - orderid record found', {
        inputPath: '$.sdkget.Item',
        parameters: {
          '$.sdkPut.Item': '$.sdkPut.Item'
        },
        resultPath: '$.recordFound'
      })

      .next(putEventBridgeRecord('LOG - Order ID found in DynamoDB'))
    )

    .otherwise(

      new Pass(this, "orderid field not found in dynamodb", {
        parameters: {
          "error": "orderid field not found in dynamodb",
          "request.$": "$"
        },
        outputPath: '$.error',
        resultPath: "$.error"
      })

      .next(putEventBridgeRecord('ERROR - orderid not found'))
    );


    // Create SF definition 
    const sfDefinition = new Choice(this, 'Check if method field exists')

    // Check if method field is present
    .when(Condition.isPresent('$.method'),
    
      // Check value of $.method field
      new Choice(this, 'Check value of method field')

      // If $.method field is 'GET'
      .when(Condition.stringEquals('$.method', 'get'), 
        
        new Choice(this, "Check if order id field is present")

        // Retrieve record from DynamoDB
        .when(Condition.isPresent('$.orderid'),
          sdkGetDdbRecord

            // Check if record was found in DynamoDB
            .next(checkDdbRecord)
        )

        .otherwise(

          // ERROR - $.orderid field is not present in input
          putEventBridgeRecord("ERROR - no orderid field")
        )
      )
        
      // PUT condition found in input
      .when(Condition.stringEquals('$.method', 'put'),

        new Pass(this, "PUT request input received", {
          parameters: {
            "method": "put",
          },
          resultPath: "$.request"
        })

        .next(putEventBridgeRecord("LOG - PUT request received"))
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
  }
}
