// The wire protocol (packages/protocol) in Kotlin: pure logic, no Android, no I/O,
// so it is tested on the JVM against the TypeScript implementation's vectors.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

// secp256k1-kmp 0.17 ships Java 21 bytecode, so this module targets 21 as well
// (the app's D8 handles it). Built with whatever JDK runs Gradle (Studio's JBR).
java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}
kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21) }
}

dependencies {
    api(libs.secp256k1.kmp)
    api(libs.kotlinx.serialization.json)
    testImplementation(libs.secp256k1.jni.jvm)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
