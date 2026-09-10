#!/usr/bin/env python3
"""FULL E2E pairing test through the production system (no debug routes).
1. Create parent (email/password signUp) -> parent ID token
2. profile call (lazy users/{uid} provisioning -> set merge)
3. generatePairingCode (rate-limit tx + count aggregation + set serverTimestamp)
4. Create child (anonymous signUp) -> child ID token
5. confirmPairing (runTransaction: read code, write device/children, update code)
"""
import json, urllib.request, urllib.error, subprocess, uuid, os

GS = "/home/z/my-project/parental-control/android/app/google-services.json"
WORKER = os.environ.get("WORKER_BASE", "https://parental-control-api.ai-multitools.workers.dev")
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

# 1. parent user
suffix = "e2e1113"
p = idt_call("accounts:signUp", {"email": f"e2e-parent-{suffix}@test-setbd.com", "password": "E2eTest!918x", "returnSecureToken": True})
if "idToken" not in p:
    # exists → sign in
    p = idt_call("accounts:signInWithPassword", {"email": f"e2e-parent-{suffix}@test-setbd.com", "password": "E2eTest!918x", "returnSecureToken": True})
print("1. parent:", "OK uid=" + p.get("localId", "?") if "idToken" in p else json.dumps(p)[:200])
parent_tok = p["idToken"]

# 2. profile (provisions users/{uid})
r = worker_call("profile", parent_tok, {})
print("2. profile:", r[:120])

# 3. generate pairing code
r = worker_call("generatePairingCode", parent_tok, {})
print("3. generatePairingCode:", r[:900])
code = ""
try:
    code = json.loads(r)["data"].get("code", "")
except Exception:
    pass
if not code:
    print("!! no code — stopping"); raise SystemExit(1)
print("   code =", code)

# 4. child anonymous
c = idt_call("accounts:signUp", {"returnSecureToken": True})
print("4. child anonymous:", "OK uid=" + c.get("localId", "?") if "idToken" in c else json.dumps(c)[:200])
child_tok = c["idToken"]

# 5. confirmPairing
import time
device_id = str(uuid.uuid4())
r = worker_call("confirmPairing", child_tok, {"code": code, "deviceId": device_id, "deviceName": "E2E Test Device"})
print("5. confirmPairing:", r[:300])
try:
    ok = json.loads(r).get("ok")
except Exception:
    ok = False
print()
print("=" * 60)
print("E2E RESULT:", "✅ PAIRING WORKS END-TO-END" if ok else "❌ STILL FAILING")
