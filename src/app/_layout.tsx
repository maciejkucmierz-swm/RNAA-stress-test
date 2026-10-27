import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import "react-native-worklets";
import { styles } from "../components/ui";
import { workshop } from "../workshop/runtime";

export default function RootLayout() {
  useEffect(() => {
    void workshop.initialize();
    return () => {
      void workshop.stopAll();
    };
  }, []);
  return (
    <GestureHandlerRootView style={styles.page}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{ headerShown: false, contentStyle: styles.page }}
        />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
