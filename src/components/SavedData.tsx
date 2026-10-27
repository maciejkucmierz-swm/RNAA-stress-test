import { useState } from "react";
import { Text, View } from "react-native";
import { useWorkshopData } from "../workshop/hooks";
import { resultLabels } from "../workshop/presentation";
import { features } from "../workshop/registry";
import { workshop } from "../workshop/runtime";
import { ResultView } from "./FeatureResult";
import { Button, Caption, Choice, Disclosure, styles } from "./ui";
export function Recordings() {
  const snapshot = useWorkshopData();
  return (
    <Disclosure
      title={`Saved recordings (${snapshot.backend.recordings.length})`}
    >
      {!snapshot.backend.recordings.length && (
        <Caption>Stop a recording to save it here.</Caption>
      )}
      {snapshot.backend.recordings.map((recording, i) => (
        <View key={`${recording.paths[0]}-${i}`} style={{ gap: 8 }}>
          <Caption>
            Recording {i + 1} · {recording.duration.toFixed(1)} seconds ·{" "}
            {recording.size.toFixed(1)} MB
          </Caption>
          {recording.paths.map((path, index) => (
            <Button
              key={path}
              secondary
              onPress={() =>
                void workshop
                  .playRecording(path)
                  .catch(workshop.reportError.bind(workshop))
              }
            >
              {recording.paths.length > 1
                ? `Play part ${index + 1}`
                : "Play recording"}
            </Button>
          ))}
          <Disclosure title={`File options for recording ${i + 1}`}>
            <Text selectable style={styles.code}>
              {recording.paths.map((path) => path.split("/").pop()).join("\n")}
            </Text>
            <Button
              destructive
              onPress={() =>
                void workshop
                  .deleteRecording(recording.paths)
                  .catch(workshop.reportError.bind(workshop))
              }
            >
              Delete recording {i + 1}
            </Button>
          </Disclosure>
        </View>
      ))}
    </Disclosure>
  );
}
export function HistoryPanel() {
  const snapshot = useWorkshopData();
  const [selected, setSelected] = useState("");
  const result = snapshot.results.find((item) => item.id === selected);
  return (
    <View style={[styles.card, styles.cardBody]}>
      <Disclosure title={`Saved checks (${snapshot.results.length})`}>
        <Choice
          label="Choose a result"
          value={selected}
          options={snapshot.results.map((item) => ({
            value: item.id,
            label: `${features.find((f) => f.id === item.featureId)?.title ?? item.featureId} · ${resultLabels[item.status]} · ${new Date(item.startedAt).toLocaleTimeString()}`,
          }))}
          onChange={setSelected}
        />
        {!!result && <ResultView key={result.id} result={result} />}
        <Button
          secondary
          disabled={!snapshot.results.length}
          onPress={() =>
            void workshop.export().catch(workshop.reportError.bind(workshop))
          }
        >
          Export saved checks
        </Button>
        <Disclosure title="Manage saved checks">
          <Button
            secondary
            disabled={!selected}
            onPress={() =>
              void workshop
                .export([selected])
                .catch(workshop.reportError.bind(workshop))
            }
          >
            Export selected check
          </Button>
          <Button
            destructive
            onPress={() => {
              setSelected("");
              void workshop
                .clearHistory()
                .catch(workshop.reportError.bind(workshop));
            }}
          >
            Clear saved checks
          </Button>
        </Disclosure>
      </Disclosure>
    </View>
  );
}
