/*
 * Family Safety — child app module.
 *
 * SAFETY: this app intentionally contains no hidden/stealth capabilities.
 * Camera, microphone and screen-capture code paths can only start from a
 * user-visible consent dialog + the corresponding foreground service with a
 * visible, ongoing notification (Android 14 foregroundServiceType rules are
 * respected: services are only started while the app is in the foreground
 * and the matching runtime permission / user approval is already granted).
 */
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.gms.google-services") // reads app/google-services.json
}

android {
    namespace = "org.setbd.parentcontrol"
    compileSdk = 34

    defaultConfig {
        applicationId = "org.setbd.parentcontrol"
        // API 21 (Android 5.0 Lollipop) → latest. Every newer-API call site is
        // guarded (see util/Compat.kt + Build.VERSION.SDK_INT checks) and
        // features report SUPPORTED / CONDITIONALLY_SUPPORTED / UNSUPPORTED
        // instead of crashing or being bypassed on older devices.
        minSdk = 21
        targetSdk = 34
        versionCode = 11
        versionName = "1.4.6"

        // FCM default notification channel (parent messages).
        resValue("string", "default_notification_channel_id", "channel_parent_messages")

        // Trusted backend base URL (Cloudflare Worker). Injected from a
        // gradle property or CI variable — contains NO secret. Set e.g.
        //   ./gradlew assembleDebug -PSECURE_API_BASE=https://xxx.workers.dev
        // or add a SECURE_API_BASE repository variable in GitHub Actions.
        buildConfigField(
            "String",
            "SECURE_API_BASE",
            "\"${project.findProperty("SECURE_API_BASE") ?: System.getenv("SECURE_API_BASE") ?: ""}\""
        )
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            // App Check: Debug provider in debug builds (register debug token in Firebase console).
            buildConfigField("String", "APP_CHECK_PROVIDER", "\"debug\"")
        }
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // App Check: Play Integrity provider in release builds.
            buildConfigField("String", "APP_CHECK_PROVIDER", "\"play_integrity\"")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    composeOptions {
        // Kotlin 1.9.22 -> Compose compiler 1.5.8
        kotlinCompilerExtensionVersion = "1.5.8"
    }
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    // ---- Kotlin / coroutines -------------------------------------------------
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.7.3")

    // ---- AndroidX core / lifecycle ------------------------------------------
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.7.0")
    implementation("androidx.lifecycle:lifecycle-process:2.7.0")

    // ---- Compose (Material 3) ------------------------------------------------
    implementation(platform("androidx.compose:compose-bom:2024.02.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.8.2")
    implementation("androidx.navigation:navigation-compose:2.7.7")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // ---- Firebase (BoM 32.8.1 — the LAST BoM supporting minSdk 21:
    //      auth 22.3.1 / firestore 24.11.1 / messaging 23.4.1). From BoM
    //      33.0.0 onward (auth 23.x) every SDK hard-requires minSdk 23,
    //      which breaks the manifest merger on API-21 builds. ----
    implementation(platform("com.google.firebase:firebase-bom:32.8.1"))
    implementation("com.google.firebase:firebase-auth-ktx")
    implementation("com.google.firebase:firebase-firestore-ktx")
    implementation("com.google.firebase:firebase-messaging-ktx")
    implementation("com.google.firebase:firebase-functions-ktx")
    implementation("com.google.firebase:firebase-appcheck-playintegrity")
    implementation("com.google.firebase:firebase-appcheck-debug")

    // ---- WorkManager (heartbeat + usage sync + bedtime fallback) -------------
    implementation("androidx.work:work-runtime-ktx:2.9.0")

    // ---- Location ------------------------------------------------------------
    implementation("com.google.android.gms:play-services-location:21.2.0")

    // ---- Encrypted local storage (deviceId, policy cache, replay cache) ------
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // ---- WebRTC (prebuilt Google libwebrtc packaged by Stream) ---------------
    implementation("io.getstream:stream-webrtc-android:1.1.3")
}
