/**
 * Initial (empty) local state — v1.4.0
 *
 * Production dashboard কোনো demo/simulated ডেটা ছাড়া খালি অবস্থায় শুরু হয়।
 * ডিভাইস পেয়ার হওয়ার পর আসল ডেটা (চাইল্ড অ্যাপ + Firestore/Cloud Functions)
 * এই state-এ প্রবাহিত হয়। স্যান্ডবক্স প্রিভিউতে ডিভাইস-শেল পরীক্ষার জন্য
 * devices-view-এর নিচে sandbox panel (শুধু demo mode) ব্যবহার করা যায়।
 */
import type {
  BackupPolicy,
  BackupStats,
  ChildDevice,
  FamilyState,
} from "./types";

export function emptyDevice(): ChildDevice {
  return {
    id: "device-unpaired",
    name: "—",
    childName: "—",
    childUid: "—",
    model: "—",
    manufacturer: "",
    ramTotalMb: null,
    storageTotalGb: null,
    androidVersion: "—",
    appVersion: "—",
    batteryLevel: 0,
    isCharging: false,
    networkType: "none",
    status: "offline",
    lastSeen: Date.now(),
    managementMode: "none",
    permissions: {
      location: false,
      notifications: false,
      usageAccess: false,
      camera: false,
      microphone: false,
      screenCapture: false,
      accessibility: false,
      deviceAdmin: false,
      backupMediaPhotos: false,
      backupMediaVideos: false,
      backupContacts: false,
      backupSms: false,
    },
    reliability: {
      backgroundStatus: "restricted",
      batteryOptimizationIgnored: false,
      notificationEnabled: false,
      lastHeartbeat: Date.now(),
      serviceStatus: "stopped",
      manufacturerNote: undefined,
    },
    policy: {
      version: 0,
      updatedAt: Date.now(),
      blockedApps: [],
      dailyLimits: {},
      bedtime: {
        enabled: false,
        start: "22:00",
        end: "07:00",
        days: [0, 1, 2, 3, 4, 5, 6],
        allowedApps: [],
      },
      locationTracking: false,
      settings: {
        hideAppIcon: false,
        protectSettings: false,
      },
    },
    locked: false,
    bedtimeActive: false,
    paired: false,
    appIconHidden: false,
  };
}

/** ডিভাইস পেয়ার হওয়ার পর চাইল্ড অ্যাপ onboarding থেকে যা রিপোর্ট করে */
export function pairedDeviceShell(id: string): ChildDevice {
  return {
    ...emptyDevice(),
    id,
    name: "নতুন ডিভাইস",
    childName: "সন্তান",
    childUid: `child-${id.slice(-8)}`,
    model: "Android ডিভাইস",
    manufacturer: "",
    ramTotalMb: null,
    storageTotalGb: null,
    androidVersion: "Android",
    appVersion: "Parent Control Child",
    batteryLevel: 70,
    networkType: "wifi",
    status: "online",
    lastSeen: Date.now(),
    // চাইল্ড onboarding-এর পর সাধারণত যা গ্রান্ট করা থাকে:
    // লোকেশন, নোটিফিকেশন, usage access, accessibility, device admin।
    // ক্যামেরা/মাইক/স্ক্রিন কনসেন্ট-ভিত্তিক — ব্যবহারের সময় চাইল্ড দেয়।
    permissions: {
      ...emptyDevice().permissions,
      location: true,
      notifications: true,
      usageAccess: true,
      accessibility: true,
      deviceAdmin: true,
    },
    managementMode: "admin",
    reliability: {
      backgroundStatus: "running",
      batteryOptimizationIgnored: true,
      notificationEnabled: true,
      lastHeartbeat: Date.now(),
      serviceStatus: "active",
      manufacturerNote: undefined,
    },
    locked: false,
    bedtimeActive: false,
    paired: true,
    appIconHidden: false,
  };
}

/** consent-first backup policy — সব ক্যাটাগরি ডিফল্ট OFF */
export function emptyBackupPolicy(): BackupPolicy {
  return {
    version: 0,
    updatedAt: Date.now(),
    updatedBy: "",
    categories: {
      photos: { enabled: false },
      videos: { enabled: false },
      contacts: { enabled: false },
      sms: { enabled: false },
    },
  };
}

export function emptyBackupStats(): BackupStats {
  return { totalBytes: 0, itemCounts: {}, lastBackupAt: {} };
}

export function initialState(): FamilyState {
  return {
    mode: "demo",
    parent: null,
    device: emptyDevice(),
    installedApps: [],
    usage: [],
    locations: [],
    notifications: [],
    emergencies: [],
    sessions: [],
    consentRequests: [],
    commands: [],
    auditLogs: [],
    pairing: null,
    backupPolicy: emptyBackupPolicy(),
    backupItems: [],
    backupStats: emptyBackupStats(),
    usageTrend: [],
  };
}
