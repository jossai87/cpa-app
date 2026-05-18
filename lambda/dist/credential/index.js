"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_secrets_manager_1 = require("@aws-sdk/client-secrets-manager");
const redact_1 = require("../shared/redact");
// ── Constants ────────────────────────────────────────────────────────
const SECRET_PATH_PREFIX = process.env.SECRET_PATH_PREFIX ?? 'foot-solutions/credentials/';
// Lambda Extension local HTTP server for cached secret retrieval
const EXTENSION_BASE_URL = 'http://localhost:2773';
// ── AWS Clients ──────────────────────────────────────────────────────
// Used only for ListSecrets and PutSecretValue (not cached by extension)
const smClient = new client_secrets_manager_1.SecretsManagerClient({ region: 'us-east-1' });
// ── Helpers ──────────────────────────────────────────────────────────
function json(statusCode, body) {
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
async function getSecretViaExtension(secretId) {
    const url = `${EXTENSION_BASE_URL}/secretsmanager/get?secretId=${encodeURIComponent(secretId)}`;
    const res = await fetch(url, {
        headers: {
            'X-Aws-Parameters-Secrets-Token': process.env.AWS_SESSION_TOKEN ?? '',
        },
    });
    if (res.status === 404) {
        const err = new Error('SECRET_NOT_FOUND');
        err.code = 'SECRET_NOT_FOUND';
        throw err;
    }
    if (!res.ok) {
        throw new Error(`Extension fetch failed with status ${res.status}`);
    }
    const data = (await res.json());
    return JSON.parse(data.SecretString);
}
/**
 * Extract the slug (last path segment) from a full secret name/ARN.
 * e.g. "foot-solutions/credentials/global-payments" → "global-payments"
 */
function slugFromSecretName(name) {
    return name.split('/').pop() ?? name;
}
// ── Route Handlers ───────────────────────────────────────────────────
async function handleListCredentials() {
    try {
        // List all secrets under the path prefix
        const listResult = await smClient.send(new client_secrets_manager_1.ListSecretsCommand({
            Filters: [
                {
                    Key: 'name',
                    Values: [SECRET_PATH_PREFIX],
                },
            ],
            MaxResults: 100,
        }));
        const secretList = listResult.SecretList ?? [];
        if (secretList.length === 0) {
            return json(200, { credentials: [] });
        }
        // Fetch each secret via the extension cache
        const credentials = await Promise.all(secretList.map(async (secret) => {
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
            }
            catch (err) {
                console.error(`Failed to fetch secret ${name}:`, err.message);
                throw err;
            }
        }));
        return json(200, { credentials });
    }
    catch (err) {
        const error = err;
        console.error('Failed to retrieve credentials:', error.message);
        return json(500, { error: 'Failed to retrieve credentials' });
    }
}
async function handleCopyCredential(event) {
    const id = event.pathParameters?.id;
    if (!id) {
        return json(400, { error: 'Credential ID is required' });
    }
    const secretId = `${SECRET_PATH_PREFIX}${id}`;
    try {
        const value = await getSecretViaExtension(secretId);
        // Return raw password — SPA writes to clipboard immediately and discards
        return json(200, { password: value.password });
    }
    catch (err) {
        const error = err;
        if (error.code === 'SECRET_NOT_FOUND' || error.message === 'SECRET_NOT_FOUND') {
            return json(404, { error: 'Credential not found' });
        }
        console.error(`Failed to retrieve credential ${id}:`, error.message);
        return json(502, { error: 'Failed to retrieve credential from Secrets Manager' });
    }
}
async function handleUpdateCredential(event) {
    const id = event.pathParameters?.id;
    if (!id) {
        return json(400, { error: 'Credential ID is required' });
    }
    if (!event.body) {
        return json(400, { error: 'Request body is required' });
    }
    let body;
    try {
        body = JSON.parse(event.body);
    }
    catch {
        return json(400, { error: 'Invalid JSON in request body' });
    }
    if (!body.password || body.password.length < 8) {
        return json(400, { error: 'password must be at least 8 characters', field: 'password' });
    }
    console.log('Updating credential:', JSON.stringify((0, redact_1.redact)({ id, password: body.password })));
    const secretId = `${SECRET_PATH_PREFIX}${id}`;
    // Read existing secret to preserve name, url, username
    let existing;
    try {
        existing = await getSecretViaExtension(secretId);
    }
    catch (err) {
        const error = err;
        if (error.code === 'SECRET_NOT_FOUND' || error.message === 'SECRET_NOT_FOUND') {
            return json(404, { error: 'Credential not found' });
        }
        console.error(`GetSecretValue failed for ${id}:`, error.message);
        return json(502, { error: 'Failed to read existing credential' });
    }
    // Merge new password while preserving other fields
    const updated = {
        name: existing.name,
        url: existing.url,
        username: existing.username,
        password: body.password,
    };
    try {
        await smClient.send(new client_secrets_manager_1.PutSecretValueCommand({
            SecretId: secretId,
            SecretString: JSON.stringify(updated),
        }));
    }
    catch (err) {
        const error = err;
        console.error(`PutSecretValue failed for ${id}:`, error.message);
        return json(500, { error: `Failed to update credential: ${error.message}` });
    }
    return json(200, { message: 'Password updated successfully' });
}
// ── Main Handler ─────────────────────────────────────────────────────
const handler = async (event) => {
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
exports.handler = handler;
//# sourceMappingURL=index.js.map