// handlers/getFilters.js
'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb'); // QueryCommand added

const client = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(client);

// Define the filter groups in order of hierarchy
// const FILTER_GROUPS_HIERARCHY = ['Year', 'Event', 'Day', 'Team', 'Misc']; // Not directly used in query logic but good for reference
const FILTERS_TABLE_NAME = process.env.FILTERS_TABLE_NAME || 'PhotoViewerFilters'; // Get from env or default

async function queryFilters(parentPath, filterTypePrefix) {
  const params = {
    TableName: FILTERS_TABLE_NAME,
    KeyConditionExpression: 'ParentPath = :pp AND begins_with(SK, :sk_prefix)',
    ExpressionAttributeValues: {
      ':pp': parentPath,
      ':sk_prefix': filterTypePrefix,
    },
    ProjectionExpression: 'ActualFilterValue, PhotoCount', // Only fetch needed attributes
  };

  try {
    const command = new QueryCommand(params);
    const response = await ddbDocClient.send(command);
    // Filter out items with PhotoCount <= 0, as they shouldn't be selectable
    return (response.Items || []).filter(item => item.PhotoCount > 0).map(item => item.ActualFilterValue).sort();
  } catch (error) {
    console.error(`Error querying PhotoViewerFilters for ParentPath '${parentPath}' and SK prefix '${filterTypePrefix}':`, error);
    return []; // Return empty array on error to prevent breaking the entire filter chain
  }
}

const getQueryParamAsArray = (event, paramName) => {
  const lowerParam = paramName.toLowerCase();
  const titleParam = paramName.charAt(0).toUpperCase() + paramName.slice(1).toLowerCase();
  let values = [];

  if (event.multiValueQueryStringParameters) {
    if (event.multiValueQueryStringParameters[lowerParam]) {
      values = event.multiValueQueryStringParameters[lowerParam];
    } else if (event.multiValueQueryStringParameters[titleParam]) {
      values = event.multiValueQueryStringParameters[titleParam];
    }
  } else if (event.queryStringParameters) {
    if (event.queryStringParameters[lowerParam]) {
      values = [event.queryStringParameters[lowerParam]];
    } else if (event.queryStringParameters[titleParam]) {
      values = [event.queryStringParameters[titleParam]];
    }
  }
  return values.filter(v => v !== null && v !== undefined && v !== ''); // Filter out empty/null values
};

exports.handler = async (event) => {
  console.log('getFilters event:', JSON.stringify(event, null, 2));

  const filters = {
    Year: [],
    Event: [],
    Day: [],
    Team: [],
    Misc: [],
  };

  const selectedYears = getQueryParamAsArray(event, 'year');
  const selectedEvents = getQueryParamAsArray(event, 'event');
  const selectedDays = getQueryParamAsArray(event, 'day');

  const promisesToResolve = {
    yearPromise: queryFilters('ROOT', 'YEAR#'),
    eventPromise: Promise.resolve([]), // Default to empty if not selected
    dayPromise: Promise.resolve([]),   // Default to empty
    teamPromise: Promise.resolve([]),  // Default to empty
    miscPromise: Promise.resolve([])   // Default to empty
  };

  if (selectedYears.length > 0) {
    const eventPromises = selectedYears.map(year => queryFilters(`YEAR#${year}`, 'EVENT#'));
    promisesToResolve.eventPromise = Promise.all(eventPromises).then(results => 
      [...new Set(results.flat())].sort()
    );
  } else {
    promisesToResolve.eventPromise = Promise.resolve([]); // No year selected, no events
  }

  if (selectedYears.length > 0 && selectedEvents.length > 0) {
    const dayPromises = [];
    selectedYears.forEach(year => {
      selectedEvents.forEach(eventVal => {
        dayPromises.push(queryFilters(`YEAR#${year}#EVENT#${eventVal}`, 'DAY#'));
      });
    });
    promisesToResolve.dayPromise = Promise.all(dayPromises).then(results => 
      [...new Set(results.flat())].sort()
    );
  } else {
    promisesToResolve.dayPromise = Promise.resolve([]);
  }

  if (selectedYears.length > 0 && selectedEvents.length > 0 && selectedDays.length > 0) {
    const teamPromises = [];
    const miscPromises = [];
    selectedYears.forEach(year => {
      selectedEvents.forEach(eventVal => {
        selectedDays.forEach(day => {
          const parentPath = `YEAR#${year}#EVENT#${eventVal}#DAY#${day}`;
          teamPromises.push(queryFilters(parentPath, 'TEAM#'));
          miscPromises.push(queryFilters(parentPath, 'MISC#'));
        });
      });
    });
    promisesToResolve.teamPromise = Promise.all(teamPromises).then(results => 
      [...new Set(results.flat())].sort()
    );
    promisesToResolve.miscPromise = Promise.all(miscPromises).then(results => 
      [...new Set(results.flat())].sort()
    );
  } else {
    promisesToResolve.teamPromise = Promise.resolve([]);
    promisesToResolve.miscPromise = Promise.resolve([]);
  }

  try {
    const [yearData, eventData, dayData, teamData, miscData] = await Promise.all([
      promisesToResolve.yearPromise,
      promisesToResolve.eventPromise,
      promisesToResolve.dayPromise,
      promisesToResolve.teamPromise,
      promisesToResolve.miscPromise
    ]);

    filters.Year = yearData;
    filters.Event = eventData;
    filters.Day = dayData;
    filters.Team = teamData;
    filters.Misc = miscData;

  } catch (error) {
    console.error('Error resolving filter queries:', error);
    // If any query fails, this will catch it. Depending on requirements,
    // you might want to return a 500 error or partial data.
    // For now, it will proceed with potentially empty arrays for failed queries (as queryFilters returns [] on error).
  }

  // Ensure all filter arrays are sorted (though queryFilters already sorts them, this is a safeguard)
  for (const key in filters) {
    if (Array.isArray(filters[key])) {
      filters[key].sort((a, b) => String(a).localeCompare(String(b))); // Ensure consistent sorting
    }
  }

  console.log('Returning filters:', JSON.stringify(filters, null, 2));

  return {
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': true, // If you use cookies or auth headers
    },
    body: JSON.stringify(filters),
  };
};
