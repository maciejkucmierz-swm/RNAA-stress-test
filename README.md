# RNAA Stress Test

An Android and iOS sandbox for finding what happens when audio meets a busy phone, interrupted playback, delayed commands or an awkwardly timed Stop.

It uses the **published React Native Audio API 0.13.6**, without dependency patches, private APIs or automatic engine repairs. The app includes 43 feature demos, inline stress controls, saved recordings and exportable results.

## Run on a physical Android

You need Node.js **22.13 or newer**, npm, a JDK and the Android SDK. Android Studio can install the Android SDK and platform tools. Set up your Android development environment before building.

1. On the phone, enable **Developer options → USB debugging**.
2. Connect it by USB, unlock it and accept the debugging prompt.
3. Open a terminal in this project's folder and run:

```sh
npm ci
adb devices
npm run android:release
```

Your phone should appear as `device`, rather than `unauthorized`, in `adb devices`. Select it when Expo asks for a target. The first build downloads native build tools and can take a while.

The command builds, installs and opens the standalone app. Confirm **RELEASE** in the header. Once installed, open **RNAA Stress Test** from the phone's app list; a release build does not need a development server.

**Use release builds for stress results.** Expo Go cannot run this app's native audio and pressure modules.

## Run on iOS

Local iOS builds require macOS, Xcode, its command-line tools and CocoaPods.

```sh
npm ci
npm run ios:release
```

Choose a simulator or connected iPhone when prompted. A physical iPhone also needs device trust, Developer Mode and signing configured for your Apple development team.

Use the simulator for navigation and state checks. Use a physical phone for listening, interruptions, microphone behaviour and performance conclusions.

If you prefer cloud builds, configure the project with your own Expo account and use the existing `benchmark` profile:

```sh
npx eas-cli@latest build --profile benchmark --platform android
# Or --platform ios, with the required Apple signing setup.
```

## Try a feature

The app has six tabs:

| Tab           | What you can try                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| **Core**      | Audio-engine controls, connected sound graphs, raw samples, decoding, duration information and file checks. |
| **Playback**  | File and URL playback, loops, queued sound pieces, player controls and streaming.                           |
| **DSP**       | Sound generation, volume, stereo position, filters, delay, echo, distortion and visual analysis.            |
| **Recording** | Record to a file, inspect live samples, feed a microphone graph or combine these outputs.                   |
| **Worklets**  | Observe, change or generate samples outside ordinary app JavaScript.                                        |
| **System**    | Permissions, interruptions, volume, device information, notifications and background behaviour.             |

Open a feature, adjust its settings and press **Play**, **Record** or **Run quick check**. Switches change settings; buttons perform actions. Less-used controls are inside expandable sections.

Start with a normal check before adding pressure. Grant microphone or notification permissions when the app requests them. Recording notifications are Android-only; iOS audio-session controls are iOS-only.

For recording notification controls, go directly to **System → Recording notification → Record with notification**. You do not need to start recording in another tab.

## Add a difficult condition

1. Open **Production edge cases** beside the feature.
2. Choose **What should go wrong?** and start at level **1**.
3. Press **Start check**. Follow any instructions for switching apps or using real phone controls.
4. End the disruption, inspect the result and perform the recovery check if offered.
5. Listen or replay the recording, add your observation and export the result.

Examples include Stop during unfinished work, another app taking audio priority, notification Stop, background changes, volume changes and phone pressure. Only relevant scenarios are offered for each feature. Unsupported fault injection reports **Blocked**.

The test follows **baseline → disruption → recovery → verification**. It records the original outcome before an explicit new session. A successful later start never erases a failure.

### Levels and phone environments

With **Phone environment → Use the test level**:

| Level   | What it adds                                                               |
| ------- | -------------------------------------------------------------------------- |
| **1–5** | One to five disruptions, without extra CPU or memory load.                 |
| **6**   | One native worker at 30% requested duty and up to 16 MiB extra memory.     |
| **7**   | About half the logical cores at 60% requested duty and up to 64 MiB.       |
| **8**   | One worker per logical core at 85% requested duty and up to 128 MiB.       |
| **9**   | Level 8 plus half-second pauses in app JavaScript about every ten seconds. |
| **10**  | Level 8 plus two-second pauses in app JavaScript about every ten seconds.  |

Other environment choices isolate CPU work, memory pressure, JavaScript freezes or delayed app commands. The combined choice adds several conditions together. These choices can override the default level profile.

CPU load competes for processing time; it does not lock RNAA's internal threads. Extra memory is capped at 10% of reported available memory. Native pressure stops at critical thermal state or after 180 seconds without renewal; an active test can renew it. Guard-ended workloads are incomplete.

These conditions do **not** reproduce a particular low-end phone, guarantee thermal throttling or leave the app with only a few megabytes of RAM. Command delays are not network or audio-driver latency.

### Which Stop should I use?

- **Stop audio:** stops the sound session while the scenario continues.
- **Stop all:** cancels the whole test, stops audio and releases owned pressure.
- **Check Resume / Check new session:** short verification playback, labelled about **three seconds**, after pressure ends and the original response is recorded. Use normal **Play** afterward for continuous playback.

**Advanced repetition checks** are separate workloads. They can deliberately mute, disconnect or recreate sources. Those planned actions should not be confused with unexpected dropouts.

## Read and share results

- **Passed:** the stated checks completed with their required evidence.
- **Failed:** an expected behaviour or correctness check failed.
- **Blocked:** a platform, permission or required tool was unavailable.
- **Not fully verified:** evidence is missing or the workload did not finish.

Position updates and sample counters show activity; they do not prove clean speaker output. Listen yourself and replay saved files. Begin with two-to-five-minute checks; reserve longer runs for a specific investigation.

Saved recordings are available in **Recording**. Functional and stress reports can be exported from **System**. Review exported settings, URLs and observations before sharing them publicly. Histories keep a last-good backup and preserve unreadable originals.

The sandbox deliberately leaves known 0.13.6 findings visible: queue default start can fail, the player can replay with Autoplay on and Loop off, Ogg duration can return zero, and direct distortion-curve updates have shown a mismatch. Crackling under load remains an investigation, not an automatically diagnosed library failure. Historical reports and device-specific automation are excluded from this repository.

## Development and checks

For a development build:

```sh
npm run android
# Or npm run ios
```

For an already installed development build, start its server with `npm start`. If another project uses port 8081, use `npm start -- --port 8083` and, on Android, `adb reverse tcp:8083 tcp:8083`. Make sure this app opens this project's server. Development results are not release qualification.

Run the repository checks before sharing a change:

```sh
npm run check:audio-integrity
npm run lint
npm run format:check
npm run typecheck
npm run typecheck:tests
npm run typecheck:tools
npm run check:tools
npm test
npm run check:config
```

`npm run format` applies formatting using pinned Prettier 3.6.2, downloaded through npm. GitHub Actions runs the checks above. Native builds and physical-device listening are separate checks.

The lockfile is the dependency baseline. `npm ci`, startup and build preparation verify RNAA's published files; they do not patch or switch versions. Do not update the integrity reference to accept a local modification.

### Source layout

| Folder                       | Purpose                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `src/app/`                   | Expo Router screens and layouts.                                                     |
| `src/components/`            | Feature cards, controls and result views.                                            |
| `src/audio/`                 | Public RNAA calls, shared engine ownership and audio workloads.                      |
| `src/workshop/`              | Feature registry, settings and normal-session coordination.                          |
| `src/production/`            | Disruption scenarios, user intent and recovery checks.                               |
| `src/stress/`                | Repetition recipes, limits and reports.                                              |
| `src/storage/`               | Small history-file helper.                                                           |
| `modules/production-faults/` | Test-only native pressure and observations. It never replaces or repairs RNAA audio. |
| `scripts/`                   | Integrity/configuration checks and optional host tools.                              |
| `tools/audio-interrupter/`   | Separate Android audio-focus companion app.                                          |
| `tests/`                     | Controller and data regressions with explicit native mocks.                          |

The generated `android/` and `ios/` folders are not committed. Configure native behaviour through Expo configuration/plugins and the local module. Do not hand-edit generated projects. Changes to native configuration or the local module require a new native build.

Keep one shared context and recorder, respect single-use sources, preserve original failures and check each feature against the pinned release's public API. Do not add dependency patches, private APIs, automatic engine repair or metadata-decoding fallbacks.

## Optional test tools

<details>
<summary>Controlled network responses</summary>

Run a local server and forward its port to Android:

```sh
npm run stress:server
# In another terminal:
adb -s ANDROID_SERIAL reverse tcp:8099 tcp:8099
```

The app uses `http://127.0.0.1:8099`. The server supports controlled delays, stalls and broken responses. Cleartext policy may block it in release; record Blocked instead of changing policy to manufacture a pass. Original-source recovery and later clean-source playback are separate results.

</details>

<details>
<summary>Android audio-focus companion</summary>

After the main Android app has built at least once, its generated Gradle wrapper can build the helper:

```sh
./android/gradlew -p tools/audio-interrupter :app:assembleDebug
adb -s ANDROID_SERIAL install -r tools/audio-interrupter/app/build/outputs/apk/debug/app-debug.apk
```

Start an interruption scenario in the sandbox, then run:

```sh
npm run production:interrupter -- --device ANDROID_SERIAL --mode transient --rounds 5
```

Modes are `transient`, `permanent` and `duck`. The helper requests audio focus and plays a quiet tone; it does not capture the microphone. Use **Stop helper** to end early. The sandbox must observe an actual interruption; starting the helper alone is not proof. Use a real second recorder to investigate microphone competition.

</details>

<details>
<summary>Host monitoring, service resets and task removal</summary>

```sh
npm run stress:host -- --platform android --device ANDROID_SERIAL
npm run stress:host -- --platform ios --device SIMULATOR_UDID
```

Android private-file monitoring requires a debuggable app. Ordinary release builds promptly report **Blocked**; use in-app export. Do not enable release debuggability to make monitoring work. iOS host file access is supported for simulators, not an ordinary physical-iPhone workflow.

Real Android audio-service reset requires a dedicated root-capable, debuggable target and explicit host-tool flags. Check support without resetting anything:

```sh
npm run production:reset -- --device ANDROID_SERIAL --preflight
```

On a physical iPhone, the scenario requires Developer Settings' Reset Media Services and an observed native reset event. Closing our context is a simulated shutdown, not a real service reset.

To investigate recording after removal from Android Recents, set `RNAA_KEEP_RECORDING_AFTER_TASK_REMOVAL=1`, run `npm run prebuild`, then rebuild. The default stops recording with task removal. This differs from ordinary backgrounding.

</details>

## Fixtures, attribution and references

Audio fixtures are deterministic generated sounds; the generator is `scripts/generate-fixtures.py`. Regeneration needs Python and FFmpeg: `npm run fixtures`. Keep the manifest and files together. Android filenames deliberately use distinct resource stems.

The existing Expo MIT notice is retained in [LICENSE](LICENSE). Confirm ownership/attribution for the added project code and fixtures before public publication; this repository does not invent a new copyright holder.

Official references: [RNAA documentation](https://docs.swmansion.com/react-native-audio-api/), [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/) and [Expo local build commands](https://docs.expo.dev/more/expo-cli/). Check current documentation against the pinned package before changing a feature.
