const AWS = require('aws-sdk');
const ddbclient = new AWS.DynamoDB.DocumentClient();

exports.handler = async function (event: any, context: any) {
    
    const getcmd = await ddbclient.get(
        {
            TableName: process.env.DYNAMODB_TABLE,
            Item: {
                id: 'lambdaGet',
                name: 'lambdaGet'
            }
        }
    ).promise();

    return JSON.stringify(getcmd);
}