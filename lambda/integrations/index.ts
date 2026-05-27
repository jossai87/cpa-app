/**
 * Integrations Lambda — read and update API integration secrets.
 *
 * Routes:
 *   GET  /integrations        → list all integrations with masked key values
 *   GET  /integrations/{id}   → get a single integration (keys still masked)
 *   PUT  /integrations/{id}   → update one or more fields of an integration
 *
 * Secrets managed:
 *   foot-solutions/heartland/api-token   → { token, subdomain, baseUrl }
 *   foot-solutions/gmail/oauth-client    → { client_id, client_secret }
 *   foot-solutions/gmail/refresh-token  → { refresh_token, email, savedAt }
 *
 * Keys are always masked in GET responses (shown as "••••••••").
 * PUT accepts the real value and writes it to Secrets Manager.
 * Admin-only — the API Gateway JWT authorizer handles auth; the frontend
 * additionally checks isAdmin before rendering the UI.
 */

import {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({ region: 'us-east-1' });

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** Mask a secret value — show first 4 chars then bullets, or all bullets if short. */
function mask(value: string | undefined): string {
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return value.slice(0, 4) + '••••••••';
}

async function readSecret(secretId: string): Promise<Record<string, string>> {
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!res.SecretString) return {};
  return JSON.parse(res.SecretString) as Record<string, string>;
}

// ── Integration definitions ───────────────────────────────────────────
// Each integration has a stable id, display metadata, and one or more
// "fields" that map to keys inside a Secrets Manager secret.

interface IntegrationField {
  key: string;          // key inside the JSON secret
  label: string;        // display label
  sensitive: boolean;   // if true, value is masked in GET responses
  hint?: string;        // optional helper text shown under the input
  readOnly?: boolean;   // if true, field is shown but not editable
}

interface IntegrationDef {
  id: string;
  name: string;
  description: string;
  logoEmoji: string;
  secretId: string;
  fields: IntegrationField[];
  docsUrl?: string;
}

const INTEGRATIONS: IntegrationDef[] = [
  {
    id: 'heartland',
    name: 'Heartland Retail (POS)',
    description: 'Heartland Retail POS API — powers Sales & Revenue, inventory, purchasing, and staff data.',
    logoEmoji: '🏪',
    secretId: 'foot-solutions/heartland/api-token',
    docsUrl: 'https://dev.retail.heartland.us/',
    fields: [
      {
        key: 'token',
        label: 'API Token',
        sensitive: true,
        hint: 'Bearer token from Heartland Retail → Settings → API Tokens (FS_Custom_App).',
      },
      {
        key: 'subdomain',
        label: 'Tenant Subdomain',
        sensitive: false,
        hint: 'Your Heartland tenant slug, e.g. "fsflowermound".',
      },
      {
        key: 'baseUrl',
        label: 'Base URL',
        sensitive: false,
        hint: 'Full API base URL, e.g. "https://fsflowermound.retail.heartland.us/api".',
      },
    ],
  },
  {
    id: 'gmail-oauth',
    name: 'Gmail (OAuth Client)',
    description: 'Google OAuth 2.0 client credentials — used by the Inbox Assistant and daily briefing email.',
    logoEmoji: '📧',
    secretId: 'foot-solutions/gmail/oauth-client',
    docsUrl: 'https://console.cloud.google.com/apis/credentials',
    fields: [
      {
        key: 'client_id',
        label: 'Client ID',
        sensitive: false,
        hint: 'OAuth 2.0 Client ID from Google Cloud Console.',
      },
      {
        key: 'client_secret',
        label: 'Client Secret',
        sensitive: true,
        hint: 'OAuth 2.0 Client Secret from Google Cloud Console.',
      },
    ],
  },
  {
    id: 'gmail-token',
    name: 'Gmail (Refresh Token)',
    description: 'Long-lived refresh token for the owner Gmail account — minted during OAuth setup.',
    logoEmoji: '🔑',
    secretId: 'foot-solutions/gmail/refresh-token',
    fields: [
      {
        key: 'email',
        label: 'Gmail Account',
        sensitive: false,
        hint: 'The Gmail address this token belongs to.',
        readOnly: true,
      },
      {
        key: 'refresh_token',
        label: 'Refresh Token',
        sensitive: true,
        hint: 'Long-lived OAuth refresh token. Re-run the OAuth bootstrap flow to rotate.',
      },
      {
        key: 'savedAt',
        label: 'Last Updated',
        sensitive: false,
        hint: 'When this token was last saved.',
        readOnly: true,
      },
    ],
  },
];

// ── Handlers ──────────────────────────────────────────────────────────

async function handleList(): Promise<APIGatewayProxyResultV2> {
  const results = await Promise.all(
    INTEGRATIONS.map(async (def) => {
      let fields: Array<{ key: string; label: string; value: string; sensitive: boolean; hint?: string; readOnly?: boolean }> = [];
      try {
        const secret = await readSecret(def.secretId);
        fields = def.fields.map((f) => ({
          key: f.key,
          label: f.label,
          value: f.sensitive ? mask(secret[f.key]) : (secret[f.key] ?? ''),
          sensitive: f.sensitive,
          hint: f.hint,
          readOnly: f.readOnly,
        }));
      } catch (err) {
        console.warn(`Could not read secret ${def.secretId}:`, (err as Error).message);
        fields = def.fields.map((f) => ({
          key: f.key,
          label: f.label,
          value: '',
          sensitive: f.sensitive,
          hint: f.hint,
          readOnly: f.readOnly,
        }));
      }
      return {
        id: def.id,
        name: def.name,
        description: def.description,
        logoEmoji: def.logoEmoji,
        docsUrl: def.docsUrl,
        fields,
      };
    })
  );
  return json(200, { integrations: results });
}

async function handleUpdate(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  const id = event.pathParameters?.['id'];
  if (!id) return json(400, { error: 'Integration id is required' });

  const def = INTEGRATIONS.find((d) => d.id === id);
  if (!def) return json(404, { error: `Unknown integration: ${id}` });

  if (!event.body) return json(400, { error: 'Request body is required' });
  let body: Record<string, string>;
  try {
    body = JSON.parse(event.body) as Record<string, string>;
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  // Only allow updating non-readOnly fields
  const writableKeys = new Set(def.fields.filter((f) => !f.readOnly).map((f) => f.key));
  const updates = Object.fromEntries(
    Object.entries(body).filter(([k]) => writableKeys.has(k))
  );
  if (Object.keys(updates).length === 0) {
    return json(400, { error: 'No writable fields provided' });
  }

  // Read existing secret, merge, write back
  let existing: Record<string, string> = {};
  try {
    existing = await readSecret(def.secretId);
  } catch (err) {
    console.warn(`Could not read existing secret ${def.secretId} before update:`, (err as Error).message);
  }

  const merged = { ...existing, ...updates };

  try {
    await sm.send(new PutSecretValueCommand({
      SecretId: def.secretId,
      SecretString: JSON.stringify(merged),
    }));
  } catch (err) {
    console.error(`PutSecretValue failed for ${def.secretId}:`, (err as Error).message);
    return json(500, { error: `Failed to update integration: ${(err as Error).message}` });
  }

  return json(200, { message: `Integration "${def.name}" updated successfully.` });
}

// ── Main Handler ──────────────────────────────────────────────────────

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  switch (event.routeKey) {
    case 'GET /integrations':
      return handleList();
    case 'PUT /integrations/{id}':
      return handleUpdate(event);
    default:
      return json(404, { error: 'Route not found' });
  }
};
