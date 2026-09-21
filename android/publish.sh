#!/bin/sh
# publish.sh - builds the release APK and lays out the /app/ download site in
# android/build/site/: index.html, nayive.apk, version.json (what the app checks
# once a day). Copy that folder to the VPS's sites_dir as "app" - it is then
# https://<origin>/app/. Nothing here touches the VPS.
set -e
cd "$(dirname "$0")"
./gradlew --no-daemon -q assembleRelease
out=build/site
rm -rf "$out"; mkdir -p "$out"
cp site/index.html "$out/"
cp app/build/outputs/apk/release/app-release.apk "$out/nayive.apk"
code=$(sed -n "s/.*versionCode = \([0-9]*\).*/\1/p" app/build.gradle)
name=$(sed -n "s/.*versionName = '\([^']*\)'.*/\1/p" app/build.gradle)
printf '{"code": %s, "name": "%s", "url": "/app/nayive.apk"}\n' "$code" "$name" > "$out/version.json"
ls -la "$out"
