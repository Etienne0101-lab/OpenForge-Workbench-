// The OpenForge Android Dagger module — the pipeline-as-code form of
// the Android build. One TypeScript module (Dagger TS SDK) that builds
// the app inside a container (JDK 17 + Android SDK + Gradle 8.7), so
// the SAME pipeline runs locally (dagger call) and in GitHub Actions
// (dagger/dagger-for-github). Installed into project repos by the
// Deploy > Android tab and included in the full-stack Android
// starter template. Signing reuses the platform contract: the
// keystore + passwords arrive as Dagger secrets and are exposed to
// Gradle as the SIGNING_* env vars the project's guarded signing
// block reads — nothing secret is written into any file in the repo.

export const DAGGER_ENGINE_VERSION = '0.21.11';

export const DAGGER_JSON = `{
  "name": "openforge-android",
  "engineVersion": "v${DAGGER_ENGINE_VERSION}",
  "sdk": {
    "source": "typescript"
  },
  "source": "dagger"
}
`;

export const DAGGER_PACKAGE_JSON = `{
  "name": "openforge-android",
  "private": true,
  "type": "module",
  "dependencies": {
    "@dagger.io/dagger": "${DAGGER_ENGINE_VERSION}"
  }
}
`;

export const DAGGER_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "experimentalDecorators": true
  },
  "include": ["src"]
}
`;

export const DAGGER_INDEX_TS = `import { dag, Container, Directory, File, Secret, object, func } from "@dagger.io/dagger"

const CMDTOOLS_URL =
  "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
const GRADLE_URL = "https://services.gradle.org/distributions/gradle-8.7-bin.zip"

function gradleTask(buildType: string): string {
  switch (buildType) {
    case "release-aab":
      return "bundleRelease"
    case "release-apk":
      return "assembleRelease"
    default:
      return "assembleDebug"
  }
}

function outputFile(buildType: string): string {
  switch (buildType) {
    case "release-aab":
      return "bundle/release/app-release.aab"
    case "release-apk":
      return "apk/release/app-release.apk"
    default:
      return "apk/debug/app-debug.apk"
  }
}

/**
 * OpenForge Android — build Android apps (Gradle) in a container.
 * The same functions run locally (dagger call) and in CI.
 */
@object()
export class OpenforgeAndroid {
  /**
   * A container with JDK 17, the Android SDK (platform 34,
   * build-tools 34.0.0) and Gradle 8.7, with the project mounted.
   */
  private toolchain(source: Directory, projectPath: string): Container {
    const workdir = projectPath === "." || projectPath === "" ? "/src" : "/src/" + projectPath
    return dag
      .container()
      .from("eclipse-temurin:17-jdk-jammy")
      .withEnvVariable("ANDROID_HOME", "/opt/android-sdk")
      .withEnvVariable("ANDROID_SDK_ROOT", "/opt/android-sdk")
      .withExec(["bash", "-c", "apt-get update -qq && apt-get install -y -qq unzip curl > /dev/null"])
      .withExec([
        "bash",
        "-c",
        "mkdir -p $ANDROID_HOME/cmdline-tools && curl -sL -o /tmp/cmdtools.zip " +
          CMDTOOLS_URL +
          " && unzip -q /tmp/cmdtools.zip -d $ANDROID_HOME/cmdline-tools && mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest",
      ])
      .withExec([
        "bash",
        "-c",
        "yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses > /dev/null 2>&1; $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager 'platform-tools' 'platforms;android-34' 'build-tools;34.0.0' > /dev/null",
      ])
      .withExec([
        "bash",
        "-c",
        "curl -sL -o /tmp/gradle.zip " + GRADLE_URL + " && unzip -q /tmp/gradle.zip -d /opt",
      ])
      .withDirectory("/src", source)
      .withWorkdir(workdir)
  }

  /**
   * Build the app and return the Gradle outputs directory
   * (app/build/outputs). For release builds, pass the keystore as a
   * base64 Dagger secret plus the signing passwords as secrets; they
   * reach Gradle as the SIGNING_* environment variables.
   */
  @func()
  async build(
    source: Directory,
    projectPath: string = ".",
    buildType: string = "debug-apk",
    keystore?: Secret,
    storePassword?: Secret,
    keyAlias: string = "",
    keyPassword?: Secret,
  ): Promise<Directory> {
    let ctr = this.toolchain(source, projectPath)
    if (keystore) ctr = ctr.withMountedSecret("/secrets/keystore.b64", keystore)
    if (storePassword) ctr = ctr.withSecretVariable("SIGNING_STORE_PASSWORD", storePassword)
    if (keyPassword) ctr = ctr.withSecretVariable("SIGNING_KEY_PASSWORD", keyPassword)
    if (keyAlias) ctr = ctr.withEnvVariable("SIGNING_KEY_ALIAS", keyAlias)
    const script =
      "set -e; " +
      "if [ -f /secrets/keystore.b64 ]; then base64 -d /secrets/keystore.b64 > keystore.jks; export SIGNING_KEY_STORE_PATH=\\"$PWD/keystore.jks\\"; fi; " +
      "if [ ! -f gradle/wrapper/gradle-wrapper.jar ]; then /opt/gradle-8.7/bin/gradle wrapper --gradle-version 8.7; fi; " +
      "chmod +x gradlew; ./gradlew " +
      gradleTask(buildType) +
      " --stacktrace"
    ctr = ctr.withExec(["bash", "-c", script])
    const outputsRoot =
      projectPath === "." || projectPath === "" ? "/src" : "/src/" + projectPath
    return ctr.directory(outputsRoot + "/app/build/outputs")
  }

  /** Build the app and return just the .apk / .aab file. */
  @func()
  async buildFile(
    source: Directory,
    projectPath: string = ".",
    buildType: string = "debug-apk",
    keystore?: Secret,
    storePassword?: Secret,
    keyAlias: string = "",
    keyPassword?: Secret,
  ): Promise<File> {
    const outputs = await this.build(
      source,
      projectPath,
      buildType,
      keystore,
      storePassword,
      keyAlias,
      keyPassword,
    )
    return outputs.file(outputFile(buildType))
  }
}
`;

export const DAGGER_MODULE_FILES: Array<{ path: string; content: string }> = [
  { path: 'dagger.json', content: DAGGER_JSON },
  { path: 'dagger/src/index.ts', content: DAGGER_INDEX_TS },
  { path: 'dagger/package.json', content: DAGGER_PACKAGE_JSON },
  { path: 'dagger/tsconfig.json', content: DAGGER_TSCONFIG },
];
