#!/usr/bin/env python3
"""Mint a real anonymous ID token and test the worker via curl UA (edge-safe)."""
import json, subprocess, urllib.request

GS = "/home/z/my-project/parental-control/android/app/google-services.json"
WORKER = "https://parental-control-api.ai-multitools.workers.dev"

with open(GS) as f:
    gs = json.load(f)
api_key = gs["client"][0]["api_key"][0]["current_key"]

# mint real anonymous token (same as child device signInAnonymously)
r = urllib.request.Request(
    f"https://identitytoolkit.googleapis.com/v1/accounts:signUp?key={api_key}",
    method="POST", data=json.dumps({"returnSecureToken": True}).encode(),
    headers={"Content-Type": "application/json"})
with urllib.request.urlopen(r, timeout=30) as resp:
    tok = json.loads(resp.read().decode())
idt = tok["idToken"]
print(f"[i] token minted, uid={tok.get('localId')}")

# call worker with curl UA (python UA gets 1010-blocked at the edge)
out = subprocess.run([
    "curl", "-s", "--compressed", "-A", "curl/8.5.0",
    "-X", "POST", f"{WORKER}/api/secure/confirmPairing",
    "-H", "Content-Type: application/json",
    "-H", f"Authorization: Bearer {idt}",
    "-d", json.dumps({"code": "AAAA2222", "deviceId": "diag-device", "deviceName": "diag"}),
], capture_output=True, text=True, timeout=60)
print(f"HTTP body: {out.stdout}")
