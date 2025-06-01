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

    // 3) Scan the table with pagination
    const params = { TableName: process.env.TABLE_NAME };
    if (FilterExpression) {
      params.FilterExpression            = FilterExpression;
      params.ExpressionAttributeNames    = ExpressionAttributeNames;
      params.ExpressionAttributeValues   = ExpressionAttributeValues;
    }
    
    // First, do the standard scan to maintain backward compatibility
    const resp = await ddbDocClient.send(new ScanCommand(params));
    let items = resp.Items || [];
    
    // Check if we need to paginate (if LastEvaluatedKey exists)
    if (resp.LastEvaluatedKey) {
      console.log(`Initial scan returned ${items.length} items with more available. Starting pagination...`);
      
      // Continue paginating as long as we have a LastEvaluatedKey
      let lastKey = resp.LastEvaluatedKey;
      
      // Only do a maximum of 3 additional pages to avoid timeouts
      for (let i = 0; i < 3 && lastKey; i++) {
        // Create a new params object with the ExclusiveStartKey
        const paginationParams = Object.assign({}, params, { ExclusiveStartKey: lastKey });
        
        try {
          const pageResp = await ddbDocClient.send(new ScanCommand(paginationParams));
          console.log(`Retrieved page ${i+1} with ${pageResp.Items ? pageResp.Items.length : 0} additional items`);
          
          // Add the new items to our collection
          if (pageResp.Items && pageResp.Items.length > 0) {
            items = items.concat(pageResp.Items);
          }
          
          // Update the pagination key for the next iteration
          lastKey = pageResp.LastEvaluatedKey;
        } catch (paginationError) {
          console.error(`Error during pagination (page ${i+1}):`, paginationError);
          break; // Stop pagination on error, but keep the items we've already retrieved
        }
      }
      
      console.log(`Pagination complete. Total items: ${items.length}`);
    }

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
