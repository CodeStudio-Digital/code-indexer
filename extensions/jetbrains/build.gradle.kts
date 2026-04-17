import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "1.9.25"
    id("org.jetbrains.intellij.platform") version "2.2.1"
}

group = "com.mcp.indexer"
version = "1.0.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2024.3")
        testFramework(TestFrameworkType.Platform)
    }
    // OkHttp for REST + SSE streaming
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // JSON serialization
    implementation("org.json:json:20240303")
}

intellijPlatform {
    instrumentCode = false
    pluginConfiguration {
        name = "MCP Code Indexer"
        version = "1.0.0"
        ideaVersion {
            sinceBuild = "243"
            // untilBuild = "251.*"
        }
    }
    signing {
        // Configure via environment variables for CI:
        // CERTIFICATE_CHAIN, PRIVATE_KEY, PRIVATE_KEY_PASSWORD
    }
    publishing {
        // token.set(System.getenv("PUBLISH_TOKEN"))
    }
}

kotlin {
    jvmToolchain(21)
}
