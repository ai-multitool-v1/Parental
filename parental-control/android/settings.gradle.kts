/*
 * Family Safety — Child device app (Android)
 *
 * CONSENT-BASED parental control. Every monitoring capability in this app is
 * gated behind an explicit, visible consent flow on the child device. We use
 * ONLY official/public Android APIs — no security bypass, no root exploits,
 * no accessibility abuse, no hidden persistence, no stealth recording.
 */
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven(url = "https://jitpack.io") // stream-webrtc-android prebuilt libwebrtc
    }
}

rootProject.name = "FamilySafetyChild"
include(":app")
