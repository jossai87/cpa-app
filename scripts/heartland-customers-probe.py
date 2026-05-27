#!/usr/bin/env python3
"""
heartland-customers-probe.py

One-off probe to understand the shape of the /customers endpoint and how
many records the Flower Mound store has. Loads the API token from AWS
Secrets Manager (same secret the Lambdas use), pulls page 1, prints the
field names and count, then prints a sample customer with PII redacted.
"""

import json
import subprocess
import sys
import urllib.parse
import urllib.request

# Load Heartland secret from Secrets Manager
result = subprocess.run(
    [
        "aws", "secretsmanager", "get-secret-value",
        "--secret-id", "foot-solutions/heartland/api-token",
        "--region", "us-east-1",
        "--query", "SecretString",
        "--output", "text",
    ],
    capture_output=True, text=True, check=True,
)
secret = json.loads(result.stdout.strip())
base_url = secret["baseUrl"]
token = secret["token"]


def fetch(path: str, params: dict | None = None) -> dict:
    qs = "?" + urllib.parse.urlencode(params or {}) if params else ""
    url = f"{base_url}/{path}{qs}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


# Page 1 — explore the structure
print("=" * 60)
print("Probing /customers ...")
print("=" * 60)
r = fetch("customers", {"per_page": 5, "page": 1})
total = r.get("total", "?")
pages = r.get("pages", "?")
print(f"Total customers: {total}")
print(f"Total pages (per_page=5): {pages}")
print()

results = r.get("results", [])
if not results:
    print("No customers returned.")
    sys.exit(0)

print(f"Field names on a customer record:")
for k in sorted(results[0].keys()):
    print(f"  - {k}")
print()

# Print a redacted sample
def redact(val: object) -> object:
    if isinstance(val, str) and "@" in val:
        local, _, domain = val.partition("@")
        return f"{local[:2]}***@{domain}"
    if isinstance(val, str) and len(val) > 4 and any(c.isdigit() for c in val):
        # phone-ish
        return val[:3] + "*" * (len(val) - 3)
    if isinstance(val, str) and len(val) > 30:
        return val[:30] + "..."
    return val

print("Sample (PII redacted):")
print(json.dumps({k: redact(v) for k, v in results[0].items()}, indent=2, default=str))

# Count customers with email
print()
print("Counting customers with at least one email address ...")
with_email = 0
total_seen = 0
page = 1
while True:
    r = fetch("customers", {"per_page": 100, "page": page})
    rs = r.get("results", [])
    if not rs:
        break
    total_seen += len(rs)
    for c in rs:
        # The field might be `email`, `email_address`, or something nested.
        # Try common shapes:
        email = c.get("email") or c.get("email_address") or ""
        if isinstance(email, dict):
            email = email.get("address") or ""
        if email:
            with_email += 1
    if page >= r.get("pages", 1):
        break
    page += 1
    if page > 20:  # safety cap for the probe
        print("(probe capped at 20 pages)")
        break

print(f"  customers seen:          {total_seen}")
print(f"  customers with email:    {with_email}")
