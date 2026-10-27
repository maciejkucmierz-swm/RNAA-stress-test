import { TabList, TabSlot, TabTrigger, Tabs } from "expo-router/ui";
import { useEffect } from "react";
import { Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ActiveLoadStatus } from "../../components/FeatureStressControl";
import { MediaHost } from "../../components/MediaHost";
import { TabButton } from "../../components/TabButton";
import {
  Button,
  Caption,
  Disclosure,
  colors,
  styles,
} from "../../components/ui";
import { observeStressAppState } from "../../stress/runtime";
import { useWorkshop } from "../../workshop/hooks";
import { features } from "../../workshop/registry";
import { build, workshop } from "../../workshop/runtime";
import { categories } from "../../workshop/types";

export default function WorkshopLayout() {
  const snapshot = useWorkshop();
  useEffect(observeStressAppState, []);
  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.page}>
      <View style={{ padding: 18, gap: 8 }}>
        <View style={[styles.row, { justifyContent: "space-between" }]}>
          <View>
            <Text style={[styles.heading, { fontSize: 22 }]}>
              Audio API Lab
            </Text>
            <Caption>
              {build.channel} · {build.audioApi} ·{" "}
              {__DEV__ ? "DEBUG" : "RELEASE"}
            </Caption>
          </View>
          <Button destructive onPress={() => void workshop.stopAll()}>
            Stop all
          </Button>
        </View>
        <Caption>
          {snapshot.activeId
            ? `Running: ${features.find((feature) => feature.id === snapshot.activeId)?.title ?? (snapshot.activeId.startsWith("stress-") ? "audio test" : "recorded audio")}`
            : "No audio running"}
        </Caption>
        {!!snapshot.error && (
          <Disclosure title="Last error">
            <Text selectable style={[styles.caption, { color: colors.failed }]}>
              {snapshot.error}
            </Text>
          </Disclosure>
        )}
      </View>
      <ActiveLoadStatus />
      <MediaHost
        key={snapshot.backend.media?.key ?? "idle"}
        request={snapshot.backend.media}
      />
      <Tabs style={{ flex: 1 }}>
        <TabList style={{ display: "none" }}>
          {categories.map((category) => (
            <TabTrigger
              key={category}
              name={category.toLowerCase()}
              href={category === "Core" ? "/" : `/${category.toLowerCase()}`}
            />
          ))}
        </TabList>
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            paddingHorizontal: 18,
            gap: 6,
            paddingBottom: 10,
          }}
        >
          {categories.map((category) => (
            <TabButton key={category} name={category.toLowerCase()}>
              {category}
            </TabButton>
          ))}
        </View>
        <TabSlot />
      </Tabs>
    </SafeAreaView>
  );
}
