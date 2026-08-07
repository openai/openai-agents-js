# Realtime React Native

This Expo development-build example uses `@openai/agents-realtime` with an app-owned `react-native-webrtc` transport. It does not call `registerGlobals()` and it never places a standard OpenAI API key in the mobile app.

## Requirements

- Node.js and pnpm
- Xcode or Android Studio with a simulator/emulator, or a physical device
- An `OPENAI_API_KEY` available only to the local token server

Expo Go is not supported because `react-native-webrtc` contains native code. Build an Expo development client instead.

## Run the example

From the repository root, install and build the workspace packages:

```sh
pnpm install
pnpm build
```

Start the local token server in one terminal:

```sh
OPENAI_API_KEY=sk-... pnpm -F realtime-react-native token-server
```

Build and launch the native app in another terminal:

```sh
pnpm -F realtime-react-native android
```

Or, on macOS with Xcode installed:

```sh
pnpm -F realtime-react-native ios
```

The default token URL works with the Android emulator (`10.0.2.2`) and iOS simulator (`127.0.0.1`). For a physical device, point the app at the development machine's LAN address:

```sh
HOST=0.0.0.0 OPENAI_API_KEY=sk-... pnpm -F realtime-react-native token-server
EXPO_PUBLIC_REALTIME_TOKEN_URL=http://192.168.1.20:8787/token pnpm -F realtime-react-native start
```

Binding the development token server to `0.0.0.0` exposes it to the local network. Use it only on a trusted network and stop it when testing is complete.

Rebuild the development client after changing native dependencies or the Expo config plugin.

## What this example supports

- Microphone input and remote audio through `react-native-webrtc`.
- Realtime session events, text messages, interruption, and muting through the SDK transport contract.
- Ephemeral client keys minted by a small server-side helper.

On Xcode 26.6 with iOS 26.5 Simulator, microphone input and audio output are currently unreliable even when a Mac audio input is selected. As a temporary workaround, the example detects iOS Simulator and creates a text-only WebRTC session without initializing audio. This still exercises signaling, the data channel, text messages, and Realtime session events. The workaround can be removed when the upstream Simulator audio regression is fixed.

For now, use a physical iOS device to test microphone input and spoken responses:

```sh
EXPO_PUBLIC_REALTIME_TOKEN_URL=http://192.168.1.20:8787/token pnpm -F realtime-react-native exec expo run:ios --device
```

`Device.isDevice` then enables bidirectional audio automatically.

### Default to the iPhone speaker

On a physical iPhone, the WebRTC audio session may initially route spoken responses to the built-in receiver (the earpiece) rather than the built-in speaker. In `react-native-webrtc` 124.0.7, the JavaScript [`RTCAudioSession`](https://github.com/react-native-webrtc/react-native-webrtc/blob/124.0.7/src/RTCAudioSession.ts) API only exposes CallKit activation and deactivation hooks; it does not expose an output-route selector.

For a local physical-device test that should default to speakerphone, generate the `ios` directory, then add this import to `ios/AgentsRealtimeReactNative/AgentsRealtimeReactNative-Bridging-Header.h`:

```objc
#import <WebRTC/RTCAudioSessionConfiguration.h>
```

At the start of `application(_:didFinishLaunchingWithOptions:)` in `ios/AgentsRealtimeReactNative/AppDelegate.swift`, before React Native is initialized, add:

```swift
let configuration = RTCAudioSessionConfiguration.webRTC()
configuration.categoryOptions.insert(.defaultToSpeaker)
RTCAudioSessionConfiguration.setWebRTC(configuration)
```

This preserves the other WebRTC category options and adds Apple's [`defaultToSpeaker`](https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/defaulttospeaker) option to the configuration that WebRTC applies. It changes the default from the receiver to the built-in speaker; it does not provide a user-facing route picker.

The `ios` directory in this example is generated and ignored by Git, and Expo prebuild can replace these edits. Direct edits are suitable for a one-off device test. A production app should make the native change reproducible with an Expo config plugin or manage and commit its native iOS project. This example intentionally leaves that app-specific audio-routing policy outside the SDK transport.

The SDK's built-in `OpenAIRealtimeWebRTC` remains a browser transport. React Native applications own their native WebRTC dependency, permissions, audio routing, and lifecycle through a custom transport such as this one.

## Verification

`pnpm test:integration` installs the published packages from the local Verdaccio registry and creates an Android Metro bundle. This catches package-export and Node-builtin regressions without requiring an emulator.

An opt-in live test can exercise signaling and a real Realtime response on an already-running Android emulator:

```sh
OPENAI_AGENTS_RUN_REACT_NATIVE_LIVE=1 pnpm test:integration -- integration-tests/react-native.test.ts
```

The live test requires `adb`, an emulator, Android build tooling, and `OPENAI_API_KEY`. It is intentionally excluded from normal CI.

## Troubleshooting

- If the app reports a token-server network error, verify `curl http://127.0.0.1:8787/health` on the development machine and set `EXPO_PUBLIC_REALTIME_TOKEN_URL` to an address reachable from the device.
- If the app says the native module is unavailable, use a development build rather than Expo Go and rebuild it.
- If the microphone is silent on a physical device, check the operating-system permission and selected input device.
- If spoken responses use the iPhone receiver, see "Default to the iPhone speaker" above. `react-native-webrtc` does not expose this iOS route setting through its JavaScript API.
- iOS Simulator audio is temporarily disabled because of the current Simulator audio regression. Use a physical device to test microphone input and spoken responses.
- The event log on screen shows the latest SDK history items. Metro and device logs show connection failures and the optional E2E sentinel.
