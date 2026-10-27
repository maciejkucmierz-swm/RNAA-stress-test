import { useMemo, useRef, useState } from "react";
import { Platform, Text, View } from "react-native";
import { ScrollView } from "react-native-gesture-handler";
import { features } from "../workshop/registry";
import { availability, type Category, type Feature } from "../workshop/types";
import { FeatureCard } from "./FeatureCard";
import { StressHistory } from "./FeatureStressControl";
import { HistoryPanel, Recordings } from "./SavedData";
import { Caption, Disclosure, styles } from "./ui";
export function CategoryScreen({ category }: { category: Category }) {
  const [opened, setOpened] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null),
    reveal = useRef<string | null>(null);
  const items = useMemo(
    () => features.filter((feature) => feature.category === category),
    [category],
  );
  const available = items.filter(
    (feature) => !availability(feature, Platform.OS),
  );
  const unavailable = items.filter(
    (feature) => !!availability(feature, Platform.OS),
  );
  const card = (feature: Feature) => (
    <View
      key={feature.id}
      onLayout={(event) => {
        if (reveal.current === feature.id) {
          reveal.current = null;
          scroll.current?.scrollTo({
            y: Math.max(0, event.nativeEvent.layout.y - 8),
            animated: true,
          });
        }
      }}
    >
      <FeatureCard
        feature={feature}
        open={opened === feature.id}
        onToggle={() => {
          reveal.current = opened === feature.id ? null : feature.id;
          setOpened(opened === feature.id ? null : feature.id);
        }}
      />
    </View>
  );
  return (
    <ScrollView
      ref={scroll}
      style={styles.page}
      contentContainerStyle={styles.body}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.heading}>{category}</Text>
      <Caption>Open a feature to play, record, or test it.</Caption>
      {available.map(card)}
      {!!unavailable.length && (
        <Disclosure title={`Unavailable features (${unavailable.length})`}>
          {unavailable.map(card)}
        </Disclosure>
      )}
      {(category === "Recording" || category === "Core") && <Recordings />}
      {category === "System" && (
        <>
          <HistoryPanel />
          <StressHistory />
        </>
      )}
    </ScrollView>
  );
}
