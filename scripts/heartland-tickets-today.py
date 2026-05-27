"""Verify the new tickets filter works against the live Heartland API."""
import boto3
import json
import urllib.parse
import urllib.request

sm = boto3.client("secretsmanager", region_name="us-east-1")
secret = json.loads(
    sm.get_secret_value(SecretId="foot-solutions/heartland/api-token")["SecretString"]
)
token = secret["token"]
base = secret["baseUrl"]


def fetch(path: str) -> dict:
    req = urllib.request.Request(
        f"{base}/{path}", headers={"Authorization": f"Bearer {token}"}
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


# Tickets via local_completed_at only — `completed?`/`voided?` aren't
# filterable (returns 400). Filter client-side after fetch.
filt = {
    "local_completed_at": {
        "$gte": "2026-05-23T00:00:00",
        "$lte": "2026-05-23T23:59:59",
    },
}
url = f"sales/tickets?per_page=200&_filter={urllib.parse.quote(json.dumps(filt))}"
data = fetch(url)
print(f"Today's complete-non-voided tickets: total={data['total']}")
total = sum(t["total"] for t in data["results"])
print(f"  Sum: ${total:.2f}")
fm_total = sum(
    t["total"] for t in data["results"] if t.get("source_location_id") == 100006
)
fm_count = sum(
    1 for t in data["results"] if t.get("source_location_id") == 100006
)
print(f"  Flower Mound only (client-filtered): {fm_count} tickets, ${fm_total:.2f}")
for t in data["results"][:5]:
    print(
        f"  id={t['id']} total=${t['total']} source_loc={t.get('source_location_id')} "
        f"local={t.get('local_completed_at')} voided={t.get('voided?')}"
    )
