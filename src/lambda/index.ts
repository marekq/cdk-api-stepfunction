const AWS = require('aws-sdk');
const ddbclient = new AWS.DynamoDB.DocumentClient();

exports.handler = async function (event: any, context: any) {
    
    let output;

    const getcmd = await ddbclient.get(
        {
            TableName: process.env.DYNAMODB_TABLE,
            Key: {
                'id': 'lambdaGet'
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
    );

    console.log('put record' + output);
    return output;
}