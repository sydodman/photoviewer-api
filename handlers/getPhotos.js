// handlers/getPhotos.js
'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  ScanCommand
} = require('@aws-sdk/lib-dynamodb');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const S3_BASE = 'https://trackphotos-eu-west-1.s3.eu-west-1.amazonaws.com';

exports.handler = async (event) => {
  try {
    // Parse query params (v2 HTTP API vs v1 REST)
    const raw = event.multiValueQueryStringParameters
      || Object.entries(event.queryStringParameters || {}).reduce((acc, [k,v]) => {
           acc[k] = v==null ? [] : Array.isArray(v) ? v : [v];
           return acc;
         }, {})
      || {};

    // Build FilterExpression (same as getFilters)
    let FilterExpression, ExpressionAttributeNames, ExpressionAttributeValues;
    if (Object.keys(raw).length) {
      ExpressionAttributeNames  = {};
      ExpressionAttributeValues = {};
      const clauses = [];
      for (const [key, vals] of Object.entries(raw)) {
        ExpressionAttributeNames[`#${key}`] = key;
        const phs = vals.map((v,i) => {
          const ph = `:${key}${i}`;
          ExpressionAttributeValues[ph] = v;
          return ph;
        });
        clauses.push(`#${key} IN (${phs.join(',')})`);
      }
      FilterExpression = clauses.join(' AND ');
    }

    // Now do a paginated scan
    let items = [];
    let lastKey = undefined;

    do {
      const params = { TableName: process.env.TABLE_NAME };
      if (FilterExpression) {
        params.FilterExpression            = FilterExpression;
        params.ExpressionAttributeNames    = ExpressionAttributeNames;
        params.ExpressionAttributeValues   = ExpressionAttributeValues;
      }
      if (lastKey) {
        params.ExclusiveStartKey = lastKey;
      }

      const resp = await ddb.send(new ScanCommand(params));
      items = items.concat(resp.Items || []);
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);

    console.log(`Scanned total ${items.length} items`);

    // Map to your photo shape
    const photos = items.map(item => {
      const key = item.Key;
      return {
        id:           key,
        Year:         item.Year,
        Event:        item.Event,
        Day:          item.Day,
        Team:         item.Team,
        Misc:         item.Misc,
        thumbnailUrl: `${S3_BASE}/thumbNail/${key}`,
        hiResUrl:     `${S3_BASE}/hiRes/${key}`,
      };
    });

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(photos),
    };

  } catch (err) {
    console.error('getPhotos error:', err);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ message: 'Internal server error' }),
    };
  }
};
