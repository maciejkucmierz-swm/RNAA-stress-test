import { openSettings } from "expo-linking";
import { useState } from "react";
import { Platform, Text, View } from "react-native";
import { useAudioInput, useSystemVolume } from "react-native-audio-api";
import { RectButton } from "react-native-gesture-handler";
import { useWorkshop, useWorkshopData } from "../workshop/hooks";
import {
  actionLabel,
  basicFields,
  hasAudioSetup,
  primaryActions,
  resultLabels,
  transportPaused,
} from "../workshop/presentation";
import { apiName, defaults } from "../workshop/registry";
import { backend, workshop } from "../workshop/runtime";
import {
  availability,
  type Action,
  type Feature,
  type Field,
  type Settings,
} from "../workshop/types";
import { ResultView } from "./FeatureResult";
import { FeatureStressControl } from "./FeatureStressControl";
import { InlineMediaControls } from "./MediaHost";
import { Recordings } from "./SavedData";
import {
  Button,
  Caption,
  Choice,
  Disclosure,
  Input,
  Plot,
  Toggle,
  styles,
} from "./ui";
export function FieldControl({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: Settings[string];
  onChange: (value: Settings[string]) => void;
}) {
  let options = field.options;
  if (field.key === "format")
    options = options?.filter((option) => backend.formats.includes(option));
  return typeof field.value === "boolean" ? (
    <Toggle label={field.label} value={!!value} onChange={onChange} />
  ) : options ? (
    <Choice
      label={field.label}
      value={String(value)}
      options={options}
      onChange={onChange}
    />
  ) : (
    <Input
      label={field.label}
      value={String(value)}
      numeric={typeof field.value === "number"}
      onChange={onChange}
    />
  );
}
export function Devices() {
  const input = useAudioInput();
  const selectable = Platform.OS === "ios";
  return (
    <View style={{ gap: 8 }}>
      <Caption>
        Microphone: {input.currentInput?.name ?? "System default"}
      </Caption>
      {selectable && input.availableInputs.length > 0 && (
        <Choice
          label="Microphone input"
          value={input.currentInput?.id ?? ""}
          options={input.availableInputs.map((device) => ({
            value: device.id,
            label: device.name,
          }))}
          onChange={(id) => void workshop.selectInput(id)}
        />
      )}
      {!selectable && (
        <Caption>
          This Android library version lists devices but cannot select a
          microphone.
        </Caption>
      )}
    </View>
  );
}
export function Volume() {
  const volume = useSystemVolume();
  return (
    <Caption>
      Phone volume: {Math.round(volume * 100)}%. Press the phone’s volume
      buttons to update it.
    </Caption>
  );
}
export function ActivePlot() {
  const snapshot = useWorkshop();
  return snapshot.backend.plot ? <Plot {...snapshot.backend.plot} /> : null;
}
export function FeatureCard({
  feature,
  open,
  onToggle,
}: {
  feature: Feature;
  open: boolean;
  onToggle: () => void;
}) {
  const snapshot = useWorkshopData();
  const [settings, setSettings] = useState<Settings>(() => defaults(feature));
  const [notificationVisible, setNotificationVisible] = useState(true);
  const result = snapshot.results.find((item) => item.featureId === feature.id);
  const reason = availability(feature, Platform.OS);
  const busy = snapshot.busy.includes(feature.id),
    active = snapshot.activeId === feature.id;
  const notification = [
    "recording-notification",
    "playback-notification",
  ].includes(feature.id);
  const audioSetup = hasAudioSetup(feature);
  const fieldKeys = [
    ...basicFields(feature),
    ...(settings.input === "url"
      ? ["url"]
      : settings.input === "hls"
        ? ["hlsUrl"]
        : []),
  ];
  const fields = feature.fields;
  const current = open && active ? backend.scenarioState() : null;
  const paused = transportPaused(feature, current);
  const media =
    (feature.id === "audio-tag" && !snapshot.backend.media?.route) ||
    (feature.id === "media-route" && snapshot.backend.media?.route)
      ? snapshot.backend.media
      : null;
  const queue =
    feature.id === "queue" && active ? snapshot.backend.queue : null;
  const primary = primaryActions(
    feature,
    active,
    paused,
    queue?.state === "empty",
  );
  const run = async (action: Action) => {
    await workshop.execute(feature, action, settings);
    if (action.id === "close") await workshop.stopAll();
    return workshop
      .getSnapshot()
      .results.find((item) => item.featureId === feature.id);
  };
  const renderAction = (action: Action, secondary = false) => (
    <Button
      key={action.id}
      secondary={secondary || action.id === "apply"}
      destructive={["stop", "close"].includes(action.id)}
      disabled={!!reason || (busy && action.id !== "stop")}
      onPress={() =>
        void run(action).catch(workshop.reportError.bind(workshop))
      }
    >
      {busy && action.session ? "Starting…" : actionLabel(action.id, feature)}
    </Button>
  );
  const field = (item: Field) => (
    <FieldControl
      key={item.key}
      field={item}
      value={settings[item.key]}
      onChange={(value) =>
        setSettings((previous) => ({ ...previous, [item.key]: value }))
      }
    />
  );
  return (
    <View style={styles.card}>
      <RectButton onPress={onToggle} style={{ padding: 16 }}>
        <View
          accessible
          accessibilityRole="button"
          accessibilityLabel={`${feature.title}, ${open ? "collapse" : "expand"}`}
          accessibilityState={{ expanded: open }}
        >
          <View style={[styles.row, { justifyContent: "space-between" }]}>
            <Text style={[styles.title, { flex: 1 }]}>{feature.title}</Text>
            <Text style={styles.caption}>{open ? "−" : "+"}</Text>
          </View>
          <Caption>
            {reason
              ? "Unavailable on this build"
              : active
                ? "● Running"
                : result
                  ? resultLabels[result.status]
                  : "Tap to open"}
          </Caption>
        </View>
      </RectButton>
      {open && (
        <View style={[styles.cardBody, { paddingTop: 0 }]}>
          {!!reason ? (
            <Caption>{reason}</Caption>
          ) : (
            <>
              {notification ? (
                <Caption>
                  {feature.id === "recording-notification"
                    ? "Record and use the phone’s notification controls. Everything starts here."
                    : "Play a looping sound and try the phone’s playback controls. Everything starts here."}
                </Caption>
              ) : (
                <Caption>{feature.description}</Caption>
              )}
              {fields.filter((item) => fieldKeys.includes(item.key)).map(field)}
              {feature.id === "queue" && (
                <>
                  <Caption>
                    Play queues two copies of a file; they do not loop. Changing
                    Fixture affects the next Play or Enqueue, not Resume.
                  </Caption>
                  {settings.fixture === "silence.wav" && (
                    <Caption>
                      Selected silence.wav intentionally contains no sound.
                    </Caption>
                  )}
                  {!!queue && (
                    <Caption>
                      {queue.state === "empty"
                        ? "Queue finished: no buffers remain. Press Play to load the selected file again."
                        : `${queue.queuedBuffers} buffers left · queued file: ${queue.currentFixture}${queue.currentFixture === "silence.wav" ? " (intentionally silent)" : ""}`}
                    </Caption>
                  )}
                  {backend.channel === "stable" && (
                    <Caption>
                      In RNAA 0.13.6, Resume uses the Fabric demo’s
                      explicit-offset call: it restarts the current buffer at
                      the chosen offset, rather than resuming at the exact
                      paused position.
                    </Caption>
                  )}
                </>
              )}
              {audioSetup ? (
                <>
                  {!notification && feature.id !== "record-recovery" && (
                    <Choice
                      label="Audio for this check"
                      value={String(settings.testAudio ?? "playback")}
                      disabled={active || busy}
                      options={[
                        { value: "playback", label: "Looping sound" },
                        { value: "recording", label: "Microphone recording" },
                      ]}
                      onChange={(value) =>
                        setSettings((previous) => ({
                          ...previous,
                          testAudio: value,
                        }))
                      }
                    />
                  )}
                  <View style={styles.row}>
                    {!active && (
                      <Button
                        disabled={busy}
                        onPress={() => {
                          setNotificationVisible(true);
                          void run({
                            id: "start-with-audio",
                            label: "Start",
                            session: true,
                          }).catch(workshop.reportError.bind(workshop));
                        }}
                      >
                        {busy
                          ? "Starting…"
                          : feature.id === "recording-notification"
                            ? "Record with notification"
                            : feature.id === "playback-notification"
                              ? "Play with notification"
                              : feature.id === "record-recovery"
                                ? "Start test recording"
                                : "Start with test audio"}
                      </Button>
                    )}
                    {active && (
                      <Button
                        destructive
                        onPress={() =>
                          void run({ id: "stop", label: "Stop" }).catch(
                            workshop.reportError.bind(workshop),
                          )
                        }
                      >
                        {feature.id === "recording-notification"
                          ? "Stop recording"
                          : "Stop test audio"}
                      </Button>
                    )}
                    {(active || feature.id === "record-recovery") &&
                      !notification &&
                      feature.actions
                        .filter((action) => primary.includes(action.id))
                        .map((action) => renderAction(action, true))}
                  </View>
                  {active && notification && (
                    <Toggle
                      label="Show notification"
                      value={notificationVisible}
                      disabled={busy}
                      onChange={(value) => {
                        setNotificationVisible(value);
                        void run({
                          id: value ? "show" : "hide",
                          label: value ? "Show" : "Hide",
                        })
                          .then((outcome) => {
                            if (
                              outcome &&
                              ["failed", "blocked", "unavailable"].includes(
                                outcome.status,
                              )
                            )
                              setNotificationVisible(!value);
                          })
                          .catch((error) => {
                            setNotificationVisible(!value);
                            workshop.reportError(error);
                          });
                      }}
                    />
                  )}
                </>
              ) : media ? (
                <InlineMediaControls playerKey={media.key} />
              ) : (
                <View style={styles.row}>
                  {feature.actions
                    .filter((action) => primary.includes(action.id))
                    .map((action) => renderAction(action))}
                </View>
              )}
              {feature.id === "permissions" && (
                <>
                  <Button
                    secondary
                    onPress={() =>
                      void openSettings().catch(
                        workshop.reportError.bind(workshop),
                      )
                    }
                  >
                    Open phone permissions
                  </Button>
                  <Caption>
                    Already allowed or denied? Change access in phone settings,
                    then check again here.
                  </Caption>
                </>
              )}
              {feature.id === "devices" && snapshot.hooksEnabled && <Devices />}
              {feature.id === "volume" && snapshot.hooksEnabled && <Volume />}
              {active && <ActivePlot />}
              {["recording-notification", "record-recovery"].includes(
                feature.id,
              ) &&
                !active && <Recordings />}
              {result && <ResultView key={result.id} result={result} />}
              <FeatureStressControl feature={feature} settings={settings} />
              <Disclosure title="Advanced settings and actions">
                <Caption>{apiName(feature)}</Caption>
                {feature.knownIssue && <Caption>{feature.knownIssue}</Caption>}
                {fields
                  .filter((item) => !fieldKeys.includes(item.key))
                  .map(field)}
                <View style={styles.row}>
                  {feature.actions
                    .filter((action) => !primary.includes(action.id))
                    .map((action) => renderAction(action, true))}
                </View>
                {feature.id !== "permissions" && (
                  <Button
                    secondary
                    disabled={active || busy}
                    onPress={() => setSettings(defaults(feature))}
                  >
                    Restore default settings
                  </Button>
                )}
              </Disclosure>
            </>
          )}
        </View>
      )}
    </View>
  );
}
