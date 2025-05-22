// handlers/getFilters.js
'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  ScanCommand
} = require('@aws-sdk/lib-dynamodb');

// Create a DocumentClient that marshals/unmarshals JS types for you
const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

exports.handler = async (event) => {
  try {
    // 1) Parse query params (HTTP API v2 uses .queryStringParameters; REST & multiValue v1 use .multiValueQueryStringParameters)
    const raw = event.multiValueQueryStringParameters
      || Object.entries(event.queryStringParameters || {}).reduce((acc, [k, v]) => {
           acc[k] = v == null ? [] : Array.isArray(v) ? v : [v];
           return acc;
         }, {})
      || {};



    // 2) Build FilterExpression if any filters passed
    let FilterExpression, ExpressionAttributeNames, ExpressionAttributeValues;
    if (Object.keys(raw).length) {
      ExpressionAttributeNames   = {};
      ExpressionAttributeValues  = {};
      const clauses = [];

      for (const [key, vals] of Object.entries(raw)) {
        ExpressionAttributeNames[`#${key}`] = key;
        const placeholders = vals.map((v, i) => {
          const ph = `:${key}${i}`;
          ExpressionAttributeValues[ph] = v;
          return ph;
        });
        clauses.push(`#${key} IN (${placeholders.join(',')})`);
      }
      FilterExpression = clauses.join(' AND ');
    }

        // 3) Scan the table
    const params = { TableName: process.env.TABLE_NAME };
    if (FilterExpression) {
      params.FilterExpression            = FilterExpression;
      params.ExpressionAttributeNames    = ExpressionAttributeNames;
      params.ExpressionAttributeValues   = ExpressionAttributeValues;
    }
    
    const resp = await ddbDocClient.send(new ScanCommand(params));
    const items = resp.Items || [];

    // 4) Pull out distinct values for each group
    const groups = ['Year','Event','Day','Team','Misc'];
    const filters = {};
    for (const g of groups) {
      filters[g] = Array.from(
        new Set(items.map(x => x[g]).filter(v => v != null && v !== ''))
      ).sort();
    }

    console.log('Computed filters:', filters);

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(filters),
    };

  } catch (err) {
    console.error('getFilters error:', err);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ message: 'Internal server error' }),
    };
  }
};
