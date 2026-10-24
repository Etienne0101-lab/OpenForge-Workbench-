#!/bin/bash
# Daemon-free build for the OpenForge Workbench Android app.
# Used in the Muse sandbox, where Gradle's client<->daemon loopback is
# blocked by the runtime's other_tcp permission. Pins match
# android-workbench/app/build.gradle.kts: JDK 17, SDK platform 34,
# build-tools 34.0.0, Kotlin 2.0.20, Compose 1.6.8 / Material3 1.2.1.
# A real Gradle/AGP build (Android Studio or CI) is the production path.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/android-workbench/app"
OUT="$ROOT/build"
SDK="$HOME/workspace/.tools/android/sdk"
JDK="$HOME/workspace/.tools/android/jdk17"
MANUAL="$HOME/workspace/android-verify/manual"
export JAVA_HOME="$JDK"
export PATH="$JDK/bin:$PATH"

AAPT2="$SDK/build-tools/34.0.0/aapt2"
D8="$SDK/build-tools/34.0.0/d8"
ZIPALIGN="$SDK/build-tools/34.0.0/zipalign"
APKSIGNER="$SDK/build-tools/34.0.0/apksigner"
ANDROID_JAR="$SDK/platforms/android-34/android.jar"
KOTLINC="$MANUAL/kotlinc/bin/kotlinc"
COMPOSE_PLUGIN="$MANUAL/compose-plugin-2.0.20.jar"

rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex" "$OUT/apk"

echo "== aapt2 compile =="
"$AAPT2" compile --dir "$APP/src/main/res" -o "$OUT/res.zip"

echo "== aapt2 link =="
"$AAPT2" link -o "$OUT/base.apk" \
  -I "$ANDROID_JAR" \
  --manifest "$APP/src/main/AndroidManifest.xml" \
  --java "$OUT/gen" \
  --version-code 1 --version-name "1.0.0" \
  --min-sdk-version 24 --target-sdk-version 34 \
  --auto-add-overlay \
  "$OUT/res.zip"

echo "== kotlinc =="
CP="$ANDROID_JAR:$(ls "$MANUAL"/classes/*.jar | tr '\n' ':')"
find "$APP/src/main/java" -name '*.kt' > "$OUT/sources.txt"
find "$OUT/gen" -name '*.java' >> "$OUT/sources.txt"
# kotlinc reads the file list via @argfile
"$KOTLINC" -cp "$CP" \
  -Xplugin="$COMPOSE_PLUGIN" \
  -jvm-target 17 \
  -d "$OUT/classes" \
  @"$OUT/sources.txt"

echo "== jar app classes =="
(cd "$OUT/classes" && "$JDK/bin/jar" cf "$OUT/app-classes.jar" .)

echo "== d8 =="
"$D8" --min-api 24 --output "$OUT/dex" \
  --lib "$ANDROID_JAR" \
  "$OUT/app-classes.jar" "$MANUAL"/classes/*.jar

echo "== package =="
cd "$OUT/apk"
unzip -q -o "$OUT/base.apk"
cp "$OUT"/dex/classes*.dex .
# Remove the META-INF from aapt2 link output if present (unsigned base has none, be safe)
rm -rf META-INF
zip -q -r "$OUT/unsigned.apk" .
cd "$ROOT"

echo "== zipalign + sign =="
"$ZIPALIGN" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
"$APKSIGNER" sign --ks "$MANUAL/debug.keystore" \
  --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias androiddebugkey \
  --out "$OUT/openforge-workbench-debug.apk" "$OUT/aligned.apk"
"$APKSIGNER" verify "$OUT/openforge-workbench-debug.apk"
"$SDK/build-tools/34.0.0/aapt2" dump badging "$OUT/openforge-workbench-debug.apk"
echo "APK: $OUT/openforge-workbench-debug.apk"
ls -lh "$OUT/openforge-workbench-debug.apk"
