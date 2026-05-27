#!/usr/bin/env python3
"""
get-gmail-refresh-token.py

Runs a local OAuth flow to get a Gmail refresh token for a second account.
Opens a browser, catches the redirect on localhost:8080, exchanges the code,
and prints the refresh token.

Usage:
    python3 scripts/get-gmail-refresh-token.py

Sign in as nancyandjustin@footsolutions.com when the browser opens.
"""

import webbrowser
import urllib.parse
import urllib.request
import http.server
import json
import subprocess
import sys

# ── Load credentials from Secrets Manager ────────────────────────────
print("Loading OAuth client credentials from Secrets Manager...")
try:
    result = subprocess.run(
        [
            "aws", "secretsmanager", "get-secret-value",
            "--secret-id", "foot-solutions/gmail/oauth-client",
            "--region", "us-east-1",
            "--query", "SecretString",
            "--output", "text",
        ],
        capture_output=True, text=True, check=True
    )
    creds = json.loads(result.stdout.strip())
    CLIENT_ID = creds["client_id"]
    CLIENT_SECRET = creds["client_secret"]
except Exception as e:
    print(f"ERROR loading credentials: {e}")
    sys.exit(1)

REDIRECT_URI = "http://localhost:8080"
SCOPE = "https://www.googleapis.com/auth/gmail.readonly"

# ── Build auth URL ────────────────────────────────────────────────────
auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
    "client_id": CLIENT_ID,
    "redirect_uri": REDIRECT_URI,
    "response_type": "code",
    "scope": SCOPE,
    "access_type": "offline",
    "prompt": "consent",
})

print(f"\nOpening browser for Google sign-in...")
print(f"Sign in as: nancyandjustin@footsolutions.com\n")
webbrowser.open(auth_url)

# ── Local server to catch the redirect ───────────────────────────────
auth_code = None

class OAuthHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        global auth_code
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        if "code" in params:
            auth_code = params["code"][0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"""
                <html><body style="font-family:sans-serif;text-align:center;padding:60px">
                <h2 style="color:#16a34a">&#10003; Authorization successful!</h2>
                <p>You can close this tab and return to the terminal.</p>
                </body></html>
            """)
        else:
            error = params.get("error", ["unknown"])[0]
            self.send_response(400)
            self.end_headers()
            self.wfile.write(f"Error: {error}".encode())

    def log_message(self, format, *args):
        pass  # suppress request logs

print("Waiting for Google to redirect back to localhost:8080...")
server = http.server.HTTPServer(("localhost", 8080), OAuthHandler)
server.handle_request()

if not auth_code:
    print("ERROR: No auth code received.")
    sys.exit(1)

print(f"Auth code received. Exchanging for refresh token...")

# ── Exchange code for tokens ──────────────────────────────────────────
token_params = urllib.parse.urlencode({
    "code": auth_code,
    "client_id": CLIENT_ID,
    "client_secret": CLIENT_SECRET,
    "redirect_uri": REDIRECT_URI,
    "grant_type": "authorization_code",
}).encode()

try:
    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=token_params,
        method="POST",
    )
    resp = urllib.request.urlopen(req)
    tokens = json.loads(resp.read())
except urllib.error.HTTPError as e:
    print(f"ERROR exchanging code: {e.read().decode()}")
    sys.exit(1)

refresh_token = tokens.get("refresh_token")
if not refresh_token:
    print("ERROR: No refresh_token in response. Full response:")
    print(json.dumps(tokens, indent=2))
    sys.exit(1)

print("\n" + "="*60)
print("SUCCESS! Refresh token obtained.")
print("="*60)
print(f"\nRefresh token:\n{refresh_token}\n")

# ── Store in Secrets Manager ──────────────────────────────────────────
secret_name = "foot-solutions/gmail/refresh-token-nancy"
print(f"Storing in Secrets Manager as: {secret_name}")

secret_value = json.dumps({"refresh_token": refresh_token})

# Try update first, create if not exists
try:
    subprocess.run(
        [
            "aws", "secretsmanager", "put-secret-value",
            "--secret-id", secret_name,
            "--secret-string", secret_value,
            "--region", "us-east-1",
        ],
        capture_output=True, text=True, check=True
    )
    print(f"Updated existing secret: {secret_name}")
except subprocess.CalledProcessError:
    # Secret doesn't exist yet — create it
    try:
        subprocess.run(
            [
                "aws", "secretsmanager", "create-secret",
                "--name", secret_name,
                "--description", "Gmail refresh token for nancyandjustin@footsolutions.com",
                "--secret-string", secret_value,
                "--region", "us-east-1",
            ],
            capture_output=True, text=True, check=True
        )
        print(f"Created new secret: {secret_name}")
    except subprocess.CalledProcessError as e:
        print(f"ERROR storing secret: {e.stderr}")
        print(f"\nManually store this refresh token in Secrets Manager as '{secret_name}':")
        print(f"  {refresh_token}")
        sys.exit(1)

print("\nDone! Refresh token stored. You can now run the multi-inbox sync.")
