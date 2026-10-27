// Ranked manual preparation, not a claim that the feature passed qualification.
export const manualChecks: Record<
  string,
  { rank: number; steps: string; expected: string }
> = {
  "recording-notification": {
    rank: 1,
    steps:
      "Record a spoken count. Open/close the notification panel, switch apps, lock/unlock, then use the real notification Pause, Resume, and Stop. Return and replay the file.",
    expected:
      "One saved recording, no stuck microphone, and a fresh recording works. Android only.",
  },
  "system-events": {
    rank: 2,
    steps:
      "Choose playback or recording. Start another audio app, interrupt our audio, stop the other app, then return. Repeat with Stop audio during the interruption.",
    expected:
      "Actual OS events are recorded. User Stop wins; interrupted recording needs explicit Resume.",
  },
  background: {
    rank: 3,
    steps:
      "Choose Leave the app and return, then playback or recording. Switch apps and lock/unlock while speaking numbered markers or listening. Return and check the sound or saved file. No headphone changes are needed. Test removal from Recents separately.",
    expected:
      "Background behaviour matches this build. No duplicate sound; another session works.",
  },
  "record-combined": {
    rank: 4,
    steps:
      "Speak a numbered count while one recorder saves a file, delivers samples, and feeds analysis. Switch apps, interrupt, return, and stop. Replay the saved recording.",
    expected:
      "Valid saved audio and sample metrics. Any gap must be explained; speaker monitoring stays off.",
  },
  "record-file": {
    rank: 5,
    steps:
      "Record speech, pause/resume, background, interrupt, and stop. Use Advanced settings for file splitting. Replay each segment and start another recording.",
    expected:
      "Expected files decode, finish once, and contain the spoken markers.",
  },
  "record-recovery": {
    rank: 6,
    steps:
      "Start a test recording here. On Android use its notification Stop while away, return, then use Recover last saved file. Try collecting again and start another recording.",
    expected:
      "The completed file is recovered at most once. Inspecting must not stop a newer recording.",
  },
  "playback-notification": {
    rank: 7,
    steps:
      "Play the test sound. Use real system Play/Pause/Stop while opening/closing the panel and switching apps. Try hiding the notification during an update.",
    expected:
      "Controls match actual sound. Stop prevents stale restarts; a hidden notification is not recreated by old work.",
  },
  context: {
    rank: 8,
    steps:
      "Use Stop during unfinished work for cancellation, or start test audio with a manual disruption scenario. Stop during recovery, then explicitly Resume and try a fresh session.",
    expected:
      "The old engine cannot restart old sound. A new session remains usable. A real service reset is a separate supported-device check.",
  },
  session: {
    rank: 9,
    steps:
      "Use a physical iPhone for audio-session qualification. For microphone tests select playAndRecord or record and the recording companion. Interrupt and explicitly Resume after capture loss.",
    expected:
      "Valid session settings recover as configured; invalid combinations return errors. This feature is iOS only.",
  },
  devices: {
    rank: 10,
    steps:
      "Choose playback or recording. Disconnect/reconnect wired or Bluetooth devices while active, switch apps, return, and refresh the device list. Listen or replay to confirm the actual route.",
    expected:
      "The list reflects the change. Actual audio uses the intended route; stable Android microphone selection is unavailable.",
  },
};
