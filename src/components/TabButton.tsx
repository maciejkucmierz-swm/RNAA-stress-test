import { useTabTrigger } from "expo-router/ui";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { RectButton } from "react-native-gesture-handler";
import { colors } from "./ui";

export function TabButton({
  name,
  children,
}: {
  name: string;
  children: ReactNode;
}) {
  const { trigger, switchTab } = useTabTrigger({ name });
  const selected = trigger?.isFocused ?? false;
  return (
    <RectButton
      enabled={!!trigger}
      onPress={() => {
        // RNGH events are not React synthetic events. Use the router's direct API.
        if (trigger && !selected) switchTab(name, {});
      }}
      style={{
        width: "31%",
        alignItems: "center",
        paddingHorizontal: 8,
        paddingVertical: 10,
        backgroundColor: selected ? colors.accent : colors.card,
        borderRadius: 9,
      }}
    >
      <View
        accessible
        accessibilityRole="tab"
        accessibilityState={{ selected, disabled: !trigger }}
      >
        <Text
          style={{
            fontSize: 13,
            fontWeight: "700",
            color: selected ? colors.background : colors.muted,
          }}
        >
          {children}
        </Text>
      </View>
    </RectButton>
  );
}
