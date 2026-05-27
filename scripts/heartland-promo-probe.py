import json, subprocess, urllib.request

r = subprocess.run(
    ["aws", "secretsmanager", "get-secret-value",
     "--secret-id", "foot-solutions/heartland/api-token",
     "--region", "us-east-1",
     "--query", "SecretString", "--output", "text"],
    capture_output=True, text=True, check=True,
)
secret = json.loads(r.stdout.strip())
url = f"{secret['baseUrl']}/customers?per_page=50&page=1"
req = urllib.request.Request(url, headers={"Authorization": f"Bearer {secret['token']}"})
data = json.loads(urllib.request.urlopen(req).read())

counts = {"true": 0, "false": 0, "null/missing": 0}
for c in data["results"]:
    v = c.get("promotional_emails?")
    if v is True:
        counts["true"] += 1
    elif v is False:
        counts["false"] += 1
    else:
        counts["null/missing"] += 1
print("promotional_emails? distribution in first 50:", counts)
print()
print("Sample with email:")
shown = 0
for c in data["results"]:
    if c.get("email") and shown < 8:
        name = (c.get("first_name") or "")[:15]
        email = c["email"][:30]
        promo = c.get("promotional_emails?")
        print(f"  {name:15} | email={email:30} | promo={promo!r}")
        shown += 1
