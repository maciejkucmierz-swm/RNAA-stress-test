import { useEffect, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { production } from "../production/runtime";
import { defaultStressOptions, type StressId } from "../stress/catalog";
import { featureLoadPlan, featureLoadRecipe } from "../stress/feature-load";
import { exportStressReports, stress } from "../stress/runtime";
import { companionFor, features } from "../workshop/registry";
import { workshop } from "../workshop/runtime";
import type { Feature, Settings } from "../workshop/types";
import { ProductionControls } from "./ProductionControls";
import { BusyUI, StressReportView } from "./StressReportView";
import {
  Button,
  Caption,
  Choice,
  Disclosure,
  Input,
  Toggle,
  colors,
  styles,
} from "./ui";

export function FeatureStressControl({
  feature,
  settings,
  unavailable,
}: {
  feature: Feature;
  settings: Settings;
  unavailable?: string;
}) {
  return (
    <Disclosure title="Production edge cases">
      <ProductionControls
        feature={feature}
        settings={settings}
        unavailable={unavailable}
      />
      {!["permissions", "capabilities"].includes(feature.id) && (
        <Disclosure title="Advanced repetition checks">
          <LoadOptions
            feature={feature}
            settings={settings}
            unavailable={unavailable}
          />
        </Disclosure>
      )}
    </Disclosure>
  );
}

function LoadOptions({
  feature,
  settings,
  unavailable,
}: {
  feature: Feature;
  settings: Settings;
  unavailable?: string;
}) {
  const snapshot = useSyncExternalStore(
    stress.subscribe,
    stress.getSnapshot,
    stress.getSnapshot,
  );
  const [level, setLevel] = useState(1),
    [mode, setMode] = useState<"repeat" | "live">("repeat");
  const [companion, setCompanion] = useState<"playback" | "recording">(
    companionFor(feature),
  );
  const [seed, setSeed] = useState(String(defaultStressOptions.seed));
  const [serverUrl, setServerUrl] = useState(defaultStressOptions.serverUrl);
  const recipe = featureLoadRecipe(feature);
  const options = {
    ...defaultStressOptions,
    level,
    targetFeatureId: feature.id,
    targetSettings: settings,
    loadMode: mode,
    companion,
    seed: Number(seed),
    serverUrl,
  };
  const plan = featureLoadPlan(options);
  const suite = feature.workload.suite;
  const related = snapshot.reports.filter(
    (report) =>
      report.options.targetFeatureId === feature.id ||
      (!!suite && report.featureId === suite),
  );
  const active = snapshot.active;
  const ownsActive =
    active &&
    (active.options.targetFeatureId === feature.id ||
      active.featureId === suite);
  const [selected, setSelected] = useState<string | null>(null);
  const report = related.find((item) => item.id === selected) ?? related[0];
  useEffect(() => {
    void stress.initialize();
  }, []);
  const start = (id: StressId) => {
    setSelected(null);
    void stress
      .start(id, options)
      .catch((error) => workshop.reportError(error));
  };
  return (
    <>
      <Choice
        label="Repetition level"
        value={String(level)}
        options={Array.from({ length: 10 }, (_, index) => String(index + 1))}
        disabled={!!active}
        onChange={(value) => setLevel(Number(value))}
      />
      <Text style={[styles.text, level > 5 && { color: colors.failed }]}>
        {level > 5
          ? "Warning: above level 5 is stress-test territory. Expect heavier load, interruptions, and possible app hangs."
          : "Levels 1–5 are lighter workloads. Above 5 enters stress-test territory."}
      </Text>
      <Caption>
        Level increases repetitions or live-check time, not volume. Uses the
        settings in this feature. One live session/recorder at a time. Stop all
        works from every tab.
      </Caption>
      {recipe.live && recipe.kind !== "live-system" && (
        <Toggle
          label="Keep audio running for manual disruptions"
          value={mode === "live"}
          disabled={!!active}
          onChange={(value) => setMode(value ? "live" : "repeat")}
        />
      )}
      {recipe.kind === "live-system" &&
        feature.workload.companion === "select" && (
          <Choice
            label="Sound for this check"
            value={companion}
            disabled={!!active}
            options={[
              { value: "playback", label: "Looping playback" },
              { value: "recording", label: "Live recorder" },
            ]}
            onChange={(value) =>
              setCompanion(value as "playback" | "recording")
            }
          />
        )}
      <Text style={styles.text}>{plan.usage}</Text>
      {plan.keepRunning && (
        <Caption>
          Keep this running while you switch tabs/apps, open/close
          notifications, and lock/unlock. These actions stay manual. Finish live
          check ends normally; Stop all cancels.
        </Caption>
      )}
      {plan.manual.map((instruction) => (
        <Caption key={instruction}>• {instruction}</Caption>
      ))}
      {feature.id === "permissions" && (
        <Caption>
          This repeats permission reads. Request access with the normal feature
          buttons; it does not repeatedly display OS prompts.
        </Caption>
      )}
      {recipe.kind === "record" && (
        <Caption>
          Microphone speaker monitoring stays off during load tests. Replay new
          files in Recording afterward.
        </Caption>
      )}
      {feature.id === "audio-tag" && mode === "repeat" && (
        <Caption>
          This workload deliberately alternates mute/unmute; those silent
          sections are expected.
        </Caption>
      )}
      <Input
        label={`Seed for ${feature.title}`}
        value={seed}
        onChange={setSeed}
        numeric
      />
      {unavailable && (
        <Text style={[styles.text, { color: colors.failed }]}>
          {unavailable}
        </Text>
      )}
      <Button
        disabled={!!active || !!unavailable}
        onPress={() => start("feature-load")}
      >
        Run {feature.title} · level {level}
      </Button>
      {!!active && (
        <Caption>
          {ownsActive
            ? `Running: ${active.phase}`
            : `Another load test is active: ${active.name}. Stop it before starting this one.`}
        </Caption>
      )}
      {!!ownsActive && (
        <>
          <Caption>
            {Math.round(active.elapsedMs / 1000)} s ·{" "}
            {active.counters.completed} completed operations
          </Caption>
          <BusyUI active={active.metrics.uiLoadActive === true} />
          {active.featureId === "feature-load" &&
            featureLoadPlan(active.options).keepRunning && (
              <Button onPress={() => stress.finishLive()}>
                Finish live check
              </Button>
            )}
          <Button onPress={() => void workshop.stopAll()}>
            Stop load test
          </Button>
        </>
      )}
      {!!snapshot.error && (
        <Text style={[styles.text, { color: colors.failed }]}>
          {snapshot.error}
        </Text>
      )}
      {!!suite && (
        <View style={{ gap: 8 }}>
          <Caption>
            Also available: the earlier measured {suite} suite. This has its own
            fixed Quick workload; it does not use the level selector or feature
            settings above.
          </Caption>
          {suite === "streaming-recovery" && (
            <>
              <Caption>
                Start npm run stress:server on the computer first. USB Android
                needs port 8099 forwarded.
              </Caption>
              <Input
                label="Fault server URL"
                value={serverUrl}
                onChange={setServerUrl}
              />
            </>
          )}
          <Button
            secondary
            disabled={!!active || !!unavailable}
            onPress={() => start(suite)}
          >
            Run earlier Quick suite · {suite}
          </Button>
        </View>
      )}
      {related.slice(0, 5).map((item) => (
        <Button key={item.id} secondary onPress={() => setSelected(item.id)}>
          {item.name} · {item.verdict} ·{" "}
          {new Date(item.startedAt).toLocaleTimeString()}
        </Button>
      ))}
      {!!report && <StressReportView key={report.id} report={report} />}
    </>
  );
}
export function StressHistory() {
  const snapshot = useSyncExternalStore(
    stress.subscribe,
    stress.getSnapshot,
    stress.getSnapshot,
  );
  const [selected, setSelected] = useState("");
  useEffect(() => {
    void stress.initialize();
  }, []);
  const report = snapshot.reports.find((item) => item.id === selected);
  return (
    <View style={[styles.card, styles.cardBody]}>
      <Disclosure title={`Saved stress tests (${snapshot.reports.length})`}>
        <Choice
          label="Choose a saved test"
          value={selected}
          options={snapshot.reports.map((item) => ({
            value: item.id,
            label: `${item.name} · ${item.verdict} · ${new Date(item.startedAt).toLocaleTimeString()}`,
          }))}
          onChange={setSelected}
        />
        {!!report && <StressReportView key={report.id} report={report} />}
        <Button
          secondary
          disabled={!snapshot.reports.length}
          onPress={() =>
            void exportStressReports(snapshot.reports).catch(
              workshop.reportError.bind(workshop),
            )
          }
        >
          Export saved stress tests
        </Button>
      </Disclosure>
    </View>
  );
}

export function ActiveLoadStatus() {
  const snapshot = useSyncExternalStore(
    stress.subscribe,
    stress.getSnapshot,
    stress.getSnapshot,
  );
  const active = snapshot.active;
  if (!active) return null;
  const manual =
    active.featureId === "feature-load" &&
    featureLoadPlan(active.options).keepRunning;
  return (
    <View style={{ paddingHorizontal: 18, paddingBottom: 10, gap: 6 }}>
      <Text accessibilityLiveRegion="polite" style={styles.caption}>
        {active.options.targetFeatureId
          ? `${features.find((feature) => feature.id === active.options.targetFeatureId)?.title ?? active.options.targetFeatureId} · `
          : ""}
        {active.name} · {Math.round(active.elapsedMs / 1000)} s
      </Text>
      {active.featureId === "production-case" && (
        <View style={styles.row}>
          <Button secondary onPress={() => production.signal("stop-audio")}>
            Stop audio
          </Button>
          {active.scenario?.stage === "recovery" &&
            active.scenario?.userActionRequired && (
              <Button
                secondary
                onPress={() =>
                  production.signal(
                    active.scenario?.observed.canResumeExisting
                      ? "resume"
                      : "new-session",
                  )
                }
              >
                {active.scenario?.observed.canResumeExisting
                  ? "Check Resume · 3 seconds"
                  : "Check new session · 3 seconds"}
              </Button>
            )}
        </View>
      )}
      {manual && (
        <Button secondary onPress={() => stress.finishLive()}>
          Finish live check
        </Button>
      )}
    </View>
  );
}
