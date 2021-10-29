// Import xray sdk and log context missing errors
const AWSXRay = require('aws-xray-sdk-core');
AWSXRay.capturePromise();
AWSXRay.setContextMissingStrategy("LOG_ERROR");

// Import AWS SDK
const AWS = require('aws-sdk');
AWSXRay.captureAWS(require('aws-sdk'));

// Create DynamoDB client
const ddbclient = new AWS.DynamoDB.DocumentClient();

// Lambda handler
exports.handler = async function (event: any, context: any) {
    
	let seg = AWSXRay.getSegment().addNewSubsegment("lambdaGet");
    let output;

    // Get records from DynamoDB
    const getcmd = await ddbclient.get(
        {
            TableName: process.env.DYNAMODB_TABLE,
            Key: {
                id: 'lambdaGet'
            }
        },
        (err: any, data: any) => {
            if (err) {
                console.log(err);
                output = err;
            } else {
                console.log(data);
                output = data;
            }
        }
    ).promise();

    // Return DynamoDB records
    console.log('get record ' + output);

    seg.close();
    return output;
}