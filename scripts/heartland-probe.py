"""Probe Heartland's /payments endpoint with various filters to find
the exact syntax their API accepts.

Run after setting up AWS auth so the script can fetch the API token
from Secrets Manager.
"""

import json
import sys
import urllib.parse
import urllib.request

import boto3

sm = boto3.client("secretsmanager", region_name="us-east-1")
secret = json.loads(
    sm.get_secret_value(SecretId="foot-solutions/heartland/api-token")["SecretString"]
)
token = secret["token"]
base = secret["baseUrl"]


def probe(label: str, query: str) -> None:
    url = f"{base}/{query}"
    req = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {token}"}
    )
    try:
        with urllib.request.urlopen(req) as r:
            body = r.read()
            print(f"  {label}: HTTP {r.status} — first 200 bytes:")
            print(f"    {body[:200].decode('utf-8', errors='replace')}")
    except urllib.error.HTTPError as e:
        body = e.read()
        print(f"  {label}: HTTP {e.code} — {body[:300].decode('utf-8', errors='replace')}")


def filter_url(filt: dict) -> str:
    return f"payments?per_page=1&_filter={urllib.parse.quote(json.dumps(filt))}"


print("== Probing Heartland filter syntax ==")
probe("baseline", "payments?per_page=1")
probe(
    "filter completed_at + location",
    filter_url({"completed_at": {"$gte": "2026-04-18", "$lte": "2026-05-23"}, "location_id": 100006}),
)
probe(
    "filter completed_at only",
    filter_url({"completed_at": {"$gte": "2026-04-18", "$lte": "2026-05-23"}}),
)
probe(
    "filter location only",
    filter_url({"location_id": 100006}),
)
probe(
    "filter local_completed_at",
    filter_url({"local_completed_at": {"$gte": "2026-04-18T00:00:00", "$lte": "2026-05-23T23:59:59"}}),
)
probe(
    "filter completed_at with full ISO timestamp",
    filter_url({"completed_at": {"$gte": "2026-04-18T00:00:00Z", "$lte": "2026-05-23T23:59:59Z"}}),
)
probe(
    "filter created_at",
    filter_url({"created_at": {"$gte": "2026-04-18"}}),
)
probe(
    "filter status complete",
    filter_url({"status": "complete"}),
)
