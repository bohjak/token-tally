# App Icon

A proper app icon requires an `.icns` file placed here and a `CFBundleIconFile` key in `Info.plist`.

## Why there is no icon yet

SwiftPM executable targets do not support `.xcassets` icon catalogs. Icon integration requires either:

1. A full Xcode project (`.xcodeproj`) with an Asset Catalog linked to the app target, **or**
2. A manually-built `AppIcon.icns` file copied to `.app/Contents/Resources/` at packaging time.

For the MVP — where the app runs as a bare SwiftPM executable or is hand-wrapped into a minimal `.app` bundle — the default system icon is used. This is sufficient for daily local use.

## Steps to add an icon later

1. Design a 1024×1024 PNG icon.
2. Generate an `.icns` file:

```sh
mkdir AppIcon.iconset
sips -z 16 16    AppIcon.png --out AppIcon.iconset/icon_16x16.png
sips -z 32 32    AppIcon.png --out AppIcon.iconset/icon_16x16@2x.png
sips -z 32 32    AppIcon.png --out AppIcon.iconset/icon_32x32.png
sips -z 64 64    AppIcon.png --out AppIcon.iconset/icon_32x32@2x.png
sips -z 128 128  AppIcon.png --out AppIcon.iconset/icon_128x128.png
sips -z 256 256  AppIcon.png --out AppIcon.iconset/icon_128x128@2x.png
sips -z 256 256  AppIcon.png --out AppIcon.iconset/icon_256x256.png
sips -z 512 512  AppIcon.png --out AppIcon.iconset/icon_256x256@2x.png
sips -z 512 512  AppIcon.png --out AppIcon.iconset/icon_512x512.png
cp               AppIcon.png      AppIcon.iconset/icon_512x512@2x.png
iconutil -c icns AppIcon.iconset -o AnalyticsTray/Resources/AppIcon.icns
```

3. Add `CFBundleIconFile` to `AnalyticsTray/Resources/Info.plist`:

```xml
<key>CFBundleIconFile</key>
<string>AppIcon</string>
```

4. When hand-wrapping the `.app` bundle, copy `AppIcon.icns` to `.app/Contents/Resources/`.
