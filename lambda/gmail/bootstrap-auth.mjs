#!/usr/bin/env node
/**
 * One-time OAuth bootstrap for Gmail API access.
 *
 * Prerequisites:
 *   1. Run from a machine with AWS CLI configured (us-east-1)
 *   2. The secret foot-solutions/gmail/oauth-client must exist with shape:
 *        { "client_id": "...", "client_secret": "..." }
 *
 * What it does:
 *   1. Reads the client_id/client_secret from Secrets Manager
 *   2. Spins up a tiny local HTTP server on port 8765
 *   3. Opens your browser to Google's consent screen
 *   4. Captures the auth code, exchanges it for a refresh token
 *   5. Writes the refresh token to Secrets Manager at
 *      foot-solutions/gmail/refresh-token
 *
 * After this runs successfully, the Lambda can mint access tokens forever
 * (refresh tokens don't expire as long as the OAuth app stays active).
 *
 * Usage:
 *   node lambda/gmail/bootstrap-auth.mjs
 */

import http from 'node:http';
import { execSync } from 'node:child_process';
import { SecretsManagerClient, GetSecretValueCommand, CreateSecretCommand, PutSecretValueCommand, DescribeSecretCommand } from '@aws-sdk/client-secrets-manager';

const REGION = 'us-east-1';
const CLIENT_SECRET_NAME = 'foot-solutions/gmail/oauth-client';
const TOKEN_SECRET_NAME = 'foot-solutions/gmail/refresh-token';
const REDIRECT_PORT = 8765;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

const sm = new SecretsManagerClient({ region: REGION });

async function loadClientCreds() {
  const res = await sm.send(new GetSecretValueCommand({ SecretId: CLIENT_SECRET_NAME }));
  const creds = JSON.parse(res.SecretString);
  if (!creds.client_id || !creds.client_secret) {
    throw new Error(`Secret ${CLIENT_SECRET_NAME} must contain client_id and client_secret`);
  }
  return creds;
}

async function saveRefreshToken(refreshToken, email) {
  const value = JSON.stringify({ refresh_token: refreshToken, email, savedAt: new Date().toISOString() });
  // Try update first; if the secret doesn't exist, create it
  try {
    await sm.send(new DescribeSecretCommand({ SecretId: TOKEN_SECRET_NAME }));
    await sm.send(new PutSecretValueCommand({ SecretId: TOKEN_SECRET_NAME, SecretString: value }));
    console.log(`✓ Updated existing secret ${TOKEN_SECRET_NAME}`);
  } catch {
    await sm.send(new CreateSecretCommand({
      Name: TOKEN_SECRET_NAME,
      Description: 'Gmail API refresh token for daily-report Lambda',
      SecretString: value,
    }));
    console.log(`✓ Created new secret ${TOKEN_SECRET_NAME}`);
  }
}

function openBrowser(url) {
  const platform = process.platform;
  try {
    if (platform === 'darwin') execSync(`open "${url}"`);
    else if (platform === 'win32') execSync(`start "" "${url}"`);
    else execSync(`xdg-open "${url}"`);
  } catch {
    // Browser open failed — user will copy the URL manually
  }
}

async function exchangeCodeForToken(code, clientId, clientSecret) {
  const params = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${body}`);
  }
  return await res.json();
}

async function fetchUserEmail(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return 'unknown';
  const data = await res.json();
  return data.email || 'unknown';
}

async function main() {
  console.log('Loading OAuth client credentials from Secrets Manager…');
  const { client_id, client_secret } = await loadClientCreds();

  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent', // forces refresh_token in response
    }).toString();

  console.log('\nStarting local server on port', REDIRECT_PORT);
  console.log('Opening browser for Google consent…\n');
  console.log('If your browser does not open automatically, visit:\n', authUrl, '\n');

  const codePromise = new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(`<h1>Error</h1><p>${error}</p>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      if (!code) {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(
        '<html><body style="font-family:system-ui;padding:40px;text-align:center;">' +
        '<h2>✓ Authorization complete</h2>' +
        '<p>You can close this tab and return to your terminal.</p>' +
        '</body></html>'
      );
      server.close();
      resolve(code);
    });
    server.listen(REDIRECT_PORT);
    server.on('error', reject);
  });

  openBrowser(authUrl);

  const code = await codePromise;
  console.log('✓ Got authorization code, exchanging for tokens…');

  const tokens = await exchangeCodeForToken(code, client_id, client_secret);
  if (!tokens.refresh_token) {
    throw new Error('No refresh_token in response. Try revoking access at https://myaccount.google.com/permissions and re-running.');
  }

  const email = await fetchUserEmail(tokens.access_token);
  console.log(`✓ Authenticated as ${email}`);

  await saveRefreshToken(tokens.refresh_token, email);
  console.log('\n✅ Done. The Lambda can now read Gmail on behalf of', email);
}

main().catch((err) => {
  console.error('\n❌ Bootstrap failed:', err.message);
  process.exit(1);
});
