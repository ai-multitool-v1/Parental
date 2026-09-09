/*
 * Root build script for the Family Safety child app.
 *
 * Plugins are declared with versions here and applied (without versions) in
 * app/build.gradle.kts. No Hilt / kapt / ksp is used: this project intentionally
 * uses a small manual ServiceLocator for dependency injection to keep the
 * codebase auditable and simple.
 */
plugins {
    id("com.android.application") version "8.2.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.22" apply false
    id("com.google.gms.google-services") version "4.4.1" apply false
}
