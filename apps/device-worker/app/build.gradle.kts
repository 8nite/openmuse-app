plugins {
    id("com.android.application")
}

android {
    namespace = "cc.openmuse.deviceworker"
    compileSdk = 34

    defaultConfig {
        applicationId = "cc.openmuse.deviceworker"
        minSdk = 30
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// Zero third-party dependencies: framework APIs only (org.json ships with Android,
// networking is a raw SSLSocket client, threading is Executors/Handler).
dependencies {
}
