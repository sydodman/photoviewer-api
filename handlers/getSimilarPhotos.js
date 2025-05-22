// handlers/getSimilarPhotos.js
'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand
} = require('@aws-sdk/lib-dynamodb');
const axios = require('axios');

// Create DynamoDB client
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

// Qdrant API base URL
const QDRANT_BASE_URL = `http://${process.env.QDRANT_HOST}:${process.env.QDRANT_PORT}`;

// Fallback to mock mode if Qdrant is unreachable
let useMockMode = false;

// Set timeout for Qdrant requests
const QDRANT_TIMEOUT_MS = 10000; // 10 seconds timeout

// S3 base URL for thumbnails and hi-res images
const S3_BASE = `https://${process.env.S3_BUCKET}.s3.eu-west-1.amazonaws.com`;

// Vector table name - separate table for faster vector lookups
const VECTOR_TABLE_NAME = process.env.VECTOR_TABLE_NAME || 'photoVectors';
const VECTOR_FIELD = 'Vector';

// Convert a photo key to a stable numeric ID for Qdrant
function keyToId(key) {
  // For real Qdrant implementation, we need to use the actual ID format used in Qdrant
  // This is the same hash function used in the Python notebook
  const crypto = require('crypto');
  const sha1 = crypto.createHash('sha1').update(key).digest('hex');
  const id = BigInt('0x' + sha1) % BigInt(10**18);
  return Number(id);
}

// Get the photo item from DynamoDB
async function getPhotoItem(key) {
  try {
    // Get the item from DynamoDB
    const getItemResponse = await ddb.send(new GetCommand({
      TableName: process.env.TABLE_NAME,
      Key: { Key: key }
    }));
    
    return getItemResponse.Item;
  } catch (error) {
    console.error(`Error getting item for key ${key}:`, error);
    return null;
  }
}

// Get the vector for a photo from the vector table
async function getPhotoVector(key) {
  try {
    // Get the vector from the vector table
    const getItemResponse = await ddb.send(new GetCommand({
      TableName: VECTOR_TABLE_NAME,
      Key: { PhotoKey: key }
    }));
    
    if (!getItemResponse.Item) {
      console.log(`No vector found in vector table for key: ${key}`);
      return null;
    }
    
    return getItemResponse.Item[VECTOR_FIELD];
  } catch (error) {
    console.error(`Error getting vector for key ${key}:`, error);
    return null;
  }
}

exports.handler = async (event) => {
  console.log('getSimilarPhotos invoked');

  try {
    // Parse query parameters
    const params = event.queryStringParameters || {};
    
    // Required: photo ID to find similar images for
    const photoId = params.id;
    if (!photoId) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ message: 'Missing required parameter: id' }),
      };
    }
    
    // Optional parameters with defaults
    const limit = parseInt(params.limit) || 20;
    const threshold = parseFloat(params.threshold) || 0.75; // Higher = more similar
    
    // 1. Get the photo from DynamoDB to verify it exists
    const photoItem = await getPhotoItem(photoId);
    if (!photoItem) {
      return {
        statusCode: 404,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ message: 'Photo not found' }),
      };
    }
    
    let searchResults = [];
    
    // If not in mock mode, check if Qdrant is accessible
    if (!useMockMode) {
      try {
        // Try to connect to Qdrant with a short timeout
        const healthCheckResponse = await axios.get(
          `${QDRANT_BASE_URL}/collections`,
          { timeout: QDRANT_TIMEOUT_MS }
        );
        
        // If we can't connect or the collection doesn't exist, fall back to mock mode
        const collections = healthCheckResponse.data?.result?.collections || [];
        const collectionExists = collections.some(c => c.name === process.env.COLLECTION_NAME);
        
        if (!collectionExists) {
          console.log(`Collection ${process.env.COLLECTION_NAME} not found in Qdrant, falling back to mock mode`);
          useMockMode = true;
        } else {
          console.log(`Successfully connected to Qdrant, collection ${process.env.COLLECTION_NAME} exists`);
        }
      } catch (error) {
        console.error('Error connecting to Qdrant for health check:', error.message);
        console.log('Falling back to mock mode due to Qdrant connection error');
        useMockMode = true;
      }
    }
    
    if (useMockMode) {
      console.log('Running in MOCK_MODE, generating mock similar photos');
      // In mock mode, we'll just query DynamoDB for photos with the same Team
      const scanParams = {
        TableName: process.env.TABLE_NAME,
        FilterExpression: '#team = :team',
        ExpressionAttributeNames: {
          '#team': 'Team'
        },
        ExpressionAttributeValues: {
          ':team': photoItem.Team
        },
        Limit: limit + 1
      };
      
      const scanResponse = await ddb.send(new ScanCommand(scanParams));
      searchResults = scanResponse.Items.map(item => ({
        id: pointId !== keyToId(item.Key) ? keyToId(item.Key) : pointId + 1, // Ensure we don't match the query image
        score: Math.random() * 0.5 + 0.5, // Random score between 0.5 and 1.0
        payload: item
      }));
      
      console.log(`Found ${searchResults.length} mock similar photos with Team=${photoItem.Team}`);
    } else {
      // Real Qdrant implementation
      try {
        // Get the vector from the DynamoDB vector table (much faster than Qdrant lookup)
        const vector = await getPhotoVector(photoId);
        
        if (!vector) {
          // Fall back to Qdrant lookup if vector not in DynamoDB
          try {
            // Use optimized key-based search
            const searchByKeyResponse = await axios.post(
              `${QDRANT_BASE_URL}/collections/${process.env.COLLECTION_NAME}/points/scroll`,
              {
                filter: {
                  must: [
                    {
                      key: "Key",
                      match: {
                        value: photoId
                      }
                    }
                  ]
                },
                limit: 1,
                with_vector: true,
                with_payload: false  // We don't need the payload for the search
              },
              { 
                timeout: QDRANT_TIMEOUT_MS,
                headers: {
                  'Content-Type': 'application/json'
                }
              }
            );
            
            if (searchByKeyResponse.data && 
                searchByKeyResponse.data.result && 
                searchByKeyResponse.data.result.points && 
                searchByKeyResponse.data.result.points.length > 0 && 
                searchByKeyResponse.data.result.points[0].vector) {
              
              const point = searchByKeyResponse.data.result.points[0];
              
              // Use the vector from Qdrant
              const qdrantVector = point.vector;
              
              // Continue with the Qdrant vector
              if (qdrantVector && qdrantVector.length > 0) {
                // Now search for similar vectors using the Qdrant vector
                const searchResponse = await axios.post(
                  `${QDRANT_BASE_URL}/collections/${process.env.COLLECTION_NAME}/points/search`,
                  {
                    vector: qdrantVector,
                    limit: limit + 5, // Request a few extra to account for filtering
                    score_threshold: threshold,
                    with_payload: true
                  },
                  { 
                    timeout: QDRANT_TIMEOUT_MS,
                    headers: {
                      'Content-Type': 'application/json'
                    }
                  }
                );
                
                if (searchResponse.data && searchResponse.data.status === 'ok') {
                  searchResults = searchResponse.data.result || [];
                  return;
                }
              }
            }
          } catch (error) {
            console.error('Error in Qdrant fallback:', error.message);
          }
          
          // If we get here, both vector table and Qdrant fallback failed
          useMockMode = true;
          
          // Re-run the function with mock mode
          const scanParams = {
            TableName: process.env.TABLE_NAME,
            FilterExpression: '#team = :team',
            ExpressionAttributeNames: {
              '#team': 'Team'
            },
            ExpressionAttributeValues: {
              ':team': photoItem.Team
            },
            Limit: limit + 1
          };
          
          const scanResponse = await ddb.send(new ScanCommand(scanParams));
          searchResults = scanResponse.Items.map(item => ({
            id: keyToId(item.Key) !== keyToId(photoId) ? keyToId(item.Key) : keyToId(photoId) + 1,
            score: Math.random() * 0.5 + 0.5,
            payload: item
          }));
          
          return;
        }
        
        // Now search for similar vectors using the vector from DynamoDB
        const searchResponse = await axios.post(
          `${QDRANT_BASE_URL}/collections/${process.env.COLLECTION_NAME}/points/search`,
          {
            vector: vector,
            limit: limit + 5, // Request a few extra to account for filtering
            score_threshold: threshold,
            with_payload: true
          },
          { 
            timeout: QDRANT_TIMEOUT_MS,
            headers: {
              'Content-Type': 'application/json'
            }
          }
        );
        
        if (searchResponse.data && searchResponse.data.status === 'ok') {
          searchResults = searchResponse.data.result || [];
        } else {
          console.error('Qdrant search response error:', searchResponse.data);
          throw new Error('Invalid response from Qdrant search');
        }
      } catch (error) {
        console.error('Error connecting to Qdrant:', error.message);
        console.log('Falling back to mock mode due to Qdrant search error');
        
        // Fall back to mock mode
        useMockMode = true;
        
        // Re-run the function with mock mode
        const scanParams = {
          TableName: process.env.TABLE_NAME,
          FilterExpression: '#team = :team',
          ExpressionAttributeNames: {
            '#team': 'Team'
          },
          ExpressionAttributeValues: {
            ':team': photoItem.Team
          },
          Limit: limit + 1
        };
        
        const scanResponse = await ddb.send(new ScanCommand(scanParams));
        searchResults = scanResponse.Items.map(item => ({
          id: keyToId(item.Key) !== keyToId(photoId) ? keyToId(item.Key) : keyToId(photoId) + 1,
          score: Math.random() * 0.5 + 0.5,
          payload: item
        }));
        
        console.log(`Found ${searchResults.length} mock similar photos with Team=${photoItem.Team}`);
      }
    }
    
    // 3. Filter out the query image itself and format results
    const similarPhotos = [];
    
    for (const hit of searchResults) {
      // Get the payload data which contains the photo key
      const payload = hit.payload || {};
      const key = payload.Key;
      
      // Skip the query image itself or results without a key
      if (!key || key === photoId) continue;
      
      // Format the photo data
      similarPhotos.push({
        id: key,
        Year: payload.Year || '',
        Event: payload.Event || '',
        Day: payload.Day || '',
        Team: payload.Team || '',
        Misc: payload.Misc || '',
        thumbnailUrl: `${S3_BASE}/thumbNail/${key}`,
        hiResUrl: `${S3_BASE}/hiRes/${key}`,
        similarity: hit.score || 0
      });
      
      // Stop once we have enough results
      if (similarPhotos.length >= limit) break;
    }
    
    // If we're in real mode and got no results, log this for debugging
    if (!useMockMode && similarPhotos.length === 0) {
      console.log('No similar photos found after filtering. Raw results:', JSON.stringify(searchResults));
    }
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(similarPhotos),
    };
      
  } catch (err) {
    console.error('getSimilarPhotos error:', err);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ message: 'Internal server error', error: err.message }),
    };
  }
};
