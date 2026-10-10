import java.io.File
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

// Optional release signing with the shared publisher key, kept outside the repo
// (~/.apk-signing-keystore/signing.properties, or APP_SIGNING_PROPERTIES).
// Without it the release APK is built unsigned.
val signingProperties = Properties().apply {
    val path = System.getenv("APP_SIGNING_PROPERTIES")
        ?: "${System.getProperty("user.home")}/.apk-signing-keystore/signing.properties"
    File(path).takeIf { it.exists() }?.inputStream()?.use { load(it) }
}

// MarmotKit (MDK's Kotlin bindings + native libraries) is fetched and verified by
// tools/marmotkit/fetch.sh into these git-ignored directories.
val marmotKitDir = layout.projectDirectory.dir("src/marmotkit")

android {
    namespace = "today.cypherpunk.nostrautica"
    compileSdk = 37

    defaultConfig {
        applicationId = "today.cypherpunk.nostrautica"
        minSdk = 26
        targetSdk = 37
        // Bump both on every release (docs/VERSIONING.md). versionName tracks the
        // root package.json so Settings → About and bug reports line up with the PWA.
        versionCode = 2
        versionName = "0.10.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // Empty in every real build. For testing against the local stack the PWA's
        // e2e uses (docs/E2E-TESTING-GUIDE.md): -PdevRelays=ws://10.0.2.2:7777
        // -PdevBlossom=http://10.0.2.2:3000 replace the default relays/Blossom
        // servers, the way the PWA's ENV_RELAYS / ENV_BLOSSOM do.
        buildConfigField("String", "DEV_RELAYS", "\"${project.findProperty("devRelays") ?: ""}\"")
        buildConfigField("String", "DEV_BLOSSOM", "\"${project.findProperty("devBlossom") ?: ""}\"")
    }

    androidResources {
        localeFilters += listOf("en", "sk", "cs", "de", "es")
    }

    sourceSets {
        getByName("main") {
            kotlin.directories.add(marmotKitDir.dir("kotlin").asFile.path)
            jniLibs.directories.add(marmotKitDir.dir("jniLibs").asFile.path)
        }
    }

    signingConfigs {
        if (signingProperties.getProperty("storeFile") != null) {
            create("release") {
                storeFile = file(signingProperties.getProperty("storeFile"))
                storePassword = signingProperties.getProperty("storePassword")
                keyAlias = signingProperties.getProperty("keyAlias")
                keyPassword = signingProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // arm64 only: MarmotKit's native library is ~20 MB per ABI compressed,
            // and 32-bit-only phones are pre-2017 low-end devices.
            ndk { abiFilters += listOf("arm64-v8a") }
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    // Compressed native libraries: a much smaller download for a sideloaded app
    // (Zapstore, Obtainium), at the cost of extracting them once at install.
    packaging {
        jniLibs { useLegacyPackaging = true }
    }

    testOptions {
        unitTests { isIncludeAndroidResources = true }
    }

    // Reproducibility: no build-time dependency metadata baked into the APK.
    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }
}

ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}

dependencies {
    implementation(project(":protocol"))
    implementation(libs.secp256k1.jni.android)

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.exifinterface)
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)
    implementation(libs.androidx.datastore.preferences)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material3.adaptive)
    implementation(libs.compose.material.icons.extended)
    debugImplementation(libs.compose.ui.tooling)

    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)
    implementation(libs.zxing.core)

    implementation(libs.media3.exoplayer)
    implementation(libs.media3.ui)
    implementation(libs.media3.transformer)
    implementation(libs.media3.effect)
    implementation(libs.media3.common)
    implementation(libs.camerax.core)
    implementation(libs.camerax.camera2)
    implementation(libs.camerax.lifecycle)
    implementation(libs.camerax.video)
    implementation(libs.camerax.view)

    // UniFFI runtime for MarmotKit
    implementation("${libs.jna.get().module}:${libs.versions.jna.get()}@aar")
    implementation(libs.androidx.annotation)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.mockwebserver)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.secp256k1.jni.jvm)
}
