/**
 * Family Safety Platform — shared domain types (parent dashboard + demo engine)
 *
 * এই types গুলো Firestore schema-র সাথে ১:১ মেলে (docs/architecture.md দেখুন)।
 * Demo mode-এ একই shape ব্যবহার করা হয় যাতে real Firebase integration-এ
 * শুধু service layer বদলালেই চলে।
 */

export type DeviceStatus = "online" | "recently_active" | "offline";

export type PermissionKey =
  | "location"
  | "notifications"
  | "usageAccess"
  | "camera"
  | "microphone"
  | "screenCapture"
  | "accessibility"
  | "deviceAdmin"
  // v1.3.0 — backup module runtime permissions (child-side consent state)
  | "backupMediaPhotos"
  | "backupMediaVideos"
  | "backupContacts"
  | "backupSms";

export type FeatureSupport =
  | "supported"
  | "conditionally_supported"
  | "unsupported";

export type ManagementMode =
  | "device_owner"
  | "profile_owner"
  | "admin"
  | "none";

export type SessionType = "screen" | "camera" | "audio" | "safety";

export type SessionState =
  | "inactive"
  | "requesting"
  | "waiting_child"
  | "active"
  | "ended"
  | "declined"
  | "expired";

/** Command whitelist — এর বাইরে কোনো command engine-এ গ্রহণ করা হয় না (spec §27) */
export const COMMAND_TYPES = [
  "SYNC_POLICY",
  "REQUEST_STATUS",
  "REQUEST_LOCATION",
  "LOCK_DEVICE",
  "SEND_NOTIFICATION",
  "SYNC_APPS",
  "SYNC_USAGE",
  "REQUEST_PERMISSION",
  "REQUEST_SCREEN_SESSION",
  "STOP_SCREEN_SESSION",
  "REQUEST_CAMERA_SESSION",
  "STOP_CAMERA_SESSION",
  "REQUEST_AUDIO_SESSION",
  "STOP_AUDIO_SESSION",
  "TRIGGER_SAFETY_CHECK",
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];

export type CommandStatus = "pending" | "executing" | "executed" | "failed" | "expired";

/* ══════════════ v1.4.0 — Free / Premium plan system ══════════════
 * ফ্রি ইউজার: overview, devices, location, apps, screen-time, restrictions,
 * bedtime, notifications, SOS।
 * প্রিমিয়াম-অনলি: device control (lock/management), screen sharing, camera,
 * audio/video session, cloud backup। প্রিমিয়াম ইউজার সব ফিচার ব্যবহার করতে পারে।
 * Server-side enforcement: dispatchCommand / requestSession / backup callables
 * (functions) users/{uid}.plan চেক করে — client-side gate শুধু UX।
 */
export type UserPlan = "free" | "premium";

/** এই command গুলো শুধু premium parent dispatch করতে পারে */
export const PREMIUM_COMMANDS: readonly CommandType[] = [
  "LOCK_DEVICE",
  "REQUEST_SCREEN_SESSION",
  "REQUEST_CAMERA_SESSION",
  "REQUEST_AUDIO_SESSION",
  "TRIGGER_SAFETY_CHECK",
];

export type CommandResultCode =
  | "OK"
  | "DEVICE_OFFLINE"
  | "PERMISSION_REQUIRED"
  | "UNSUPPORTED"
  | "DENIED"
  | "EXPIRED"
  | "REPLAY_BLOCKED"
  | "RATE_LIMITED";

export interface Parent {
  uid: string;
  name: string;
  email: string;
  mfaEnabled: boolean;
  loginAt: number;
  /** v1.4.0 — free users: বেসিক ফিচার; premium: সব ফিচার (server-enforced) */
  plan: UserPlan;
}

export interface DevicePermissions {
  location: boolean;
  notifications: boolean;
  usageAccess: boolean;
  camera: boolean;
  microphone: boolean;
  screenCapture: boolean;
  /** App Guard accessibility service (app blocking + bedtime enforcement) */
  accessibility: boolean;
  /** Device admin (uninstall protection + remote lockNow) */
  deviceAdmin: boolean;
  /** v1.3.0 — backup module runtime permissions (false = module stops) */
  backupMediaPhotos: boolean;
  backupMediaVideos: boolean;
  backupContacts: boolean;
  backupSms: boolean;
}

export interface ReliabilityStatus {
  backgroundStatus: "running" | "restricted";
  batteryOptimizationIgnored: boolean;
  notificationEnabled: boolean;
  lastHeartbeat: number;
  serviceStatus: "active" | "stopped";
  manufacturerNote?: string;
}

export interface BedtimePolicy {
  enabled: boolean;
  start: string; // "22:00"
  end: string; // "07:00"
  days: number[]; // 0=Sunday … 6=Saturday
  allowedApps: string[]; // package names allowed during bedtime
}

export interface DevicePolicy {
  version: number;
  updatedAt: number;
  blockedApps: string[];
  /** packageName -> দৈনিক সীমা (মিনিট) */
  dailyLimits: Record<string, number>;
  bedtime: BedtimePolicy;
  locationTracking: boolean;
  /** Device-management settings — official DevicePolicyManager APIs only. */
  settings: {
    /** Official setApplicationHidden (Device Owner, API 28+) — icon hide.
     *  App pauses while hidden; reopened by dialing *#*#1111#*#*. */
    hideAppIcon: boolean;
    /** App Guard blocks the Settings app while on (anti-tamper). */
    protectSettings: boolean;
  };
}

export interface ChildDevice {
  id: string;
  name: string;
  childName: string;
  childUid: string;
  model: string;
  /** v1.4.2 — real device identity from the child heartbeat */
  manufacturer: string;
  ramTotalMb: number | null;
  storageTotalGb: number | null;
  androidVersion: string;
  appVersion: string;
  batteryLevel: number;
  isCharging: boolean;
  networkType: "wifi" | "mobile" | "none";
  status: DeviceStatus;
  lastSeen: number;
  managementMode: ManagementMode;
  permissions: DevicePermissions;
  reliability: ReliabilityStatus;
  policy: DevicePolicy;
  locked: boolean;
  bedtimeActive: boolean;
  paired: boolean;
  /** অ্যাপ আইকন এখন Device Owner API দিয়ে hidden কি না */
  appIconHidden: boolean;
}

export interface AppInfo {
  packageName: string;
  appName: string;
  version: string;
  isSystem: boolean;
  category: string;
  installedAt: number;
}

export interface AppUsage {
  packageName: string;
  appName: string;
  category: string;
  minutesToday: number;
  minutes7d: number;
  minutes30d: number;
  lastUsed: number;
}

export interface LocationPoint {
  id: string;
  lat: number;
  lng: number;
  accuracy: number;
  timestamp: number;
  label?: string;
}

export interface ParentNotification {
  id: string;
  message: string;
  sentAt: number;
  deliveredAt?: number;
  readAt?: number;
  delivered: boolean;
  read: boolean;
}

export interface EmergencyEvent {
  id: string;
  timestamp: number;
  batteryLevel: number;
  networkType: "wifi" | "mobile" | "none";
  lat: number;
  lng: number;
  acknowledged: boolean;
  acknowledgedAt?: number;
  escalationLevel: number;
  note: string;
}

export interface ConsentRequest {
  id: string;
  sessionId: string;
  type: SessionType;
  requestedAt: number;
  expiresAt: number;
  state: "pending" | "approved" | "declined" | "expired";
}

export interface SessionRecord {
  id: string;
  type: SessionType;
  state: SessionState;
  requestedBy: string;
  requestedAt: number;
  startedAt?: number;
  endedAt?: number;
  expiresAt: number;
  consent: "pending" | "approved" | "declined";
}

export interface CommandRecord {
  id: string;
  type: CommandType;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  status: CommandStatus;
  result?: CommandResultCode;
  resultAt?: number;
  /** SEND_NOTIFICATION-এর বার্তা ইত্যাদি */
  payload?: string;
}

export type AuditResult =
  | "APPROVED"
  | "DENIED"
  | "EXECUTED"
  | "FAILED"
  | "EXPIRED"
  | "PENDING";

export interface AuditEntry {
  id: string;
  actorUid: string;
  actorRole: "parent" | "child" | "device" | "system";
  action: string;
  timestamp: number;
  result: AuditResult;
  detail: string;
}

export interface PairingCode {
  code: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

/* ══════════════ Backup (v1.3.0) — consent-based cloud backup ══════════════
 * Firestore-এ শুধু metadata; actual content এনক্রিপ্ট হয়ে R2-এ থাকে।
 * বিস্তারিত: parental-control/docs/backup.md + functions/src/backup/backup.ts
 */

export type BackupCategory = "photos" | "videos" | "contacts" | "sms";

export const BACKUP_CATEGORIES: BackupCategory[] = ["photos", "videos", "contacts", "sms"];

export type BackupItemState = "PENDING" | "UPLOADING" | "UPLOADED" | "FAILED" | "CANCELLED";

/** devices/{id}/backupPolicy/current — শুধু backupSetPolicy callable লেখে */
export interface BackupPolicy {
  version: number;
  updatedAt: number;
  updatedBy: string;
  categories: Record<BackupCategory, { enabled: boolean }>;
}

/** devices/{id}/backupItems/{itemId} — deterministic content-hash id */
export interface BackupItem {
  id: string;
  category: BackupCategory;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  state: BackupItemState;
  attempts: number;
  lastErrorCode?: string;
  createdAt: number;
  uploadedAt?: number;
}

/** devices/{id}/backupStats/current — শুধু functions (Admin SDK) লেখে */
export interface BackupStats {
  totalBytes: number;
  itemCounts: Partial<Record<BackupCategory, number>>;
  lastBackupAt: Partial<Record<BackupCategory, number>>;
  lastBackupAtAny?: number;
}

export interface FamilyState {
  mode: "demo" | "firebase";
  parent: Parent | null;
  device: ChildDevice;
  installedApps: AppInfo[];
  usage: AppUsage[];
  locations: LocationPoint[];
  notifications: ParentNotification[];
  emergencies: EmergencyEvent[];
  sessions: SessionRecord[];
  consentRequests: ConsentRequest[];
  commands: CommandRecord[];
  auditLogs: AuditEntry[];
  pairing: PairingCode | null;
  /** v1.3.0 — backup pipeline state (demo mode simulates the Android device) */
  backupPolicy: BackupPolicy;
  backupItems: BackupItem[];
  backupStats: BackupStats;
  /** ৭ দিনের aggregate — ডিভাইস থেকে SYNC_USAGE এলে পূরণ হয় */
  usageTrend: { date: string; minutes: number }[];
}
