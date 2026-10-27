import { SessionScope } from "../workshop/session";
import { manual, type Settings } from "../workshop/types";
import type { Backend, Emit } from "./contracts";
import type { AudioEngine } from "./engine";
import { fixturePath } from "./fixtures";
import { checkMilliseconds, headers, n, str } from "./utils";
export async function startMedia(
  engine: AudioEngine,
  id: string,
  action: string,
  s: Settings,
  scope: SessionScope,
  emit: Emit,
) {
  const ctx = engine.live(s);

  if (s.autoPlay !== false && s.preload !== "none")
    await scope.hold(ctx.resume());
  scope.ensureActive();
  const path =
    s.input === "hls"
      ? str(s, "hlsUrl")
      : s.input === "url"
        ? str(s, "url")
        : await fixturePath(str(s, "fixture", "stereo.wav"));
  scope.ensureActive();
  engine.mediaLoaded = false;
  engine.mediaRouted = false;
  engine.mediaError = null;
  engine.mediaScope = scope;
  engine.mediaEmit = emit;
  const key = `${Date.now()}-${Math.random()}`;
  engine.state.media = {
    key,
    source: path,
    settings: { ...s, headers: JSON.stringify(headers(s)) },
    route: id === "media-route",
  };
  scope.defer(() => {
    engine.mediaHandle?.pause();
    engine.mediaHandle = null;
    if (engine.state.media?.key === key) engine.state.media = null;
    engine.mediaEmit = null;
    engine.mediaScope = null;
    engine.notify();
  });
  engine.setControls(id, scope, {
    pause: () => engine.mediaHandle?.pause(),
    resume: () => engine.mediaHandle?.play(),
    seek: (value) => engine.mediaHandle?.seekToTime(n(value, "seek", 1)),
    apply: (value) => {
      engine.mediaHandle?.setVolume(n(value, "volume", 0.1));
      engine.mediaHandle?.setMuted(!!value.muted);
      engine.mediaHandle?.setPlaybackRate(n(value, "playbackRate", 1));
    },
  });
  engine.notify();
  if (action === "check") {
    const deadline =
      Date.now() + (s.preload === "none" && s.autoPlay === false ? 0 : 15000);
    while (!engine.mediaLoaded && !engine.mediaError && Date.now() < deadline)
      await scope.wait(100);
    if (engine.mediaError) throw engine.mediaError;
    if (!engine.mediaLoaded && s.preload !== "none")
      throw new Error(
        "Media did not load within 15 seconds. Check the URL, network, and codec build.",
      );
    if (s.preload !== "none") await scope.wait(checkMilliseconds(s));
  }
  return manual(
    s.preload === "none"
      ? "Preload is none. Use Start and the player controls to verify manual loading/playback; a finite check does not retain the player."
      : "Media mounted. Confirm playback, seeking, buffering, and the control state.",
  );
}
export function createMediaHandlers(
  engine: AudioEngine,
): Pick<Backend, "attachMedia" | "mediaEvent"> {
  return {
    attachMedia(handle, key) {
      if (key && key !== engine.state.media?.key) return;
      engine.mediaHandle = handle;
    },
    mediaEvent(name, value, key) {
      if (key && key !== engine.state.media?.key) return;
      if (!engine.mediaScope?.alive) return;
      engine.mediaEmit?.(name, value);
      if (name === "error") {
        engine.mediaError =
          value instanceof Error ? value : new Error(String(value));
        // Fault injection keeps this scoped media error for the runner to inspect/recover.
        if (!engine.state.media?.settings.stressExpectedNetworkFailure)
          engine.backend.onSessionError(engine.mediaScope, engine.mediaError);
      }
      if (
        engine.context &&
        (name === "play" ||
          name === "pause" ||
          (name === "ended" && !engine.state.media?.settings.loop))
      ) {
        const scope = engine.mediaScope;
        const operation =
          name === "play" ? engine.context.resume() : engine.context.suspend();
        void scope.hold(operation).catch((error) => {
          if (scope.alive) engine.backend.onSessionError(scope, error);
        });
      }
      if (name === "load") {
        engine.mediaLoaded = true;
        if (
          engine.state.media?.route &&
          !engine.mediaRouted &&
          engine.mediaHandle &&
          engine.context
        ) {
          try {
            const source = engine.context.createMediaElementSource(
              engine.mediaHandle,
            );
            const gain = engine.context.createGain();
            gain.gain.value = n(engine.state.media.settings, "gain", 0.5);
            source.connect(gain);
            gain.connect(engine.context.destination);
            engine.mediaScope.defer(() => {
              source.disconnect();
              gain.disconnect();
            });
            engine.mediaRouted = true;
            engine.mediaEmit?.("mediaRouteConnected");
          } catch (error) {
            engine.mediaError = error;
            engine.mediaEmit?.("mediaRouteError", String(error));
          }
        }
      }
    },
  };
}
