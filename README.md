# RNAA Stress Test

React Native / Expo sandbox for exercising audio playback, recording, worklets and system integration under load and interruptions.

**RNAA 0.13.6 · Expo SDK 57 · Node.js 22.13+**

## Run

```sh
npm ci
npm run android:release
# or
npm run ios:release
```

Use standalone release builds for stress results. Physical devices are required for meaningful audio, interruption and performance checks; simulators are useful for navigation and state checks.

For development: `npm run android` / `npm run ios`, then `npm start` when reconnecting an installed development build.

## Use

Features are grouped into **Core, Playback, DSP, Recording, Worklets and System**.

1. Open a feature and verify its normal playback or recording behaviour.
2. Expand **Production edge cases**, select a scenario and level, then **Start check**.
3. Perform any requested OS actions: backgrounding, interruption, notification controls or volume changes.
4. Inspect recovery, listen or replay the recording, and export the result from **System**. Recordings are available in **Recording**.

Notification scenarios start their own audio. For example: **System → Recording notification → Record with notification**.

### Workloads

Production scenarios cover pending-work cancellation, audio-focus loss, notification Stop, background/route changes, volume changes, CPU/memory pressure and supported media-service resets.

| Default level | Load                                                                                    |
| ------------- | --------------------------------------------------------------------------------------- |
| **1–5**       | Repeat the disruption 1–5 times, without additional CPU/RAM pressure.                   |
| **6–8**       | Increasing native CPU pressure and memory allocation, up to 128 MiB.                    |
| **9–10**      | Heavy native load plus 500 ms / 2-second app-JavaScript stalls about every ten seconds. |

**Phone environment** can isolate CPU, memory, JS stalls or command latency, or combine them. Memory allocation is capped at 10% of reported available memory. Pressure expires after 180 seconds without renewal and stops at critical thermal state.

These workloads approximate contention; they do not emulate a specific low-end device, guarantee thermal throttling or measure native audio deadlines.

**Advanced repetition checks** are separate workloads and may deliberately mute, disconnect or recreate sources.

### Controls and results

- **Stop audio:** stop the child audio session while keeping the scenario running.
- **Stop all:** cancel the scenario and release audio/pressure resources.
- **Check Resume / Check new session:** approximately three seconds of verification playback. Use normal Play for sustained playback.

Runs follow **baseline → disruption → recovery → verification**. A later successful session does not erase the original failure. **Not fully verified** means evidence is missing or the workload was incomplete; sample counters alone do not establish audible continuity.

## Checks

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

GitHub Actions runs these checks. RNAA integrity is verified during install and build preparation. Keep the dependency baseline and integrity reference unchanged when reproducing findings.

## Optional test tools

<details>
<summary>Network faults, audio focus, host monitoring and service resets</summary>

**Network faults:** `npm run stress:server`, then forward port 8099 with `adb -s SERIAL reverse tcp:8099 tcp:8099`. The app uses `http://127.0.0.1:8099`. Cleartext restrictions may block release access.

**Android audio-focus companion:** after building the main Android app once:

```sh
./android/gradlew -p tools/audio-interrupter :app:assembleDebug
adb -s SERIAL install -r tools/audio-interrupter/app/build/outputs/apk/debug/app-debug.apk
npm run production:interrupter -- --device SERIAL --mode transient --rounds 5
```

Modes: `transient`, `permanent`, `duck`. The companion requests focus and plays a tone; it does not test microphone competition.

**Host monitoring:** `npm run stress:host -- --platform android --device SERIAL` (or `--platform ios --device SIMULATOR_UDID`). Android private-file access requires a debuggable build; ordinary release reports **Blocked**. Use in-app export for release evidence.

**Audio-service reset:** `npm run production:reset -- --device SERIAL --preflight` checks Android support. Actual reset requires a dedicated root-capable, debuggable target and explicit flags. Physical iOS uses Developer Settings' Reset Media Services. Context shutdown is a separate simulated fault.

**Task removal:** `RNAA_KEEP_RECORDING_AFTER_TASK_REMOVAL=1 npm run prebuild`, then rebuild, enables the alternative Android recording configuration. The default stops recording with task removal.

</details>

## Structure

- `src/workshop/registry.ts`: feature definitions, settings and workload metadata.
- `src/audio/`: shared engine and public RNAA calls.
- `src/production/` / `src/stress/`: disruption supervision, repetition workloads and reports.
- `src/app/` / `src/components/`: routing and inline controls.
- `modules/production-faults/`: native pressure and telemetry.
- `scripts/` / `tools/`: validation and optional host/companion tools.

Native projects are generated. Configure them through Expo config/plugins and rebuild after native changes. Fixtures can be regenerated with `npm run fixtures` (Python + FFmpeg).

The Expo MIT notice is retained in [LICENSE](LICENSE). Attribution for added project code and fixtures still requires confirmation.
