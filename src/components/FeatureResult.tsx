import { useState } from "react";
import { Text, View } from "react-native";
import { resultLabels, resultSummary } from "../workshop/presentation";
import { workshop } from "../workshop/runtime";
import { type TestResult } from "../workshop/types";
import {
  Button,
  Caption,
  Choice,
  Disclosure,
  Input,
  colors,
  styles,
} from "./ui";

export function ResultView({ result }: { result: TestResult }) {
  const [notes, setNotes] = useState(result.notes ?? "");
  const [observed, setObserved] = useState(result.manualVerdict ?? "passed");
  const failed = result.assertions?.filter((item) => !item.passed) ?? [];
  return (
    <View
      style={{
        gap: 6,
        borderTopWidth: 1,
        borderColor: colors.line,
        paddingTop: 12,
      }}
    >
      <Text
        style={[
          styles.title,
          { color: result.status === "failed" ? colors.failed : colors.accent },
        ]}
      >
        {resultLabels[result.status]}
      </Text>
      <Caption>
        Last result · {new Date(result.startedAt).toLocaleTimeString()}
      </Caption>
      <Caption>
        Build used for this check:{" "}
        {String(result.environment.buildType ?? "not recorded")}
      </Caption>
      <Text style={styles.text}>{resultSummary(result)}</Text>
      {!!failed.length && (
        <Caption>
          {failed[0].name}
          {failed[0].detail ? `: ${failed[0].detail}` : ""}
        </Caption>
      )}
      {!!result.assertions?.length && (
        <Caption>
          {result.assertions.filter((item) => item.passed).length}/
          {result.assertions.length} automatic checks passed.
        </Caption>
      )}
      {["passed", "failed", "manual"].includes(result.status) && (
        <Disclosure title="Add your observation">
          <Choice
            label="What did you hear or see?"
            value={observed}
            options={[
              { value: "passed", label: "Worked as expected" },
              { value: "failed", label: "I found a problem" },
            ]}
            onChange={(value) => setObserved(value as "passed" | "failed")}
          />
          <Input label="Your notes" value={notes} onChange={setNotes} />
          <Button
            secondary
            onPress={() =>
              void workshop
                .confirm(result.id, observed, notes)
                .catch(workshop.reportError.bind(workshop))
            }
          >
            Save observation
          </Button>
          <Caption>
            Your observation stays separate from automatic checks.
          </Caption>
        </Disclosure>
      )}
      <Disclosure title="Technical details">
        <Caption>
          {result.action} · {String(result.environment.audioApi)} ·{" "}
          {new Date(result.startedAt).toLocaleTimeString()}
        </Caption>
        {result.assertions?.map((item, index) => (
          <Caption key={index}>
            {item.passed ? "✓" : "✕"} {item.name}
            {item.detail ? `: ${item.detail}` : ""}
          </Caption>
        ))}
        <Text selectable style={styles.code}>
          {JSON.stringify(
            {
              settings: result.settings,
              events: result.events.slice(-20),
              droppedEvents: result.droppedEvents,
            },
            null,
            2,
          )}
        </Text>
      </Disclosure>
    </View>
  );
}
