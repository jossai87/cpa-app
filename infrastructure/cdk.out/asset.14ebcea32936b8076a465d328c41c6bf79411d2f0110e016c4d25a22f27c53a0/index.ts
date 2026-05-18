import {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

/**
 * documentHandler — Phase 1 stub.
 *
 * All document routes return HTTP 501 in Phase 1.
 * Phase 2 will implement:
 *   - POST /documents/upload-url  → S3 pre-signed URL generation
 *   - POST /documents/bda-job     → Bedrock Data Automation job trigger
 */

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  switch (event.routeKey) {
    case 'POST /documents/upload-url':
      return json(501, { error: 'Not implemented in Phase 1' });
    case 'POST /documents/bda-job':
      return json(501, { error: 'Not implemented in Phase 1' });
    default:
      return json(404, { error: 'Route not found' });
  }
};
