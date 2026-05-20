import urllib.request, json, ssl, subprocess, sys

result = subprocess.run(['aws','secretsmanager','get-secret-value','--secret-id','foot-solutions/heartland/api-token','--query','SecretString','--output','text'],capture_output=True,text=True)
s = json.loads(result.stdout.strip())
base, token = s['baseUrl'], s['token']
ctx = ssl.create_default_context()

def get(path):
    req = urllib.request.Request(f'{base}/{path}', headers={'Authorization': 'Bearer ' + token})
    try:
        with urllib.request.urlopen(req, timeout=15, context=ctx) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {'error': e.code, 'body': e.read().decode()[:300]}
    except Exception as e:
        return {'error': str(e)}

# 1. Locations
locs = get('locations?per_page=50')
sys.stdout.write('=== LOCATIONS ===\n')
for loc in locs.get('results', []):
    sys.stdout.write(f"  id={loc['id']} name={loc.get('name')} public_id={loc.get('public_id')}\n")

# 2. Inventory values by location
sys.stdout.write('\n=== INVENTORY/VALUES by location ===\n')
inv = get('inventory/values?group[]=location_id')
sys.stdout.write(f"  status: {inv.get('error', '200')} total={inv.get('total')}\n")
for r in inv.get('results', [])[:5]:
    sys.stdout.write(f"  location_id={r.get('location_id')} qty_on_hand={r.get('qty_on_hand')} qty_available={r.get('qty_available')}\n")

# 3. Inventory values by item+location (exclude empty)
sys.stdout.write('\n=== INVENTORY/VALUES by item+location (exclude empty) ===\n')
inv2 = get('inventory/values?group[]=item_id&group[]=location_id&exclude_empty_locations=true&per_page=3')
sys.stdout.write(f"  status: {inv2.get('error', '200')} total={inv2.get('total')} pages={inv2.get('pages')}\n")
for r in inv2.get('results', [])[:3]:
    sys.stdout.write(f"  item_id={r.get('item_id')} location_id={r.get('location_id')} qty_on_hand={r.get('qty_on_hand')}\n")

# 4. Ticket lines
sys.stdout.write('\n=== TICKET LINES ===\n')
tickets = get('sales/tickets?per_page=50')
for t in tickets.get('results', []):
    if t.get('total', 0) > 0:
        tid = t['id']
        lines = get(f'sales/tickets/{tid}/lines?per_page=3')
        sys.stdout.write(f"  ticket {tid}: status={lines.get('error','200')} total={lines.get('total')}\n")
        if lines.get('results'):
            sys.stdout.write(f"  keys: {list(lines['results'][0].keys())[:10]}\n")
            sys.stdout.write(f"  sample: {json.dumps(lines['results'][0], indent=2)[:400]}\n")
        break

# 5. Purchasing vendors
sys.stdout.write('\n=== PURCHASING/VENDORS ===\n')
v = get('purchasing/vendors?per_page=3')
sys.stdout.write(f"  status: {v.get('error','200')} total={v.get('total')}\n")
if v.get('results'):
    sys.stdout.write(f"  sample: {v['results'][0]}\n")

# 6. Purchasing orders
sys.stdout.write('\n=== PURCHASING/ORDERS ===\n')
o = get('purchasing/orders?per_page=3')
sys.stdout.write(f"  status: {o.get('error','200')} total={o.get('total')}\n")

# 7. Reporting analyzer
sys.stdout.write('\n=== REPORTING/ANALYZER ===\n')
r = get('reporting/analyzer?metrics[]=source_sales.net_sales&groups[]=date.date&start_date=2026-05-01&end_date=2026-05-18')
sys.stdout.write(f"  status: {r.get('error','200')} total={r.get('total')}\n")
if r.get('results'):
    sys.stdout.write(f"  sample: {r['results'][0]}\n")

# 8. Tax rules
sys.stdout.write('\n=== SALES/TAX_RULES ===\n')
t = get('sales/tax_rules?per_page=3')
sys.stdout.write(f"  status: {t.get('error','200')} total={t.get('total')}\n")

sys.stdout.flush()
