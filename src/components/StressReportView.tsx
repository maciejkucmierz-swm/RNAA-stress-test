import { memo, useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { StressReport } from "../stress/runner";
import { exportStressReports, stress } from "../stress/runtime";
import { workshop } from "../workshop/runtime";
import {
  Button,
  Caption,
  Choice,
  Disclosure,
  Input,
  colors,
  styles,
} from "./ui";

export const BusyUI = memo(function BusyUI({ active }: { active: boolean }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    let handle: number;
    const update = () => {
      setFrame((value) => value + 1);
      handle = requestAnimationFrame(update);
    };
    handle = requestAnimationFrame(update);
    return () => cancelAnimationFrame(handle);
  }, [active]);
  if (!active) return null;
  return (
    <View accessibilityLabel="Controlled busy UI workload" style={styles.row}>
      {Array.from({ length: 40 }, (_, index) => (
        <Text
          key={index}
          style={[
            styles.code,
            { color: (frame + index) % 2 ? colors.accent : colors.muted },
          ]}
        >
          {(frame + index) % 100}
        </Text>
      ))}
    </View>
  );
});

export function StressReportView({ report }: { report: StressReport }) {
  const [notes, setNotes] = useState(report.operatorNotes);
  const [effort, setEffort] = useState(
    report.humanEffortSeconds === null ? "" : String(report.humanEffortSeconds),
  );
  const effortSeconds =
    effort.trim() && Number.isFinite(Number(effort)) && Number(effort) >= 0
      ? Number(effort)
      : null;
  const labels = {
    running: "Test running",
    passed: "Passed",
    failed: "Failed",
    blocked: "Could not run",
    inconclusive: "Not fully verified",
  };
  const problems = report.checks.filter((check) => check.status === "failed");
  const missing = report.checks.filter(
    (check) => check.status === "unverified",
  );
  const pending = report.manual.filter(
    (check) => check.verdict === "pending",
  ).length;
  return (
    <View style={[styles.card, styles.cardBody]}>
      <Text style={styles.title}>{labels[report.verdict]}</Text>
      <Caption>
        {report.name} · {Math.round(report.elapsedMs / 1000)} seconds
      </Caption>
      <Caption>
        Build used for this test:{" "}
        {String(report.environment.buildType ?? "not recorded")}
      </Caption>
      <Caption>
        {report.environment.clientBaseline === "published-rnaa-client-v1"
          ? "Published RNAA · no patches or automatic rebuilds"
          : "Historical setup — not the unmodified client baseline"}
      </Caption>
      {!!problems.length && (
        <Text style={[styles.text, { color: colors.failed }]}>
          {problems[0].name}: {problems[0].detail}
        </Text>
      )}
      {report.phase !== "Finished" && report.verdict !== "running" && (
        <Text style={styles.text}>{report.phase}</Text>
      )}
      {!!report.scenario && (
        <Caption>
          Disruptions verified: {report.scenario.verifiedFaults} of{" "}
          {report.scenario.requestedFaults}.
        </Caption>
      )}
      {!!missing.length && (
        <Caption>
          {missing.length} checks still need evidence. {missing[0].name}.
        </Caption>
      )}
      {!!pending && (
        <Caption>
          {pending} listening or phone checks still need your review.
        </Caption>
      )}
      {!!report.manual.length && (
        <Disclosure title="Listening and phone checks">
          {report.manual.map((check, index) => (
            <View key={index} style={{ gap: 8 }}>
              <Text style={styles.text}>{check.instruction}</Text>
              <Choice
                label={`Observation ${index + 1}`}
                disabled={report.verdict === "running"}
                value={check.verdict}
                options={[
                  { value: "pending", label: "Not checked" },
                  { value: "passed", label: "Worked as expected" },
                  { value: "failed", label: "I found a problem" },
                ]}
                onChange={(value) => {
                  if (value !== "pending")
                    void stress
                      .review(
                        report.id,
                        index,
                        value as "passed" | "failed",
                        notes,
                        effortSeconds,
                      )
                      .catch(workshop.reportError.bind(workshop));
                }}
              />
            </View>
          ))}
          <Input label="Your notes" value={notes} onChange={setNotes} />
          <Input
            label="Time you spent checking (seconds)"
            value={effort}
            onChange={setEffort}
            numeric
          />
          <Button
            secondary
            onPress={() =>
              void stress
                .note(report.id, notes, effortSeconds)
                .catch(workshop.reportError.bind(workshop))
            }
          >
            Save notes
          </Button>
        </Disclosure>
      )}
      <Disclosure title="Test evidence and technical details">
        <Caption>
          {report.phase} · seed {report.options.seed} · {report.options.profile}
        </Caption>
        <Caption>
          Operations: {report.counters.completed} completed,{" "}
          {report.counters.cancelled} cancelled, {report.counters.failed}{" "}
          failed.
        </Caption>
        <Caption>{report.usage}</Caption>
        <Caption>{report.method}</Caption>
        {!!report.scenario && (
          <>
            <Caption>Fault source: {report.scenario.source}</Caption>
            {report.scenario.timeline.map((step, index) => (
              <Caption key={index}>
                {step.at.slice(11, 19)} · {step.stage}: {step.detail}
              </Caption>
            ))}
            {report.scenario.recovery.map((item, index) => (
              <Caption key={index}>
                Round {item.round}:{" "}
                {item.kind
                  ? {
                      "original-session": "original session",
                      "documented-client-handler": "documented client handler",
                      "existing-session-resume": "Resume on existing session",
                      "separate-new-session": "separate new session",
                    }[item.kind]
                  : item.assisted
                    ? "historical app-assisted repair"
                    : "historical original recovery"}{" "}
                · {item.elapsedMs} ms · output progress{" "}
                {item.observed ? "observed" : "unverified"}
              </Caption>
            ))}
            <Caption>
              Native samples: {report.scenario.nativeSamples.length}. Recovery
              does not erase an earlier failure.
            </Caption>
            {!!report.scenario.contract && (
              <Caption>
                Selected feature: {report.scenario.contract.featureId} · actual
                workload: {report.scenario.contract.workloadFeatureId}
              </Caption>
            )}
          </>
        )}
        {report.checks.map((check, index) => (
          <Caption key={index}>
            {check.status === "passed"
              ? "✓"
              : check.status === "failed"
                ? "✕"
                : "?"}{" "}
            {check.name}: {check.detail}
          </Caption>
        ))}
        <Disclosure title="Measurements and raw logs">
          {Object.entries(report.metrics).map(([name, value]) => (
            <Caption key={name}>
              {name}: {String(value)}
            </Caption>
          ))}
          <Text selectable style={styles.code}>
            {JSON.stringify(
              {
                originalResponse: report.scenario?.observed.originalResponse,
                clientActions: report.scenario?.clientActions,
                phoneEvents: report.scenario?.faultEvents,
                events: report.events.slice(-20),
                route: report.scenario?.nativeSamples.at(-1)?.route,
              },
              null,
              2,
            )}
          </Text>
        </Disclosure>
        <Button
          secondary
          onPress={() =>
            void exportStressReports([report]).catch(
              workshop.reportError.bind(workshop),
            )
          }
        >
          Export full result
        </Button>
      </Disclosure>
    </View>
  );
}
