# Installing T3 Work on Vivek's iPhone

The T3 Work iPhone app is a Release build signed by Affil's Apple team
(`QX435L9HM5`) and installed over USB from the Mac. It does not go through
TestFlight. `apps/mobile/app.config.ts` pins upstream's Apple team and asks for
App Groups, Push Notifications, Associated Domains and Sign in with Apple, and
Affil's team profiles include none of those. A plain build from `main` fails at
provisioning.

The fix is the config's reduced-capability mode. `T3CODE_IOS_PERSONAL_TEAM=1`
removes those entitlements and the widget and share extensions, and the build
signs as its own bundle ID. Over-the-air updates must also be off: otherwise
the app checks upstream's update feed.

## Build and install

On the Mac, in a fresh clone (Xcode signed in with an Apple ID on the Affil
team; iPhone plugged in, unlocked and in Developer Mode):

```sh
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8   # CocoaPods fails without UTF-8, e.g. over ssh
git clone --filter=blob:none https://github.com/affil-ai/t3code.git ~/build/t3work-device
cd ~/build/t3work-device && git checkout <commit> && pnpm install --frozen-lockfile
export PATH=$PWD/node_modules/.bin:$PATH \
  APP_VARIANT=production \
  T3CODE_IOS_PERSONAL_TEAM=1 \
  T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=ai.affil.t3work \
  T3CODE_MOBILE_UPDATES_ENABLED=0 \
  EXPO_NO_GIT_STATUS=1
cd apps/mobile && npx expo prebuild --clean --platform ios
cd ios && xcodebuild -workspace T3Code.xcworkspace -scheme T3Code \
  -configuration Release -destination id=<device UDID> \
  -derivedDataPath ~/build/t3work-device-dd \
  DEVELOPMENT_TEAM=QX435L9HM5 CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
APP=$(ls -d ~/build/t3work-device-dd/Build/Products/Release-iphoneos/*.app)
xcrun devicectl device install app --device <device UDID> "$APP"
xcrun devicectl device process launch --terminate-existing --device <device UDID> ai.affil.t3work
```

`xcrun devicectl list devices` gives the UDID. The phone must show as
`available (paired)`. `connected` usually means it is locked: xcodebuild then
waits on it, and the launch fails with "the device was not, or could not be,
unlocked". The build uses about 7 GB, so delete both `~/build/t3work-device*`
folders once the app is installed.

The app reaches the Ubuntu server over Tailscale at `http://100.90.248.109:8446`
(`t3-mobile-tailnet.service`, recorded in the office repo's
`notes/t3-mobile-tailnet.md`). Pair it with a one-time code from
`t3 auth pairing create`.
