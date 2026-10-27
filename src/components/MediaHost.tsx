import {
  memo,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { View } from "react-native";
import {
  Audio,
  isPlaybackActive,
  useAudioTagContext,
  type AudioTagHandle,
} from "react-native-audio-api";
import type { MediaRequest } from "../audio/contracts";
import { backend, workshop } from "../workshop/runtime";
import { Button, Caption, Disclosure, Toggle, styles } from "./ui";

// The engine stays mounted across navigation; only its controls appear in the feature card.
// This relays the documented hook state, without another player or an audio wrapper.
type PlayerState = ReturnType<typeof useAudioTagContext>;
let inlineState: { key: string; player: PlayerState } | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function publish(value: typeof inlineState) {
  inlineState = value;
  listeners.forEach((listener) => listener());
}
function PlayerObserver({ playerKey }: { playerKey: string }) {
  const player = useAudioTagContext();
  useEffect(() => {
    publish({ key: playerKey, player });
  }, [playerKey, player]);
  useEffect(
    () => () => {
      if (inlineState?.key === playerKey) publish(null);
    },
    [playerKey],
  );
  return null;
}
function runMediaControl(control: () => void) {
  try {
    control();
  } catch (error) {
    workshop.reportError(error);
  }
}

export function InlineMediaControls({ playerKey }: { playerKey: string }) {
  const observed = useSyncExternalStore(
    subscribe,
    () => inlineState,
    () => null,
  );
  if (observed?.key !== playerKey) return <Caption>Loading player…</Caption>;
  const state = observed.player;
  return (
    <View style={{ gap: 8 }}>
      <Caption>
        {state.ready
          ? isPlaybackActive(state.playbackState)
            ? state.playbackState === "buffering"
              ? "Buffering…"
              : "Playing"
            : "Paused"
          : "Loading…"}{" "}
        ·{" "}
        {Number.isFinite(state.currentTime)
          ? state.currentTime.toFixed(1)
          : "?"}{" "}
        / {Number.isFinite(state.duration) ? state.duration.toFixed(1) : "?"}{" "}
        seconds
      </Caption>
      <View style={styles.row}>
        <Button
          onPress={() =>
            runMediaControl(() =>
              isPlaybackActive(state.playbackState)
                ? state.pause()
                : state.play(),
            )
          }
        >
          {isPlaybackActive(state.playbackState) ? "Pause" : "Play"}
        </Button>
        <Button destructive onPress={() => void workshop.stopAll()}>
          Stop player
        </Button>
      </View>
      <Toggle
        label="Mute player"
        value={state.muted}
        onChange={(value) => runMediaControl(() => state.setMuted(value))}
      />
      <Disclosure title="Extra player controls">
        <Button
          secondary
          onPress={() =>
            runMediaControl(() =>
              state.seekToTime(Math.min(state.duration, state.currentTime + 1)),
            )
          }
        >
          Skip forward 1 second
        </Button>
      </Disclosure>
    </View>
  );
}
export const MediaHost = memo(function MediaHost({
  request,
}: {
  request: MediaRequest | null;
}) {
  const [loadError, setLoadError] = useState("");
  const source = useMemo(
    () => ({
      uri: request?.source,
      headers: JSON.parse(String(request?.settings.headers ?? "{}")),
    }),
    [request],
  );
  const key = request?.key;
  const attachPlayer = useMemo(
    () => (handle: AudioTagHandle | null) => backend.attachMedia(handle, key),
    [key],
  );
  const handlers = useMemo(() => {
    const report = (name: string, value?: unknown) =>
      backend.mediaEvent(name, value, key);
    return {
      onLoadStart: () => report("loadStart"),
      onLoad: () => report("load"),
      onError: (error: Error) => {
        if (backend.snapshot.media?.key !== key) return;
        setLoadError(error.message);
        report("error", error);
      },
      onPositionChange: (seconds: number) => report("position", seconds),
      onEnded: () => report("ended"),
      onPlay: () => report("play"),
      onPause: () => report("pause"),
      onVolumeChange: (volume: number) => report("volume", volume),
      onWaiting: () => report("waiting"),
      onPlaying: () => report("playing"),
    };
  }, [key]);
  if (!request) return null;
  const s = request.settings;
  return (
    <View style={{ height: 0, overflow: "hidden" }}>
      <Audio
        key={request.key}
        ref={attachPlayer}
        context={backend.mediaContext!}
        source={source}
        controls={false}
        autoPlay={s.autoPlay === undefined ? true : !!s.autoPlay}
        loop={!!s.loop}
        muted={!!s.muted}
        volume={Number(s.volume ?? 0.1)}
        playbackRate={Number(s.playbackRate ?? 1)}
        preservesPitch={
          s.preservesPitch === undefined ? true : !!s.preservesPitch
        }
        preload={String(s.preload ?? "auto") as "auto" | "metadata" | "none"}
        forceDownload={!!s.forceDownload}
        {...handlers}
      >
        <PlayerObserver playerKey={request.key} />
      </Audio>
      {!!loadError && <Caption>{loadError}</Caption>}
    </View>
  );
});
