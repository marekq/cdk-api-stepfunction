// Import xray sdk and log context missing errors
const AWSXRay = require('aws-xray-sdk-core');
AWSXRay.capturePromise();
AWSXRay.setContextMissingStrategy("LOG_ERROR");

// Import AWS SDK
const XAWS = AWSXRay.captureAWS(require('aws-sdk'));

// Create DynamoDB client
const ddbclient = new XAWS.DynamoDB.DocumentClient();

// Lambda handler
exports.handler = async function (event: any, context: any) {
    
    let getcmd;

    // Get records from DynamoDB
    try {
        getcmd = await ddbclient.get(
            {
                TableName: process.env.DYNAMODB_TABLE,
                Key: { id: 'lambdaGet' }
            }
        ).promise();

    } catch (error) {

        const msg = 'Unable to read from DynamoDB ' + error;
        console.log(msg);
        return msg;
    }

    // Return DynamoDB records
    console.log('get record ' + getcmd);
    
    return getcmd;
}