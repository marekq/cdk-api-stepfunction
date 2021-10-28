const AWS = require('aws-sdk');
const ddbclient = new AWS.DynamoDB.DocumentClient();

exports.handler = async function (event: any, context: any) {
    
    const putcmd = await ddbclient.put(
        {
            TableName: process.env.DYNAMODB_TABLE,
            Item: {
                id: 'lambdaPut',
                name: 'lambdaPut'
            }
        }
    ).promise();

    return putcmd
}