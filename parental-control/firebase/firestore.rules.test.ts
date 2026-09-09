/**
 * firestore.rules.test.ts — security-rules unit tests for the §38 matrix.
 *
 * Run (requires Java for the emulator):
 *   cd parental-control/firebase
 *   npm install
 *   npm test
 *
 * Fixtures:
 *   DEVICE_A paired to parentA (childUid: childA)
 *   DEVICE_B paired to parentB (childUid: childB)
 *   Custom claims { deviceRole: "childDevice", deviceId } emulate the
 *   tokens confirmPairing sets via setCustomUserClaims.
 *
 * Test IDs map 1:1 onto the TEST MATRIX comment block in firestore.rules
 * and onto docs/testing.md.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Timestamp, serverTimestamp } from "firebase/firestore";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from "@firebase/rules-unit-testing";

const DEVICE_A = "11111111-1111-4111-8111-111111111111";
const DEVICE_B = "22222222-2222-4222-8222-222222222222";
const NOW = Timestamp.fromMillis(Date.parse("2025-01-01T00:00:00Z"));

let testEnv: RulesTestEnvironment;

/* ───────────────────────── setup & fixtures ───────────────────────── */

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "pc-rules-unit-test",
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, "firestore.rules"), "utf8"),
    },
  });
  await seed();
});

afterAll(async () => {
  await testEnv.cleanup();
});

async function seed(): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const admin = ctx.firestore();

    // Parent profiles.
    await admin.doc("users/parentA").set({
      uid: "parentA", role: "parent", email: "a@example.com", createdAt: NOW,
    });
    await admin.doc("users/parentB").set({
      uid: "parentB", role: "parent", email: "b@example.com", createdAt: NOW,
    });

    // Two devices, each paired to exactly one parent.
    for (const [deviceId, parentUid] of [
      [DEVICE_A, "parentA"],
      [DEVICE_B, "parentB"],
    ] as const) {
      await admin.doc(`devices/${deviceId}`).set({
        deviceId,
        ownerParentUid: parentUid,
        childUid: `child_${parentUid}`,
        deviceName: `Device of ${parentUid}`,
        status: "ACTIVE",
        pairedAt: NOW,
        policyVersion: 1,
      });
      await admin.doc(`devices/${deviceId}/parents/${parentUid}`).set({
        parentUid, role: "parent", pairedAt: NOW,
      });
      await admin.doc(`devices/${deviceId}/policies/current`).set({
        version: 1, screenTimeMinutes: 60, updatedAt: NOW,
      });
      await admin.doc(`devices/${deviceId}/commands/cmd1`).set({
        commandId: "cmd1",
        deviceId,
        type: "REQUEST_LOCATION",
        payload: {},
        createdBy: parentUid,
        createdAt: NOW,
        expiresAt: Timestamp.fromMillis(NOW.toMillis() + 300_000),
        status: "PENDING",
        result: null,
      });
      await admin.doc(`devices/${deviceId}/emergencyAlerts/x`).set({
        eventId: "x",
      }); // placeholder path shadow — removed below (top-level is the real one)
    }
    await admin.doc(`devices/${DEVICE_A}/emergencyAlerts/x`).delete();

    // Child linkage.
    await admin.doc("children/child_parentA").set({
      childUid: "child_parentA", deviceId: DEVICE_A, parentUid: "parentA", createdAt: NOW,
    });

    // Top-level denormalized alert owned by parentA.
    await admin.doc("emergencyAlerts/alert1").set({
      eventId: "alert1",
      deviceId: DEVICE_A,
      deviceName: "Device of parentA",
      type: "SOS",
      message: "Help",
      parentUids: ["parentA"],
      acknowledged: false,
      createdAt: NOW,
      reminderCount: 0,
    });
  });
}

/* ───────────────────────── context helpers ────────────────────────── */

const parent = (uid: string) =>
  testEnv.authenticatedContext(uid, { email: `${uid}@example.com` }).firestore();

const childDevice = (uid: string, deviceId: string) =>
  testEnv
    .authenticatedContext(uid, {
      token: { deviceRole: "childDevice", deviceId },
    })
    .firestore();

const anon = () => testEnv.unauthenticatedContext().firestore();

const deviceADoc = `devices/${DEVICE_A}`;
const deviceBDoc = `devices/${DEVICE_B}`;

/* ═══════════════════════════ §38 matrix ═════════════════════════════ */

describe("§38.1 tenant isolation (Parent A vs Parent B)", () => {
  it("T01 parentA can read their paired device", async () => {
    await assertSucceeds(parent("parentA").doc(deviceADoc).get());
  });

  it("T02 parentB CANNOT read device A", async () => {
    await assertFails(parent("parentB").doc(deviceADoc).get());
  });

  it("T03 parentB lists devices filtered to their own ownership", async () => {
    const q = parent("parentB")
      .collection("devices")
      .where("ownerParentUid", "==", "parentB");
    await assertSucceeds(q.get());
  });

  it("T04 parentA CANNOT list devices unfiltered", async () => {
    await assertFails(parent("parentA").collection("devices").get());
  });

  it("T18 parentB CANNOT read device A locations", async () => {
    await assertFails(parent("parentB").collection(`${deviceADoc}/locations`).get());
    await assertFails(
      parent("parentB").collection(`${deviceADoc}/locations`).doc("l1").get()
    );
  });
});

describe("§38.2 device self-update (no self-escalation)", () => {
  it("T05 child device A can update its own status/lastSeenAt", async () => {
    await assertSucceeds(
      childDevice("childA", DEVICE_A).doc(deviceADoc).update({
        status: "ACTIVE",
        lastSeenAt: serverTimestamp(),
      })
    );
  });

  it("T06 child device A CANNOT change ownerParentUid / childUid / pairedAt", async () => {
    const dev = childDevice("childA", DEVICE_A).doc(deviceADoc);
    await assertFails(dev.update({ ownerParentUid: "parentB" }));
    await assertFails(dev.update({ childUid: "hackerChild" }));
    await assertFails(dev.update({ pairedAt: NOW }));
  });

  it("T07 parents have NO direct device writes (must use functions)", async () => {
    await assertFails(parent("parentA").doc(deviceADoc).update({ status: "LOCKED" }));
  });
});

describe("§38.3 commands: whitelist surface + client-create ban", () => {
  it("T08 anonymous CANNOT create a command", async () => {
    await assertFails(anon().collection(`${deviceADoc}/commands`).add({ type: "LOCK_DEVICE" }));
  });

  it("T09 even a paired parent CANNOT create commands via client (callable only)", async () => {
    await assertFails(
      parent("parentA").collection(`${deviceADoc}/commands`).doc("cmd9").set({
        commandId: "cmd9",
        type: "LOCK_DEVICE",
        createdBy: "parentA",
      })
    );
  });

  it("T10 device can only flip command status", async () => {
    await assertSucceeds(
      childDevice("childA", DEVICE_A).doc(`${deviceADoc}/commands/cmd1`)
        .update({ status: "DELIVERED" })
    );
  });

  it("T11 device CANNOT rewrite command result/createdBy/type", async () => {
    const cmd = childDevice("childA", DEVICE_A).doc(`${deviceADoc}/commands/cmd1`);
    await assertFails(cmd.update({ result: { hacked: true } }));
    await assertFails(cmd.update({ createdBy: "childA" }));
    await assertFails(cmd.update({ type: "LOCK_DEVICE" }));
  });

  it("T12 device CANNOT update commands on another device", async () => {
    await assertFails(
      childDevice("childA", DEVICE_A).doc(`${deviceBDoc}/commands/cmd1`)
        .update({ status: "EXECUTED" })
    );
  });
});

describe("§38.4 commandResults (device-only reports)", () => {
  it("T12b device creates a result for its own command", async () => {
    await assertSucceeds(
      childDevice("childA", DEVICE_A).collection(`${deviceADoc}/commandResults`).add({
        commandId: "cmd1",
        deviceId: DEVICE_A,
        status: "EXECUTED",
        result: { ok: true },
      })
    );
  });

  it("T13 parent CANNOT create commandResults", async () => {
    await assertFails(
      parent("parentA").collection(`${deviceADoc}/commandResults`).add({
        commandId: "cmd1",
        deviceId: DEVICE_A,
        status: "FAILED",
      })
    );
  });
});

describe("§38.5 telemetry isolation (device identity writes its own data only)", () => {
  it("T14 device A writes its own location", async () => {
    await assertSucceeds(
      childDevice("childA", DEVICE_A).collection(`${deviceADoc}/locations`).add({
        deviceId: DEVICE_A,
        lat: 52.52,
        lng: 13.405,
        timestamp: serverTimestamp(),
        accuracy: 12,
      })
    );
  });

  it("T15 device A CANNOT write device B telemetry", async () => {
    await assertFails(
      childDevice("childA", DEVICE_A).collection(`${deviceBDoc}/locations`).add({
        deviceId: DEVICE_B,
        lat: 1,
        lng: 2,
        timestamp: serverTimestamp(),
      })
    );
    await assertFails(
      childDevice("childA", DEVICE_A).collection(`${deviceBDoc}/appUsage`).add({
        deviceId: DEVICE_B,
        appPackage: "com.example",
      })
    );
  });

  it("T16 parent CANNOT fabricate device telemetry", async () => {
    await assertFails(
      parent("parentA").collection(`${deviceADoc}/locations`).add({
        deviceId: DEVICE_A,
        lat: 1,
        lng: 2,
        timestamp: serverTimestamp(),
      })
    );
  });

  it("T17 telemetry is append-only: no update/delete (history can't be rewritten)", async () => {
    const dev = childDevice("childA", DEVICE_A);
    const loc = dev.collection(`${deviceADoc}/locations`).doc("loc1");
    await assertFails(loc.update({ lat: 0 }));
    await assertFails(loc.delete());
    const usage = dev.collection(`${deviceADoc}/appUsage`).doc("u1");
    await assertFails(usage.update({ minutes: 999 }));
  });
});

describe("§38.6 pairingCodes are server-only secrets", () => {
  it("T19 nobody can read pairing codes (anonymous or signed in)", async () => {
    await assertFails(anon().collection("pairingCodes").get());
    await assertFails(anon().doc("pairingCodes/ABCDEFGH").get());
    await assertFails(parent("parentA").doc("pairingCodes/ABCDEFGH").get());
  });

  it("T20 nobody can write pairing codes from a client", async () => {
    await assertFails(
      parent("parentA").doc("pairingCodes/ZZZZZZZZ").set({ parentUid: "parentA" })
    );
  });
});

describe("§38.7 sessions are function-managed (consent state machine)", () => {
  it("T21 clients (parent OR device) cannot write sessions", async () => {
    await assertFails(
      parent("parentA").collection(`${deviceADoc}/sessions`).doc("s1").set({
        type: "CAMERA", state: "ACTIVE",
      })
    );
    await assertFails(
      childDevice("childA", DEVICE_A).collection(`${deviceADoc}/sessions`).doc("s2")
        .set({ type: "SCREEN", state: "ACTIVE" })
    );
  });

  it("…but both may read session state", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`${deviceADoc}/sessions/sRead`).set({
        sessionId: "sRead", type: "SCREEN", state: "ENDED", requestedAt: NOW,
      });
    });
    await assertSucceeds(parent("parentA").doc(`${deviceADoc}/sessions/sRead`).get());
    await assertSucceeds(
      childDevice("childA", DEVICE_A).doc(`${deviceADoc}/sessions/sRead`).get()
    );
  });
});

describe("§38.8 emergency: device-only SOS, parent-only acknowledgement", () => {
  it("T22 device creates its own SOS event", async () => {
    await assertSucceeds(
      childDevice("childA", DEVICE_A).collection(`${deviceADoc}/emergencyEvents`).add({
        deviceId: DEVICE_A,
        type: "SOS",
        message: "Help me",
        timestamp: serverTimestamp(),
      })
    );
  });

  it("T23 parent acknowledges an SOS (limited fields only)", async () => {
    const ev = testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection(`${deviceADoc}/emergencyEvents`).doc("ev1").set({
        deviceId: DEVICE_A, type: "SOS", acknowledged: false, timestamp: NOW,
      });
    });
    await ev;
    await assertSucceeds(
      parent("parentA").doc(`${deviceADoc}/emergencyEvents/ev1`).update({
        acknowledged: true,
        acknowledgedBy: "parentA",
        acknowledgedAt: serverTimestamp(),
      })
    );
  });

  it("T24 device CANNOT update emergency events (no withdrawal/spoofing)", async () => {
    await assertFails(
      childDevice("childA", DEVICE_A).doc(`${deviceADoc}/emergencyEvents/ev1`)
        .update({ acknowledged: true })
    );
  });

  it("T34/T35 top-level alerts: linked parent may ack, others denied", async () => {
    await assertSucceeds(
      parent("parentA").doc("emergencyAlerts/alert1").update({
        acknowledged: true,
        acknowledgedBy: "parentA",
        acknowledgedAt: serverTimestamp(),
      })
    );
    await assertFails(
      parent("parentB").doc("emergencyAlerts/alert1").update({ acknowledged: true })
    );
    await assertFails(
      parent("parentB").doc("emergencyAlerts/alert1").get()
    );
  });
});

describe("§38.10 WebRTC signaling envelopes (audit v1.1.1)", () => {
  const sessionDoc = `${deviceADoc}/sessions/sessionA1`;

  it("T36 device may APPEND a validated signal envelope (from=child)", async () => {
    await assertSucceeds(
      childDevice("childA", DEVICE_A)
        .doc(`${sessionDoc}/signals/sig1`)
        .set({
          kind: "offer",
          sdp: "v=0 ...".repeat(10),
          sdpType: "offer",
          from: "child",
          createdAt: serverTimestamp(),
        })
    );
  });

  it("T37 device CANNOT spoof the parent identity in signals", async () => {
    await assertFails(
      childDevice("childA", DEVICE_A)
        .doc(`${sessionDoc}/signals/sig2`)
        .set({ kind: "answer", sdp: "v=0 ...", from: "parent", createdAt: serverTimestamp() })
    );
  });

  it("T37b outsiders (unpaired parent B / anon) cannot write signals", async () => {
    await assertFails(
      parent("parentB")
        .doc(`${sessionDoc}/signals/sig3`)
        .set({ kind: "candidate", candidateSdp: "x", from: "parent", createdAt: serverTimestamp() })
    );
    await assertFails(
      anon()
        .doc(`${sessionDoc}/signals/sig4`)
        .set({ kind: "bye", from: "parent", createdAt: serverTimestamp() })
    );
  });

  it("T37c oversized SDP payloads are rejected", async () => {
    await assertFails(
      childDevice("childA", DEVICE_A)
        .doc(`${sessionDoc}/signals/sig5`)
        .set({
          kind: "offer",
          sdp: "A".repeat(40_000), // > 32 KiB cap
          from: "child",
          createdAt: serverTimestamp(),
        })
    );
  });

  it("T38 session documents remain function-only (no client update)", async () => {
    await assertFails(
      childDevice("childA", DEVICE_A)
        .doc(sessionDoc)
        .update({ state: "ENDED", endReason: "CHILD_STOPPED" })
    );
    await assertFails(
      childDevice("childA", DEVICE_A)
        .doc(sessionDoc)
        .set({ state: "ACTIVE", consent: { granted: true } }, { merge: true })
    );
  });
});

describe("§38.9 tamper-evident audit logs", () => {
  it("T25 device appends its own audit entries with a server timestamp", async () => {
    await assertSucceeds(
      childDevice("childA", DEVICE_A).collection(`${deviceADoc}/auditLogs`).add({
        deviceId: DEVICE_A,
        action: "POLICY_APPLIED",
        createdAt: serverTimestamp(), // must equal request.time (rule-enforced)
      })
    );
  });

  it("T26 nobody updates or deletes audit entries (append-only)", async () => {
    const dev = childDevice("childA", DEVICE_A);
    const log = dev.collection(`${deviceADoc}/auditLogs`).doc("log1");
    await assertFails(log.update({ action: "TAMPERED" }));
    await assertFails(log.delete());
    await assertFails(parent("parentA").doc(`${deviceADoc}/auditLogs/log1`).delete());
  });

  it("T27 parent A reads device audit trail; parent B denied", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection(`${deviceADoc}/auditLogs`).doc("log2").set({
        deviceId: DEVICE_A, action: "PAIR_DEVICE", createdAt: NOW,
      });
    });
    await assertSucceeds(parent("parentA").doc(`${deviceADoc}/auditLogs/log2`).get());
    await assertFails(parent("parentB").doc(`${deviceADoc}/auditLogs/log2`).get());
  });

  it("T28 platform-wide audit mirror is fully client-invisible", async () => {
    await assertFails(parent("parentA").collection("auditLogs").get());
    await assertFails(anon().collection("auditLogs").add({ action: "X" }));
  });
});

describe("§38.10 user profiles & children linkage", () => {
  it("T29 parent edits whitelisted fields of own profile", async () => {
    await assertSucceeds(
      parent("parentA").doc("users/parentA").update({
        displayName: "Alex",
        updatedAt: serverTimestamp(),
      })
    );
  });

  it("T30 parent CANNOT self-escalate (role / accountLocked)", async () => {
    await assertFails(parent("parentA").doc("users/parentA").update({ role: "superparent" }));
    await assertFails(parent("parentA").doc("users/parentA").update({ accountLocked: false }));
  });

  it("T31/T32 no cross-reading, no client deletion of profiles", async () => {
    await assertFails(parent("parentB").doc("users/parentA").get());
    await assertFails(parent("parentA").doc("users/parentA").delete());
  });

  it("T33 parent reads own child links; writes are function-only", async () => {
    await assertSucceeds(parent("parentA").doc("children/child_parentA").get());
    await assertFails(
      parent("parentA").doc("children/child_parentA").update({ parentUid: "parentB" })
    );
  });
});

describe("§38.11 policies & notifications", () => {
  it("policy docs readable by parent + device, writable by nobody", async () => {
    await assertSucceeds(parent("parentA").doc(`${deviceADoc}/policies/current`).get());
    await assertSucceeds(
      childDevice("childA", DEVICE_A).doc(`${deviceADoc}/policies/current`).get()
    );
    await assertFails(
      parent("parentA").doc(`${deviceADoc}/policies/current`).update({ screenTimeMinutes: 0 })
    );
  });

  it("notifications readable by both sides, writable by nobody (function-only)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection(`${deviceADoc}/notifications`).doc("n1").set({
        title: "Dinner time", body: "Come home", createdAt: NOW,
      });
    });
    await assertSucceeds(parent("parentA").doc(`${deviceADoc}/notifications/n1`).get());
    await assertFails(
      parent("parentA").doc(`${deviceADoc}/notifications/n1`).update({ read: true })
    );
  });
});
