const AWS = require('aws-sdk');
const ddbclient = new AWS.DynamoDB.DocumentClient();

exports.handler = async function (event: any, context: any) {
    
    ddbclient.put({
        TableName: process.env.DYNAMODB_TABLE,
        Item: {
            id: '2',
            name: 'lambdaPut'
        }
    })
}