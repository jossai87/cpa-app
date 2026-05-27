"""Count today's payments and tickets in Heartland."""
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


# Today's payments (filter by completed_at, status=complete)
filt = {
    "completed_at": {"$gte": "2026-05-23", "$lte": "2026-05-23"},
    "status": "complete",
}
url = f"payments?per_page=200&_filter={urllib.parse.quote(json.dumps(filt))}"
data = fetch(url)
print(f"Today's COMPLETE payments: total={data['total']}")
total_amount = sum(p["amount"] for p in data["results"])
print(f"  Sum of amounts: ${total_amount:.2f}")
for p in data["results"][:5]:
    print(
        f"  id={p['id']} amount=${p['amount']} type={p['type']} "
        f"completed_at={p['completed_at']} local={p.get('local_completed_at')}"
    )

# Try local_completed_at filter (Central time)
filt2 = {
    "local_completed_at": {
        "$gte": "2026-05-23T00:00:00",
        "$lte": "2026-05-23T23:59:59",
    },
    "status": "complete",
}
url2 = f"payments?per_page=200&_filter={urllib.parse.quote(json.dumps(filt2))}"
data2 = fetch(url2)
print(
    f"\nToday's COMPLETE payments (local_completed_at): total={data2['total']}"
)
total2 = sum(p["amount"] for p in data2["results"])
print(f"  Sum of amounts: ${total2:.2f}")

# Today's tickets via source_location_id
filtT = {
    "completed_at": {"$gte": "2026-05-23", "$lte": "2026-05-23"},
    "completed?": True,
    "voided?": False,
    "source_location_id": 100006,
}
url3 = f"sales/tickets?per_page=200&_filter={urllib.parse.quote(json.dumps(filtT))}"
dataT = fetch(url3)
print(f"\nToday's COMPLETE Flower Mound tickets: total={dataT['total']}")
totalT = sum(t["total"] for t in dataT["results"])
print(f"  Sum: ${totalT:.2f}")
