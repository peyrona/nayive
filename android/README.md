# Nayive para Android

One app, one icon. The screen is the PWA itself in a **Trusted Web Activity**
(Chrome's engine, full screen, the same pages as the browser - nothing
rewritten). Beside it runs **LinkService**, the one thing a web page cannot be:
awake with the screen off. The plan and its reasons: `docs/android-app.md`
(local only). The server half: `server/go/devices.go`.

What the service does, all through ONE long poll to `/api/device/wait`
(no Google, no FCM, no second app):

| | |
|---|---|
| Positions during a trip | on and off by itself with the trip's dates |
| A Chat call | rings (the phone's ringtone, obeying silent/vibrate) with a full-screen Contestar / Rechazar |
| Unread messages | a silent notification carrying the number: the icon's badge (a dot on Pixel) |
| "Buscar mi móvil" | rings on the ALARM stream - heard with the phone silenced - until Parar on the phone, and sends where it is |
| A new APK | once a day, `<origin>/app/version.json` → a notification |
| New photos and videos | once a day on Wi-Fi, when switched on in Mi cuenta: to the trip's photo folder, else `files/Camera/<year>/`; nothing deleted on the phone |

The first run is a permissions screen (notifications, location "all the time",
battery, full screen). Long-press the icon → **Permisos** to get back to it.

## Building

Java only (no Kotlin plugin, no Play Services). Needs JDK 17+ and the Android
SDK; everything else Gradle fetches.

```
cp local.properties.example local.properties   # then fill it in
./gradlew assembleRelease                      # app/build/outputs/apk/release/app-release.apk
```

`local.properties` (never committed) says where Nayive is served
(`nayive.origin`) and where the signing key is (`nayive.signing`, a .properties
file with storeFile/storePassword/keyAlias/keyPassword). **The keystore lives in
`store/config/`, outside git: lose it and no installed phone can be updated
again - it belongs in the backup.** `nayive.origin.debug` points a debug build
at a test server (plain HTTP is allowed in debug only).

For the TWA to show no address bar, the server must serve
`/.well-known/assetlinks.json` - `server/go/devices.go` serves
`store/config/assetlinks.json`, which holds the package name and the signing
certificate's SHA-256 (`keytool -list -v -keystore ...`). Without it the app
still works, inside Chrome's own bar.

Icons come from the real logo, `tools/launcher-logo-512.png`, scaled and never
redrawn: `python3 make-icons.py`.

Toolchain as built (2026-09-21): AGP 9.4.1, Gradle 9.7.1, compileSdk/targetSdk 36,
minSdk 26, android-browser-helper 2.7.3.

## Files

| | |
|---|---|
| `MainActivity` | the icon's entry: the permissions screen, then straight to Nayive |
| `Launcher` | the TWA; until enrolled it opens `/nayive/device.html#t=<token>` |
| `LinkService` | the long poll, and applying what it says |
| `Tracker`, `PositionQueue` | positions (platform LocationManager), kept on disk until the server takes them |
| `Ringer`, `RingActivity`, `Notes` | the sound, the full-screen page, every notification |
| `Actions`, `ActionReceiver` | Rechazar / Parar / Contestar, wherever they were pressed |
| `Api`, `Prefs` | HTTP (token in the `X-Nayive-Device` header), the little the app keeps |
| `Media`, `MediaJob`, `MediaUploader` | "Upload new photos and videos": the camera's new files, once a day on Wi-Fi, resumable (server: `api_device_media.go`) |
