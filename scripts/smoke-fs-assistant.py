"""Smoke test the deployed FS Assistant AgentCore Runtime.

Sends a parametric prompt and prints the orchestrator's reply, route,
and attachments. Used to validate the end-to-end Phase-1 container
deployment.

Usage:
  python3 scripts/smoke-fs-assistant.py            # default "hi"
  python3 scripts/smoke-fs-assistant.py "your question here"
  python3 scripts/smoke-fs-assistant.py "..." --admin
"""

import boto3
import json
import sys
import time
import uuid

RUNTIME_ARN = (
    "arn:aws:bedrock-agentcore:us-east-1:558985210319:runtime/fs_assistant-8CDEsz6n6T"
)

argv = sys.argv[1:]
is_admin = False
if "--admin" in argv:
    is_admin = True
    argv.remove("--admin")
prompt = argv[0] if argv else "hi"

client = boto3.client("bedrock-agentcore", region_name="us-east-1")

session_id = f"smoke-{uuid.uuid4()}-{int(time.time())}-padding-padding-padding"

payload = {
    "messages": [{"role": "user", "content": prompt}],
    "callerUserId": "smoke-test",
    "isAdmin": is_admin,
}

print(f"-> Prompt: {prompt!r}  (isAdmin={is_admin})")
print(f"-> Session: {session_id}")
start = time.time()
out = client.invoke_agent_runtime(
    agentRuntimeArn=RUNTIME_ARN,
    runtimeSessionId=session_id,
    runtimeUserId="smoke-test-user",
    contentType="application/json",
    accept="application/json",
    payload=json.dumps(payload).encode("utf-8"),
)
elapsed = time.time() - start

body = b""
resp = out["response"]
if hasattr(resp, "read"):
    body = resp.read()
else:
    for chunk in resp:
        if isinstance(chunk, bytes):
            body += chunk
        elif isinstance(chunk, dict):
            for v in chunk.values():
                if isinstance(v, dict) and "bytes" in v:
                    body += v["bytes"]
        else:
            body += bytes(chunk)

print(f"<- Got response in {elapsed:.2f}s ({len(body)} bytes)")
try:
    parsed = json.loads(body)
    print(json.dumps(parsed, indent=2, ensure_ascii=False))
except Exception:
    print(f"Raw body: {body[:500]!r}")
    raise
