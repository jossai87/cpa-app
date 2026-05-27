"""Smoke test the FS Assistant edge Lambda via API Gateway.

This exercises the full async flow:
  1. POST /assistant/chat  → 202 + sessionId
  2. Poll GET /assistant/chat/{sessionId} every 2.5s until status changes

Requires a Cognito ID token. Easiest way to grab one is to log into the
prod app, open devtools network tab, and copy the Authorization header
from any /pos/dashboard request.

Usage:
  TOKEN=<bearer-token> python3 scripts/smoke-edge.py "your question"
"""

import json
import os
import sys
import time

import urllib.request

API_URL = "https://00fsnfd19b.execute-api.us-east-1.amazonaws.com"
TOKEN = os.environ.get("TOKEN")
if not TOKEN:
    print("Set TOKEN=<cognito-id-token> first.")
    sys.exit(2)

prompt = sys.argv[1] if len(sys.argv) > 1 else "hi"
print(f"-> Prompt: {prompt!r}")

req = urllib.request.Request(
    f"{API_URL}/assistant/chat",
    method="POST",
    headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {TOKEN}",
    },
    data=json.dumps(
        {"messages": [{"role": "user", "content": prompt}]}
    ).encode("utf-8"),
)
start = time.time()
with urllib.request.urlopen(req) as resp:
    body = json.loads(resp.read())
print(f"<- POST {resp.status} in {time.time()-start:.2f}s: {body}")

sid = body["sessionId"]
if body.get("status") == "complete":
    print("Synthetic-complete reply, no polling needed.")
    print(json.dumps(body, indent=2))
    sys.exit(0)

# Poll
poll_start = time.time()
while time.time() - poll_start < 120:
    time.sleep(2.5)
    poll_req = urllib.request.Request(
        f"{API_URL}/assistant/chat/{sid}",
        method="GET",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    with urllib.request.urlopen(poll_req) as p:
        pbody = json.loads(p.read())
    elapsed = time.time() - poll_start
    print(f"  [{elapsed:5.1f}s] status={pbody['status']}")
    if pbody["status"] in ("complete", "error"):
        print(json.dumps(pbody, indent=2))
        sys.exit(0)

print("Timed out polling.")
sys.exit(1)
