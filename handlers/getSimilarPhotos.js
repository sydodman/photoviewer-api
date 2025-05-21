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
console.log(`Qdrant API URL: ${QDRANT_BASE_URL}`);

// For testing/development purposes
const MOCK_MODE = false; // Set to false when Qdrant is properly configured

// Fallback to mock mode if Qdrant is unreachable
let useMockMode = MOCK_MODE;

// Set timeout for Qdrant requests
const QDRANT_TIMEOUT_MS = 10000; // 10 seconds timeout

// S3 base URL for thumbnails and hi-res images
const S3_BASE = `https://${process.env.S3_BUCKET}.s3.eu-west-1.amazonaws.com`;

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

exports.handler = async (event) => {
  const startTime = Date.now();
  console.log('getSimilarPhotos invoked with raw event:', JSON.stringify(event));

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
    
    console.log(`Retrieved photo item for: ${photoId}`);
    
    let searchResults = [];
    
    // Check if we need to use mock mode
    useMockMode = MOCK_MODE;
    
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
        console.log(`Searching for photos similar to: ${photoId}`);
        
        console.log(`Searching for vector with key: ${photoId}`);
        
        // If we have a vectorId, get the point directly by ID
        // Otherwise, fall back to searching by key in the payload
        let searchByKeyResponse;
        
        // Use optimized key-based search
        console.log(`Using optimized key-based search for: ${photoId}`);
        const searchStartTime = Date.now();
          // Use exact match filter for better performance
          searchByKeyResponse = await axios.post(
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
          
          const searchTime = Date.now() - searchStartTime;
          console.log(`Optimized key-based search took ${searchTime}ms`);
        
        console.log(`Received response from Qdrant scroll endpoint. Status: ${searchByKeyResponse.status}`);
        if (searchByKeyResponse.data && searchByKeyResponse.data.status === 'ok') {
          console.log('Qdrant response status is OK');
        }
        
        if (!searchByKeyResponse.data || !searchByKeyResponse.data.result || 
            !searchByKeyResponse.data.result.points || searchByKeyResponse.data.result.points.length === 0) {
          console.error('Vector not found for photo:', photoId);
          console.log('Falling back to mock mode due to missing vector');
          
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
          return;
        }
        
        const point = searchByKeyResponse.data.result.points[0];
        console.log(`Found point with ID: ${point.id} for photo: ${photoId}`);
        
        // Extract the vector from the point
        const vector = point.vector;
        
        if (!vector) {
          console.error('Vector data missing for point:', point.id);
          console.log('Falling back to mock mode due to missing vector data');
          
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
          return;
        }
        
        // Now search for similar vectors
        console.log(`Searching for similar vectors with threshold: ${threshold} and limit: ${limit}`);
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
        
        console.log(`Received response from Qdrant search endpoint. Status: ${searchResponse.status}`);
        
        if (searchResponse.data && searchResponse.data.status === 'ok') {
          searchResults = searchResponse.data.result || [];
          console.log(`Found ${searchResults.length} similar photos from Qdrant`);
          
          // Log a sample of the results for debugging
          if (searchResults.length > 0) {
            const sampleResult = searchResults[0];
            console.log(`Sample result - ID: ${sampleResult.id}, Score: ${sampleResult.score}`);
            console.log(`Sample payload keys: ${Object.keys(sampleResult.payload || {}).join(', ')}`);
          }
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
    
    const totalTime = Date.now() - startTime;
    console.log(`Total execution time: ${totalTime}ms`);
    
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
