#!/usr/bin/env python3
"""
Diagnose child-app pairing failure ("sign in expired"):
 1. Worker health check
 2. Worker with garbage token  -> tells if service account is initialized
 3. Mint a REAL anonymous ID token from the APK's Firebase project via
    identitytoolkit REST (exactly what signInAnonymously does) and call
    confirmPairing with it -> tells if the Worker can verify that project's tokens.
"""
import json, urllib.request, urllib.error, sys

WORKER = "https://parental-control-api.ai-multitools.workers.dev"
GS = "/home/z/my-project/parental-control/android/app/google-services.json"

def req(url, method="GET", body=None, headers=None):
    r = urllib.request.Request(url, method=method, data=body, headers=headers or {})
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:
        return -1, str(e)

with open(GS) as f:
    gs = json.load(f)
api_key = gs["client"][0]["api_key"][0]["current_key"]
project = gs["project_info"]["project_id"]
print(f"[i] APK Firebase project: {project}")

print("\n=== 1. Worker health ===")
s, b = req(f"{WORKER}/api/health")
print(f"    HTTP {s}: {b[:200]}")

print("\n=== 2. Worker + garbage token (service-account init check) ===")
fake = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJkaWFndGVzdCJ9.garbage"
s, b = req(f"{WORKER}/api/secure/confirmPairing", "POST",
           json.dumps({"code": "AAAA2222", "deviceId": "diag-device", "deviceName": "diag"}).encode(),
           {"Authorization": f"Bearer {fake}", "Content-Type": "application/json"})
print(f"    HTTP {s}: {b[:300]}")

print("\n=== 3. Mint REAL anonymous ID token (same as child device) ===")
s, b = req(f"https://identitytoolkit.googleapis.com/v1/accounts:signUp?key={api_key}",
           "POST", json.dumps({"returnSecureToken": True}).encode(),
           {"Content-Type": "application/json"})
print(f"    signUp HTTP {s}: {b[:200]}")
try:
    tok = json.loads(b)
except Exception:
    print("    !! could not parse signUp response"); sys.exit(1)
if "idToken" not in tok:
    print("    !! no idToken — cannot test further"); sys.exit(1)
idt = tok["idToken"]
# decode payload for audit (no signature check needed, it's ours)
import base64
p = json.loads(base64.urlsafe_b64decode(idt.split(".")[1] + "=="))
print(f"    token aud={p.get('aud')} iss={p.get('iss')} sub={p.get('user_id')}")

print("\n=== 4. Worker confirmPairing with REAL token ===")
s, b = req(f"{WORKER}/api/secure/confirmPairing", "POST",
           json.dumps({"code": "AAAA2222", "deviceId": "diag-device", "deviceName": "diag"}).encode(),
           {"Authorization": f"Bearer {idt}", "Content-Type": "application/json"})
print(f"    HTTP {s}: {b[:300]}")
