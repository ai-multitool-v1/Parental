#!/usr/bin/env python3
"""Test worker edge behavior with different User-Agents + real token verification."""
import json, urllib.request, urllib.error

WORKER = "https://parental-control-api.ai-multitools.workers.dev"
GS = "/home/z/my-project/parental-control/android/app/google-services.json"
with open(GS) as f:
    gs = json.load(f)
api_key = gs["client"][0]["api_key"][0]["current_key"]

def req(url, method="GET", body=None, headers=None, trunc=150):
    r = urllib.request.Request(url, method=method, data=body, headers=headers or {})
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, resp.read().decode()[:trunc] if trunc else resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:trunc] if trunc else e.read().decode()
    except Exception as e:
        return -1, str(e)[:100]

# mint a real token once
s, b = req(f"https://identitytoolkit.googleapis.com/v1/accounts:signUp?key={api_key}",
           "POST", json.dumps({"returnSecureToken": True}).encode(),
           {"Content-Type": "application/json"}, trunc=0)
idt = json.loads(b).get("idToken", "") if s == 200 else ""
print(f"[i] real token minted: {bool(idt)}")

uas = {
    "python-urllib (default)": "Python-urllib/3.11",
    "curl": "curl/8.5.0",
    "Dalvik (child app!)": "Dalvik/2.1.0 (Linux; U; Android 13; SM-A125F Build/TP1A.220624.014)",
    "Chrome desktop": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
}
print("\n=== health endpoint per User-Agent ===")
for name, ua in uas.items():
    s, b = req(f"{WORKER}/api/health", headers={"User-Agent": ua})
    print(f"  {name:28s} -> HTTP {s}: {b}")

print("\n=== confirmPairing with REAL token, per User-Agent ===")
for name, ua in uas.items():
    s, b = req(f"{WORKER}/api/secure/confirmPairing", "POST",
               json.dumps({"code": "AAAA2222", "deviceId": "diag-device", "deviceName": "diag"}).encode(),
               {"Authorization": f"Bearer {idt}", "Content-Type": "application/json", "User-Agent": ua})
    print(f"  {name:28s} -> HTTP {s}: {b}")
