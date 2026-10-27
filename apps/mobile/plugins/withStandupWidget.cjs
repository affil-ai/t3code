"use strict";

// fork: standup widget. Adds the native Standup widget extension
// (plugins/standup-widget/StandupWidget.swift), which fetches the standup
// summary on its own timeline. Unlike expo-widgets' target it needs no App
// Group, only the app's keychain access group, so it also builds under the
// reduced-capability team that device builds sign with.
//
// The Xcode target wiring reuses expo-widgets' helper (pinned in package.json),
// so both extensions share the app's "Embed Foundation Extensions" phase.

const fs = require("fs");
const path = require("path");
const { withDangerousMod } = require("expo/config-plugins");
const withTargetXcodeProject =
  require("expo-widgets/plugin/build/ios/xcode/withTargetXcodeProject").default;

const TARGET_NAME = "T3WorkStandupWidget";
const SOURCE = path.join(__dirname, "standup-widget", "StandupWidget.swift");

const plistDocument = (body) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>${body}
</dict>
</plist>
`;

function targetFiles(platformProjectRoot) {
  const directory = path.join(platformProjectRoot, TARGET_NAME);
  return {
    directory,
    swift: path.join(directory, "StandupWidget.swift"),
    infoPlist: path.join(directory, "Info.plist"),
    entitlements: path.join(directory, `${TARGET_NAME}.entitlements`),
  };
}

function withSourceFiles(config, { appBundleIdentifier, onFilesWritten }) {
  return withDangerousMod(config, [
    "ios",
    (modConfig) => {
      const files = targetFiles(modConfig.modRequest.platformProjectRoot);
      fs.mkdirSync(files.directory, { recursive: true });
      fs.copyFileSync(SOURCE, files.swift);
      // The widget reaches T3 Work servers over plain HTTP on a LAN or tailnet, as the app does.
      fs.writeFileSync(
        files.infoPlist,
        plistDocument(`
  <key>CFBundleShortVersionString</key>
  <string>$(MARKETING_VERSION)</string>
  <key>CFBundleVersion</key>
  <string>$(CURRENT_PROJECT_VERSION)</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
  </dict>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.widgetkit-extension</string>
  </dict>`),
      );
      // The app writes its keychain items to this group (app.config.ts), so the widget can read them.
      fs.writeFileSync(
        files.entitlements,
        plistDocument(`
  <key>keychain-access-groups</key>
  <array>
    <string>$(AppIdentifierPrefix)${appBundleIdentifier}</string>
  </array>`),
      );
      onFilesWritten([files.swift, files.infoPlist, files.entitlements]);
      return modConfig;
    },
  ]);
}

module.exports = function withStandupWidget(config) {
  const appBundleIdentifier = config.ios?.bundleIdentifier;
  if (!appBundleIdentifier) throw new Error("withStandupWidget needs ios.bundleIdentifier.");
  const bundleIdentifier = `${appBundleIdentifier}.standup`;
  // EAS credentials provision extensions listed here; local Xcode builds ignore it.
  const extensions = config.extra?.eas?.build?.experimental?.ios?.appExtensions ?? [];
  config.extra = {
    ...config.extra,
    eas: {
      ...config.extra?.eas,
      build: {
        ...config.extra?.eas?.build,
        experimental: {
          ...config.extra?.eas?.build?.experimental,
          ios: {
            ...config.extra?.eas?.build?.experimental?.ios,
            appExtensions: [
              ...extensions.filter((extension) => extension.targetName !== TARGET_NAME),
              {
                targetName: TARGET_NAME,
                bundleIdentifier,
                entitlements: {
                  "keychain-access-groups": [`$(AppIdentifierPrefix)${appBundleIdentifier}`],
                },
              },
            ],
          },
        },
      },
    },
  };
  // Dangerous mods run before the Xcode project mod, which reads the paths.
  let fileUris = [];
  const withFiles = withSourceFiles(config, {
    appBundleIdentifier,
    onFilesWritten: (uris) => (fileUris = uris),
  });
  return withTargetXcodeProject(withFiles, {
    targetName: TARGET_NAME,
    bundleIdentifier,
    deploymentTarget: config.ios?.deploymentTarget ?? "18.0",
    appleTeamId: config.ios?.appleTeamId,
    getFileUris: () => fileUris,
  });
};
