# Family Safety child app — ProGuard / R8 rules.
#
# Goal: keep everything that is reached reflectively or from the manifest,
# shrink the rest. No obfuscation tricks are needed; safety-relevant classes
# are kept readable so audits stay easy.

# --- WebRTC (org.webrtc via stream-webrtc-android): heavy JNI usage ----------
-keep class org.webrtc.** { *; }
-dontwarn org.webrtc.**

# --- Firebase messaging service is referenced from the manifest -------------
-keep class org.setbd.parentcontrol.notifications.ChildMessagingService { *; }

# --- Device admin receiver must keep its manifest-declared name -------------
-keep class org.setbd.parentcontrol.management.DeviceAdminReceiver { *; }

# --- Manifest receivers / services / activities ------------------------------
-keep class org.setbd.parentcontrol.reliability.BootReceiver { *; }
-keep class org.setbd.parentcontrol.policies.BedtimeReceiver { *; }

# --- Firestore: we store maps, but keep enum names for readable results -----
-keepclassmembers enum org.setbd.parentcontrol.** {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

# --- Coroutines debug metadata ------------------------------------------------
-dontwarn kotlinx.coroutines.**

# Keep line numbers for crash reports.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
