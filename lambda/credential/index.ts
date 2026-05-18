import {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import {
  SecretsManagerClient,
  ListSecretsCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { redact } from '../shared/redact';

// ── Types ────────────────────────────────────────────────────────────

interface SecretValue {
  name: string;
  url: string;
  username: string;
  password: string;
}

// ── Constants ────────────────────────────────────────────────────────

const SECRET_PATH_PREFIX =
  process.env.SECRET_PATH_PREFIX ?? 'foot-solutions/credentials/';

// Lambda Extension local HTTP server for cached secret retrieval
const EXTENSION_BASE_URL = 'http://localhost:2773';

// ── AWS Clients ──────────────────────────────────────────────────────

// Used only for ListSecrets and PutSecretValue (not cached by extension)
const smClient = new SecretsManagerClient({ region: 'us-east-1' });

// ── Helpers ──────────────────────────────────────────────────────────

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * Fetch a secret via the Lambda Extension cache (port 2773).
 * The extension caches responses for up to 300 seconds.
 */
async function getSecretViaExtension(secretId: string): Promise<SecretValue> {
  const url = `${EXTENSION_BASE_URL}/secretsmanager/get?secretId=${encodeURIComponent(secretId)}`;
  const res = await fetch(url, {
    headers: {
      'X-Aws-Parameters-Secrets-Token': process.env.AWS_SESSION_TOKEN ?? '',
    },
  });

  if (res.status === 404) {
    const err = new Error('SECRET_NOT_FOUND');
    (err as NodeJS.ErrnoException).code = 'SECRET_NOT_FOUND';
    throw err;
  }

  if (!res.ok) {
    throw new Error(`Extension fetch failed with status ${res.status}`);
  }

  const data = (await res.json()) as { SecretString: string };
  return JSON.parse(data.SecretString) as SecretValue;
}

/**
 * Extract the slug (last path segment) from a full secret name/ARN.
 * e.g. "foot-solutions/credentials/global-payments" → "global-payments"
 */
function slugFromSecretName(name: string): string {
  return name.split('/').pop() ?? name;
}

// ── Route Handlers ───────────────────────────────────────────────────

async function handleListCredentials(): Promise<APIGatewayProxyResultV2> {
  try {
    // List all secrets under the path prefix
    const listResult = await smClient.send(
      new ListSecretsCommand({
        Filters: [
          {
            Key: 'name',
            Values: [SECRET_PATH_PREFIX],
          },
        ],
        MaxResults: 100,
      })
    );

    const secretList = listResult.SecretList ?? [];

    if (secretList.length === 0) {
      return json(200, { credentials: [] });
    }

    // Fetch each secret via the extension cache
    const credentials = await Promise.all(
      secretList.map(async (secret) => {
        const name = secret.Name ?? '';
        const slug = slugFromSecretName(name);
        try {
          const value = await getSecretViaExtension(name);
          return {
            id: slug,
            name: value.name,
            url: value.url,
            username: value.username,
            password: '••••••••',
          };
        } catch (err) {
          console.error(`Failed to fetch secret ${name}:`, (err as Error).message);
          throw err;
        }
      })
    );

    return json(200, { credentials });
  } catch (err) {
    const error = err as Error;
    console.error('Failed to retrieve credentials:', error.message);
    return json(500, { error: 'Failed to retrieve credentials' });
  }
}

async function handleCopyCredential(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  const id = event.pathParameters?.id;
  if (!id) {
    return json(400, { error: 'Credential ID is required' });
  }

  const secretId = `${SECRET_PATH_PREFIX}${id}`;

  try {
    const value = await getSecretViaExtension(secretId);
    // Return raw password — SPA writes to clipboard immediately and discards
    return json(200, { password: value.password });
  } catch (err) {
    const error = err as Error & { code?: string };
    if (error.code === 'SECRET_NOT_FOUND' || error.message === 'SECRET_NOT_FOUND') {
      return json(404, { error: 'Credential not found' });
    }
    console.error(`Failed to retrieve credential ${id}:`, error.message);
    return json(502, { error: 'Failed to retrieve credential from Secrets Manager' });
  }
}

async function handleUpdateCredential(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  const id = event.pathParameters?.id;
  if (!id) {
    return json(400, { error: 'Credential ID is required' });
  }

  if (!event.body) {
    return json(400, { error: 'Request body is required' });
  }

  let body: { password?: string };
  try {
    body = JSON.parse(event.body) as { password?: string };
  } catch {
    return json(400, { error: 'Invalid JSON in request body' });
  }

  if (!body.password || body.password.length < 8) {
    return json(400, { error: 'password must be at least 8 characters', field: 'password' });
  }

  console.log('Updating credential:', JSON.stringify(redact({ id, password: body.password })));

  const secretId = `${SECRET_PATH_PREFIX}${id}`;

  // Read existing secret to preserve name, url, username
  let existing: SecretValue;
  try {
    existing = await getSecretViaExtension(secretId);
  } catch (err) {
    const error = err as Error & { code?: string };
    if (error.code === 'SECRET_NOT_FOUND' || error.message === 'SECRET_NOT_FOUND') {
      return json(404, { error: 'Credential not found' });
    }
    console.error(`GetSecretValue failed for ${id}:`, error.message);
    return json(502, { error: 'Failed to read existing credential' });
  }

  // Merge new password while preserving other fields
  const updated: SecretValue = {
    name: existing.name,
    url: existing.url,
    username: existing.username,
    password: body.password,
  };

  try {
    await smClient.send(
      new PutSecretValueCommand({
        SecretId: secretId,
        SecretString: JSON.stringify(updated),
      })
    );
  } catch (err) {
    const error = err as Error;
    console.error(`PutSecretValue failed for ${id}:`, error.message);
    return json(500, { error: `Failed to update credential: ${error.message}` });
  }

  return json(200, { message: 'Password updated successfully' });
}

// ── Main Handler ─────────────────────────────────────────────────────

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  switch (event.routeKey) {
    case 'GET /credentials':
      return handleListCredentials();
    case 'POST /credentials/{id}/copy':
      return handleCopyCredential(event);
    case 'PUT /credentials/{id}':
      return handleUpdateCredential(event);
    default:
      return json(404, { error: 'Route not found' });
  }
};
