# kotlinx.serialization: keep generated serializers for @Serializable classes.
-keepattributes *Annotation*, InnerClasses, Signature, Exceptions
-dontnote kotlinx.serialization.**
-keepclassmembers class today.cypherpunk.nostrautica.** {
    *** Companion;
}
-keepclasseswithmembers class today.cypherpunk.nostrautica.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class today.cypherpunk.nostrautica.**$$serializer { *; }
-keepclassmembers @kotlinx.serialization.Serializable class today.cypherpunk.nostrautica.** {
    <fields>;
}

# MarmotKit (UniFFI over JNA): the generated bindings are looked up reflectively
# by JNA, and the keyring shim is called from native code by name.
-keep class dev.ipf.marmotkit.** { *; }
-keep class io.crates.keyring.** { *; }
-keep class com.sun.jna.** { *; }
-keep class * implements com.sun.jna.** { *; }
-dontwarn java.awt.**
-dontwarn com.sun.jna.**

# secp256k1 JNI
-keep class fr.acinq.secp256k1.** { *; }

-dontwarn okhttp3.internal.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
