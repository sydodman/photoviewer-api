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

exports.handler = async (event) => {
  console.log('getFilters event:', JSON.stringify(event, null, 2));

  const filters = {
    Year: [],
    Event: [],
    Day: [],
    Team: [],
    Misc: [],
  };

  const selectedYear = event.queryStringParameters?.year || event.queryStringParameters?.Year;
  const selectedEvent = event.queryStringParameters?.event || event.queryStringParameters?.Event;
  const selectedDay = event.queryStringParameters?.day || event.queryStringParameters?.Day;

  const promisesToResolve = {
    yearPromise: queryFilters('ROOT', 'YEAR#'),
    eventPromise: Promise.resolve([]), // Default to empty if not selected
    dayPromise: Promise.resolve([]),   // Default to empty
    teamPromise: Promise.resolve([]),  // Default to empty
    miscPromise: Promise.resolve([])   // Default to empty
  };

  if (selectedYear) {
    const eventParentPath = `YEAR#${selectedYear}`;
    promisesToResolve.eventPromise = queryFilters(eventParentPath, 'EVENT#');
  }

  if (selectedYear && selectedEvent) {
    const dayParentPath = `YEAR#${selectedYear}#EVENT#${selectedEvent}`;
    promisesToResolve.dayPromise = queryFilters(dayParentPath, 'DAY#');
  }

  if (selectedYear && selectedEvent && selectedDay) {
    const teamMiscParentPath = `YEAR#${selectedYear}#EVENT#${selectedEvent}#DAY#${selectedDay}`;
    promisesToResolve.teamPromise = queryFilters(teamMiscParentPath, 'TEAM#');
    promisesToResolve.miscPromise = queryFilters(teamMiscParentPath, 'MISC#');
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
