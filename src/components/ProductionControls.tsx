import { useEffect, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { applicableScenarios, type ScenarioId } from "../production/catalog";
import {
  environmentProfile,
  environments,
  type EnvironmentId,
} from "../production/environment";
import { manualChecks } from "../production/manual";
import { faultCapabilities } from "../production/native";
import { production } from "../production/runtime";
import { defaultStressOptions } from "../stress/catalog";
import { stress } from "../stress/runtime";
import { workshop } from "../workshop/runtime";
import { companionFor } from "../workshop/registry";
import type { Feature, Settings } from "../workshop/types";
import { StressReportView } from "./StressReportView";
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
export function ProductionControls({
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
  const choices = applicableScenarios(feature);
  const [selected, setSelected] = useState<ScenarioId>(
    choices[0]?.id ?? "stop-pending",
  );
  const [level, setLevel] = useState(1),
    [longRun, setLongRun] = useState(false);
  const [environment, setEnvironment] = useState<EnvironmentId>("level");
  const [operator, setOperator] = useState<"manual" | "argent">("manual");
  const [seed, setSeed] = useState(String(defaultStressOptions.seed));
  const [companion, setCompanion] = useState<"playback" | "recording">(
    companionFor(feature),
  );
  useEffect(() => {
    void stress.initialize();
  }, []);
  if (!choices.length)
    return (
      <Caption>Use the normal diagnostic controls for this feature.</Caption>
    );
  const definition = choices.find((item) => item.id === selected)!;
  const active = snapshot.active,
    owns =
      active?.featureId === "production-case" &&
      active.options.targetFeatureId === feature.id;
  const report = snapshot.reports.find(
    (item) =>
      item.featureId === "production-case" &&
      item.options.targetFeatureId === feature.id,
  );
  const caps = faultCapabilities(),
    pressure = environmentProfile(level, caps.cores, environment);
  const guide = manualChecks[feature.id];
  const blocked =
    unavailable ||
    (selected === "service-reset" && !caps.realServiceReset
      ? "This device cannot perform a real audio-service reset. Use a physical iPhone with Developer Settings or a dedicated rooted Android target."
      : pressure.workers > 0 && !caps.pressure
        ? (caps.reason ?? "Native pressure requires a new app build.")
        : selected === "notification-stop" && caps.platform !== "android"
          ? "Recording notification Stop requires Android."
          : selected === "combined" && !pressure.workers
            ? "Choose a native-load environment or level 6–10 for combined failure."
            : undefined);
  return (
    <View style={{ gap: 12 }}>
      <Caption>
        Unmodified RNAA. Documented client handlers; no automatic retries or
        engine rebuilds.
      </Caption>
      <Choice
        label="What should go wrong?"
        value={selected}
        disabled={!!active}
        options={choices.map((item) => ({ value: item.id, label: item.name }))}
        onChange={(value) => {
          setSelected(value as ScenarioId);
          setLongRun(false);
          if (["pressure", "combined"].includes(value) && level < 6)
            setLevel(6);
        }}
      />
      <Choice
        label="Test level"
        value={String(level)}
        disabled={!!active}
        options={Array.from({ length: 10 }, (_, index) => ({
          value: String(index + 1),
          label: `${index + 1} — ${index < 5 ? "light" : index < 8 ? "heavy phone load" : "heavy load + app freeze"}`,
        }))}
        onChange={(value) => setLevel(Number(value))}
      />
      <Choice
        label="Phone environment"
        value={environment}
        disabled={!!active}
        options={environments.map((item) => ({
          value: item.id,
          label: item.name,
        }))}
        onChange={(value) => setEnvironment(value as EnvironmentId)}
      />
      <Caption>
        {environments.find((item) => item.id === environment)?.explanation}
      </Caption>
      {(level > 5 || environment !== "level") && (
        <Text style={[styles.text, { color: colors.failed }]}>
          Stress settings selected. Expect pauses or a slower phone. Native load
          stops on expiry or critical thermal state.
        </Text>
      )}
      <Text style={styles.text}>
        {definition.automatic ? definition.story : definition.action}
      </Text>
      <Caption>
        {definition.automatic
          ? "The app triggers this test."
          : "You trigger the phone actions; the app records what happens."}{" "}
        Quick check: about 2–5 minutes.
      </Caption>
      {!!blocked && (
        <Text style={[styles.text, { color: colors.failed }]}>{blocked}</Text>
      )}
      {!owns && (
        <Button
          disabled={!!active || !!blocked}
          onPress={() =>
            void stress
              .start("production-case", {
                ...defaultStressOptions,
                seed: Number(seed),
                operator,
                targetFeatureId: feature.id,
                targetSettings: settings,
                scenarioId: selected,
                level,
                companion,
                environmentProfile: environment,
                scenarioDuration: longRun ? "thermal-15" : "quick",
              })
              .catch((error) => workshop.reportError(error))
          }
        >
          Start check
        </Button>
      )}
      {!!owns && (
        <>
          <Text accessibilityLiveRegion="polite" style={styles.title}>
            {
              {
                baseline: "Getting ready",
                disruption: "Disruption in progress",
                recovery: "Checking recovery",
                verification: "Checking the result",
              }[active.scenario?.stage ?? "baseline"]
            }
          </Text>
          <Caption>
            Round {active.scenario?.round ?? 1}. Stop audio ends the sound
            session; Stop all ends the whole test. Recovery controls appear
            after pressure ends.
          </Caption>
          {!definition.automatic && active.scenario?.stage === "disruption" && (
            <Button onPress={() => production.signal("end-disruption")}>
              I’m back — check recovery
            </Button>
          )}
          {selected === "pressure" && (
            <Button secondary onPress={() => production.signal("finish")}>
              End pressure observation
            </Button>
          )}
          {selected === "volume" && (
            <>
              <Choice
                label="App volume"
                value={String(active.scenario?.desired.gain ?? 0.1)}
                options={[
                  { value: "0.05", label: "5%" },
                  { value: "0.1", label: "10%" },
                ]}
                onChange={(value) => production.signal("gain", Number(value))}
              />
              <Toggle
                label="Mute"
                value={active.scenario?.desired.muted ?? false}
                onChange={(value) => production.signal("mute", value)}
              />
            </>
          )}
        </>
      )}
      <Disclosure title="Test settings and instructions">
        {!!guide && (
          <>
            <Caption>
              Manual priority {guide.rank}: {guide.steps}
            </Caption>
            <Caption>Check: {guide.expected}</Caption>
          </>
        )}
        <Caption>
          Recovery playback is a short verification check (about 3 seconds),
          then stops. Use the normal Play button afterward for continuous
          playback.
        </Caption>
        <Caption>Expected: {definition.expected}</Caption>
        <Caption>{definition.action}</Caption>
        <Caption>
          {pressure.rounds} round(s). Requested: {pressure.workers} native
          worker(s), {Math.round(pressure.duty * 100)}% duty, up to{" "}
          {pressure.memoryMiB} MiB RAM; {pressure.jsStallMs} ms JavaScript pause
          every 10 seconds; app command delay up to {pressure.commandLatencyMs}{" "}
          ms. The report records achieved load. Native pressure expires after
          180 seconds without renewal and RAM is capped at 10% of available
          memory.
        </Caption>
        <Caption>
          Heat and low-end hardware are physical-device checks. CPU contention
          and memory allocation approximate pressure; they do not emulate a
          specific phone, actual thermal throttling, audio-driver latency, or
          network latency. Simulator results cannot qualify these conditions.
        </Caption>
        {feature.workload.companion === "select" && (
          <Choice
            label="Audio running during the test"
            value={companion}
            options={[
              { value: "playback", label: "Looping playback" },
              { value: "recording", label: "Live recording" },
            ]}
            disabled={!!active}
            onChange={(value) =>
              setCompanion(value as "playback" | "recording")
            }
          />
        )}
        {selected === "pressure" && (
          <Toggle
            label="Run for 15 minutes instead"
            disabled={!!active}
            value={longRun}
            onChange={setLongRun}
          />
        )}
        <Input
          label="Repeatable test seed"
          value={seed}
          onChange={setSeed}
          numeric
        />
        <Choice
          label="Who starts the test?"
          value={operator}
          options={[
            { value: "manual", label: "A person" },
            { value: "argent", label: "Argent" },
          ]}
          disabled={!!active}
          onChange={(value) => setOperator(value as "manual" | "argent")}
        />
        {selected === "interruption" && (
          <Caption>
            Android focus helper: npm run production:interrupter -- --device
            SERIAL --mode transient --rounds 5. See Optional test tools in the
            root README.md.
          </Caption>
        )}
        {selected === "service-reset" && (
          <Caption>
            Android host preflight: npm run production:reset -- --device SERIAL
            --preflight. A simulated context shutdown is not a real service
            reset.
          </Caption>
        )}
      </Disclosure>
      {!!report && !owns && (
        <StressReportView key={report.id} report={report} />
      )}
    </View>
  );
}
