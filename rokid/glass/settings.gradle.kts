import org.gradle.api.initialization.resolve.RepositoriesMode

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
        maven { url = uri("https://maven.rokid.com/repository/maven-public/") }
        val rokidSdkDir = System.getenv("ROKID_SDK_DIR")
        if (!rokidSdkDir.isNullOrBlank()) {
            flatDir { dirs("$rokidSdkDir/vendor") }
        }
    }
}

rootProject.name = "BolloonRokidGlass"
include(":app")
