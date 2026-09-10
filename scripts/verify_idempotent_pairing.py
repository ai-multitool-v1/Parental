#!/usr/bin/env python3
"""Verify idempotent generatePairingCode: two calls with same parent must
return the SAME code (second with reused:true). Also confirms pairing still
works end-to-end after the worker update."""
import json, urllib.request, urllib.error, subprocess, uuid, time

GS = "/home/z/my-project/parental-control/android/app/google-services.json"
WORKER = "https://parental-control-api.ai-multitools.workers.dev"
with open(GS) as f:
    api_key = json.load(f)["client"][0]["api_key"][0]["current_key"]

def idt_call(path, body):
    r = urllib.request.Request(f"https://identitytoolkit.googleapis.com/v1/{path}?key={api_key}",
        method="POST", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return {"error": json.loads(e.read().decode())}

def worker_call(name, token, payload):
    out = subprocess.run(["curl", "-s", "--compressed", "-A", "curl/8.5.0",
        "-X", "POST", f"{WORKER}/api/secure/{name}",
        "-H", "Content-Type: application/json",
        "-H", f"Authorization: Bearer {token}",
        "-d", json.dumps(payload)], capture_output=True, text=True, timeout=90)
    return out.stdout

p = idt_call("accounts:signInWithPassword", {"email": "e2e-parent-e2e1113@test-setbd.com", "password": "E2eTest!918x", "returnSecureToken": True})
if "idToken" not in p:
    print("parent signin failed:", json.dumps(p)[:200]); raise SystemExit(1)
tok = p["idToken"]

# wait for worker CI redeploy: poll until generatePairingCode responds with reused:true on 2nd call
print("calling generatePairingCode #1 ...")
r1 = worker_call("generatePairingCode", tok, {})
print("  →", r1[:160])
time.sleep(2)
print("calling generatePairingCode #2 ...")
r2 = worker_call("generatePairingCode", tok, {})
print("  →", r2[:160])
try:
    d1, d2 = json.loads(r1), json.loads(r2)
    same = d1["data"]["code"] == d2["data"]["code"]
    reused = d2["data"].get("reused") is True
    print()
    print("=" * 60)
    print("IDEMPOTENT:", "✅ same code returned" if same and reused else f"❌ code1={d1['data'].get('code')} code2={d2['data'].get('code')} reused={reused}")
except Exception as e:
    print("parse fail:", e)

# also verify confirmPairing still works with the reused code
c = idt_call("accounts:signUp", {"returnSecureToken": True})
r = worker_call("confirmPairing", c["idToken"], {"code": d2["data"]["code"], "deviceId": str(uuid.uuid4()), "deviceName": "Idem Test"})
print("confirmPairing with reused code:", r[:140])
