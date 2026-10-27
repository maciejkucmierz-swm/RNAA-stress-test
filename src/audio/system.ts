import Constants from "expo-constants";
import { Platform } from "react-native";
import * as API from "react-native-audio-api";
import {
  BlockedError,
  manual,
  passed,
  type Outcome,
  type Settings,
} from "../workshop/types";
import type { Emit } from "./contracts";
import type { AudioEngine } from "./engine";
import { checkedResult, inspectCapabilities, json, n, str } from "./utils";
export async function system(
  engine: AudioEngine,
  id: string,
  action: string,
  s: Settings,
  emit: Emit,
): Promise<Outcome> {
  if (id === "permissions") {
    const requested = action === "microphone" || action === "notification";
    const label = action === "microphone" ? "Microphone" : "Notifications";
    const before =
      action === "microphone"
        ? await API.AudioManager.checkRecordingPermissions()
        : action === "notification"
          ? await API.AudioManager.checkNotificationPermissions()
          : null;
    const value =
      action === "microphone"
        ? await API.AudioManager.requestRecordingPermissions()
        : action === "notification"
          ? await API.AudioManager.requestNotificationPermissions()
          : {
              microphone: await API.AudioManager.checkRecordingPermissions(),
              notifications:
                await API.AudioManager.checkNotificationPermissions(),
            };
    emit("permissions", value);
    if (!requested) {
      const states = value as {
        microphone: string;
        notifications: string;
      };
      return passed(
        `Microphone: ${states.microphone}. Notifications: ${states.notifications}. These are the phone's saved permission choices.`,
      );
    }
    if (value === "Denied" || value === "Undetermined")
      throw new BlockedError(
        `${label}: ${value}. If no prompt appeared, the phone may require a change in app settings. Tap Open app settings, change access, return, then Check permissions. Reset feature settings does not reset permissions.`,
      );
    return passed(
      `${label}: ${String(value)}.${before === "Granted" ? " Access was already allowed, so another system prompt is not expected." : " The permission request completed."}`,
    );
  }
  if (id === "session") {
    const ticket = engine.systemEpoch;
    if (action === "apply") {
      engine.sessionOptions = {
        iosCategory: str(s, "category", "playback") as API.IOSCategory,
        iosMode: str(s, "mode", "default") as API.IOSMode,
        iosOptions: json(s, "options", "[]"),
        iosAllowHaptics: !!s.haptics,
        iosNotifyOthersOnDeactivation: !!s.notifyOthers,
      };
      engine.sessionManagementDisabled = false;
      API.AudioManager.setAudioSessionOptions(engine.sessionOptions);
    }
    if (action === "activate" || action === "deactivate") {
      engine.sessionManagementDisabled = false;
      if (action === "activate") engine.sessionActivityOwned = true;
      engine.sessionActivityUpdate = API.AudioManager.setAudioSessionActivity(
        action === "activate",
      );
      await engine.sessionActivityUpdate;
      if (ticket !== engine.systemEpoch)
        throw new BlockedError("Session operation cancelled by Stop all.");
      if (action === "deactivate") {
        const result = API.AudioRecorder.consumeLastRecordingResult();
        if (result) {
          if (engine.activeCapture?.scope.alive)
            engine.activeCapture.accept(result);
          else engine.rememberRecording(result);
          emit("nativeFileInfo", result);
        }
        if (engine.activeCapture && !engine.activeCapture.check)
          engine.backend.onSessionEnded(engine.activeCapture.scope);
      }
    }
    if (action === "disable") {
      if (engine.context && engine.context.state !== "closed")
        throw new BlockedError(
          "Close the live context first; disableSessionManagement must run before context creation.",
        );
      API.AudioManager.disableSessionManagement();
      engine.sessionManagementDisabled = true;
    }
    if (action === "reclaim")
      API.AudioManager.activelyReclaimSession(!!s.reclaim);
    emit("sessionAction", action);
    return manual(
      "Session operation completed. Confirm the expected OS audio behavior.",
    );
  }
  if (id === "system-events") {
    for (const subscription of engine.systemSubscriptions)
      subscription.remove();
    engine.systemSubscriptions = [];
    API.AudioManager.observeAudioInterruptions(
      action === "observe"
        ? (str(s, "focus", "gain") as API.AudioFocusType)
        : false,
    );
    if (action === "observe")
      engine.systemSubscriptions = [
        "interruption",
        "duck",
        "routeChange",
        "volumeChange",
      ].map((name) =>
        API.AudioManager.addSystemEventListener(
          name as Parameters<typeof API.AudioManager.addSystemEventListener>[0],
          (event) => emit(name, event),
        ),
      );
    return manual(
      action === "observe"
        ? "Observing system events. Trigger an external interruption, route change, or volume change."
        : "Observation stopped.",
    );
  }
  if (id === "devices") {
    if (action === "default") {
      throw new BlockedError(
        "Reset-to-default input is unavailable in RNAA 0.13.6.",
      );
    }
    const info = await API.AudioManager.getDevicesInfo();
    engine.state.devices = info.availableInputs;
    emit("devices", info);
    engine.notify();
    return passed(
      "Device enumeration returned. Input/output availability depends on the current session.",
    );
  }
  if (id === "volume") {
    emit("volumeCapabilities", inspectCapabilities());
    return manual(
      "Use the system-volume hook display and hardware buttons with audio active.",
    );
  }
  if (id === "background") {
    emit("background", {
      ...Constants.expoConfig?.extra,
      recordingOngoing: API.AudioRecorder.isRecordingOngoing(),
      context: engine.inspect(),
    });
    return manual(
      "Background/lock the device, reopen, and confirm uninterrupted operation.",
    );
  }
  if (id === "record-recovery") {
    if (action === "consume") {
      const result = API.AudioRecorder.consumeLastRecordingResult();
      emit("lastNativeResult", result);
      if (result) {
        if (engine.activeCapture?.scope.alive)
          engine.activeCapture.accept(result);
        else engine.rememberRecording(result);
        if (engine.activeCapture && !engine.activeCapture.check)
          engine.backend.onSessionEnded(engine.activeCapture.scope);
      }
      engine.notify();
      return passed(
        result
          ? "Recording recovered. Find it in Saved recordings below."
          : "No completed recording is waiting. It may already be in Saved recordings below.",
      );
    }
    const ongoing = API.AudioRecorder.isRecordingOngoing();
    emit("isRecordingOngoing", ongoing);
    return passed(
      ongoing
        ? "The microphone recording is still active."
        : "No microphone recording is active.",
    );
  }
  const recording = id === "recording-notification";
  const manager = recording
    ? API.RecordingNotificationManager
    : API.PlaybackNotificationManager;
  if (action === "inspect") {
    emit("notificationActive", await manager.isActive());
    return passed("Notification active state returned.");
  }
  if (action === "hide") {
    const generation = ++engine.notificationGeneration;
    for (const subscription of engine.notificationSubscriptions)
      subscription.remove();
    engine.notificationSubscriptions = [];
    engine.notifyEmit = null;
    engine.playbackHandlers.clear();
    await engine.notificationUpdate?.catch(() => {});
    if (
      generation === engine.notificationGeneration &&
      (await manager.isActive())
    )
      await manager.hide();
    return manual(
      "Hide requested. On iOS suspend/close the live context to remove playback controls.",
    );
  }
  if (action === "control") {
    await API.PlaybackNotificationManager.enableControl(
      str(s, "control", "play") as API.PlaybackControlName,
      !!s.enabled,
    );
    return manual("Use the system notification to verify the control state.");
  }
  const ticket = engine.systemEpoch;
  let generation = engine.notificationGeneration;
  const cancelled = () =>
    ticket !== engine.systemEpoch ||
    generation !== engine.notificationGeneration;
  if ((await API.AudioManager.requestNotificationPermissions()) !== "Granted")
    throw new BlockedError("Notification permission denied.");
  if (cancelled())
    throw new BlockedError(
      "Notification request cancelled. Retry while audio is active.",
    );
  if (recording && !API.AudioRecorder.isRecordingOngoing())
    throw new BlockedError("Start recording in the Recording tab first.");
  if (!recording && (!engine.context || engine.context.state === "closed"))
    throw new BlockedError("Start playback in another tab first.");
  generation = ++engine.notificationGeneration;
  for (const subscription of engine.notificationSubscriptions)
    subscription.remove();
  engine.notificationSubscriptions = [];
  engine.notifyEmit = emit;
  if (recording) {
    const eventNames = [
      "recordingNotificationPause",
      "recordingNotificationResume",
      "recordingNotificationStop",
    ] as const;
    engine.notificationSubscriptions = eventNames.map((name) =>
      API.RecordingNotificationManager.addEventListener(name, () => {
        if (cancelled()) return;
        engine.notifyEmit?.(name);
        if (name === "recordingNotificationStop") {
          const result = API.AudioRecorder.consumeLastRecordingResult();
          if (result) {
            try {
              if (engine.activeCapture?.scope.alive)
                engine.activeCapture.accept(result);
              else engine.rememberRecording(result);
            } catch (error) {
              if (engine.activeCapture)
                engine.backend.onSessionError(
                  engine.activeCapture.scope,
                  error,
                );
            }
            engine.notifyEmit?.("nativeFileInfo", result);
          }
          if (engine.activeCapture && !engine.activeCapture.check)
            engine.backend.onSessionEnded(engine.activeCapture.scope);
        }
      }),
    );
    engine.notificationUpdate = API.RecordingNotificationManager.show({
      ...s,
      title: str(s, "title"),
      contentText: str(s, "contentText"),
    });
  } else {
    const events = [
      "playbackNotificationPlay",
      "playbackNotificationPause",
      "playbackNotificationStop",
      "playbackNotificationNextTrack",
      "playbackNotificationPreviousTrack",
      "playbackNotificationSkipForward",
      "playbackNotificationSkipBackward",
      "playbackNotificationSeekTo",
      "playbackNotificationDismissed",
    ] as const;
    const owner = engine.mediaScope ?? engine.controls?.scope ?? null;
    const ownerContext = engine.context;
    const ownerMedia = engine.mediaHandle;
    engine.playbackHandlers.clear();
    engine.notificationSubscriptions = events.map((name) => {
      const handler = (
        event: {
          value?: number;
        } = {},
      ) => {
        if (cancelled() || (owner && !owner.alive)) return;
        engine.notifyEmit?.(name, event);
        const transition = (
          operation: () => void | Promise<unknown>,
          playbackState: "playing" | "paused",
        ) => {
          // Keep rapid Pause/Play events ordered, and let Stop all await pending updates.
          const pending = (engine.notificationUpdate ?? Promise.resolve())
            .catch(() => {})
            .then(async () => {
              if (cancelled() || (owner && !owner.alive)) return;
              await operation();
              if (cancelled() || (owner && !owner.alive)) return;
              await API.PlaybackNotificationManager.show({
                state: playbackState,
              });
              engine.notifyEmit?.("notificationPlaybackState", playbackState);
              engine.inspect();
            });
          engine.notificationUpdate = pending;
          void (owner ? owner.hold(pending) : pending).catch((error) => {
            if (owner?.alive) engine.backend.onSessionError(owner, error);
            else engine.notifyEmit?.("notificationError", String(error));
          });
        };
        if (name === "playbackNotificationPause")
          transition(
            () => (ownerMedia ? ownerMedia.pause() : ownerContext?.suspend()),
            "paused",
          );
        if (name === "playbackNotificationPlay")
          transition(
            () => (ownerMedia ? ownerMedia.play() : ownerContext?.resume()),
            "playing",
          );
        if (name === "playbackNotificationStop" && owner)
          engine.backend.onSessionEnded(owner);
        if ("value" in event && name === "playbackNotificationSeekTo")
          engine.mediaHandle?.seekToTime(Number(event.value));
      };
      engine.playbackHandlers.set(name, handler);
      return API.PlaybackNotificationManager.addEventListener(name, handler);
    });
    engine.notificationUpdate = API.PlaybackNotificationManager.show({
      title: str(s, "title"),
      artist: str(s, "artist"),
      album: str(s, "album"),
      artwork: str(s, "artwork") || undefined,
      androidSmallIcon: str(s, "smallIcon") || undefined,
      duration: n(s, "duration", 3),
      elapsedTime: n(s, "elapsedTime"),
      speed: n(s, "speed", 1),
      state: str(s, "state", "playing") as "playing" | "paused",
    });
  }
  await engine.notificationUpdate;
  if (cancelled()) throw new BlockedError("Notification operation cancelled.");
  return manual(
    "Use the system notification controls, then record the observed behavior.",
  );
}

export async function idle(engine: AudioEngine) {
  engine.systemEpoch++;
  engine.notificationGeneration++;
  if (engine.notificationUpdate) {
    await engine.notificationUpdate.catch(() => {});
    engine.notificationUpdate = null;
  }
  if (engine.sessionActivityUpdate) {
    await engine.sessionActivityUpdate.catch(() => {});
    engine.sessionActivityUpdate = null;
  }
  if (engine.contextActivityUpdate) {
    await engine.contextActivityUpdate.catch(() => {});
    engine.contextActivityUpdate = null;
  }
  const failures: unknown[] = [];
  const attempt = async (operation: () => unknown) => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };
  for (const subscription of [
    ...engine.systemSubscriptions,
    ...engine.notificationSubscriptions,
  ])
    await attempt(() => subscription.remove());
  engine.systemSubscriptions = [];
  engine.notificationSubscriptions = [];
  engine.notifyEmit = null;
  engine.playbackHandlers.clear();

  await attempt(() => API.AudioManager.observeAudioInterruptions(false));
  if (Platform.OS === "ios")
    await attempt(() => API.AudioManager.activelyReclaimSession(false));
  await attempt(async () => {
    if (engine.recorder?.isRecording() || engine.recorder?.isPaused()) {
      const result = await engine.recorder.stop();
      checkedResult(result);
      if (result.status === "success" && result.paths.length)
        engine.rememberRecording(result);
    }
  });
  await attempt(() => engine.recorder?.clearOnAudioReady());
  await attempt(() => engine.recorder?.clearOnError());
  await attempt(() => engine.recorder?.disconnect());
  // iOS rejects hide() for a notification key that was never created.
  // Recording notifications do not exist on iOS at all.
  await attempt(async () => {
    if (await API.PlaybackNotificationManager.isActive())
      await API.PlaybackNotificationManager.hide();
  });
  if (Platform.OS === "android")
    await attempt(async () => {
      if (await API.RecordingNotificationManager.isActive())
        await API.RecordingNotificationManager.hide();
    });
  await attempt(async () => {
    if (engine.context?.state === "running") await engine.context.suspend();
  });
  if (engine.sessionActivityOwned && Platform.OS === "ios") {
    await attempt(() => API.AudioManager.setAudioSessionActivity(false));
    engine.sessionActivityOwned = false;
    await attempt(() =>
      API.AudioManager.setAudioSessionOptions(engine.sessionOptions),
    );
  }
  engine.inspect();
  if (failures.length)
    throw new AggregateError(failures, "Audio cleanup failed.");
}
