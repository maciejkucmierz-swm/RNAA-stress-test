import type { ReactNode } from "react";
import { useState } from "react";
import { Modal, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import {
  GestureHandlerRootView,
  RectButton,
  ScrollView,
} from "react-native-gesture-handler";
import Svg, { Line, Path } from "react-native-svg";

export const colors = {
  background: "#0b1120",
  card: "#141e30",
  line: "#2a3850",
  text: "#eef3fb",
  muted: "#a3b2ca",
  accent: "#73e0bd",
  failed: "#ff9b9b",
};
export function Button({
  children,
  onPress,
  disabled = false,
  secondary = false,
  destructive = false,
}: {
  children: ReactNode;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  destructive?: boolean;
}) {
  return (
    <RectButton
      enabled={!disabled}
      onPress={onPress}
      style={[
        styles.button,
        secondary && styles.secondary,
        destructive && { backgroundColor: "#563139" },
        disabled && { opacity: 0.4 },
      ]}
    >
      <View
        accessible
        accessibilityRole="button"
        accessibilityState={{ disabled }}
      >
        <Text
          style={[
            styles.buttonText,
            (secondary || destructive) && { color: colors.text },
          ]}
        >
          {children}
        </Text>
      </View>
    </RectButton>
  );
}
export function Toggle({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View
      style={[
        styles.row,
        { justifyContent: "space-between", flexWrap: "nowrap" },
      ]}
    >
      <Text style={[styles.text, { flex: 1 }]}>{label}</Text>
      <Switch
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ true: "#23876d" }}
      />
    </View>
  );
}
export function Choice({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: readonly (string | { value: string; label: string })[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const items = options.map((option) =>
    typeof option === "string" ? { value: option, label: option } : option,
  );
  return (
    <View style={{ gap: 5 }}>
      <Text style={styles.label}>{label}</Text>
      <RectButton
        enabled={!disabled}
        onPress={() => setOpen(true)}
        style={[styles.select, disabled && { opacity: 0.4 }]}
      >
        <View
          accessible
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${items.find((item) => item.value === value)?.label ?? (value || "Choose…")}`}
          accessibilityState={{ disabled, expanded: open }}
          style={styles.row}
        >
          <Text style={[styles.text, { flex: 1 }]}>
            {items.find((item) => item.value === value)?.label ??
              (value || "Choose…")}
          </Text>
          <Text style={styles.caption}>⌄</Text>
        </View>
      </RectButton>
      {open && (
        <Modal
          transparent
          animationType="fade"
          onRequestClose={() => setOpen(false)}
        >
          <GestureHandlerRootView style={{ flex: 1 }}>
            <View style={styles.modalBackdrop}>
              <View accessibilityViewIsModal style={styles.modalCard}>
                <Text style={styles.heading}>{label}</Text>
                <ScrollView
                  style={{ flexGrow: 0 }}
                  keyboardShouldPersistTaps="handled"
                >
                  {items.map((item) => (
                    <RectButton
                      key={item.value}
                      onPress={() => {
                        onChange(item.value);
                        setOpen(false);
                      }}
                      style={styles.choiceItem}
                    >
                      <View
                        accessible
                        accessibilityRole="radio"
                        accessibilityLabel={item.label}
                        accessibilityState={{ checked: item.value === value }}
                        style={styles.row}
                      >
                        <Text
                          style={{
                            color:
                              item.value === value
                                ? colors.accent
                                : colors.muted,
                          }}
                        >
                          {item.value === value ? "◉" : "○"}
                        </Text>
                        <Text style={[styles.text, { flex: 1 }]}>
                          {item.label}
                        </Text>
                      </View>
                    </RectButton>
                  ))}
                </ScrollView>
                <Button secondary onPress={() => setOpen(false)}>
                  Close choices
                </Button>
              </View>
            </View>
          </GestureHandlerRootView>
        </Modal>
      )}
    </View>
  );
}
export function Disclosure({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 10 }}>
      <RectButton
        onPress={() => setOpen(!open)}
        style={{ paddingVertical: 12 }}
      >
        <View
          accessible
          accessibilityRole="button"
          accessibilityLabel={title}
          accessibilityState={{ expanded: open }}
          style={styles.row}
        >
          <Text style={[styles.text, { color: colors.accent, flex: 1 }]}>
            {title}
          </Text>
          <Text style={styles.caption}>{open ? "−" : "+"}</Text>
        </View>
      </RectButton>
      {open && children}
    </View>
  );
}
export function Caption({ children }: { children: ReactNode }) {
  return <Text style={styles.caption}>{children}</Text>;
}
export function Input({
  value,
  onChange,
  numeric = false,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  numeric?: boolean;
  label: string;
}) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        keyboardType={numeric ? "numbers-and-punctuation" : "default"}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
        placeholderTextColor={colors.muted}
      />
    </View>
  );
}
export function Plot({
  waveform,
  spectrum,
}: {
  waveform: number[];
  spectrum: number[];
}) {
  const wave = waveform
    .map(
      (value, i) =>
        `${i === 0 ? "M" : "L"}${(i * 320) / Math.max(1, waveform.length - 1)},${50 - Math.max(-1, Math.min(1, value)) * 45}`,
    )
    .join(" ");
  return (
    <View accessibilityLabel="Live waveform and spectrum">
      <Svg width="100%" height={160} viewBox="0 0 320 160">
        <Line x1={0} x2={320} y1={50} y2={50} stroke={colors.line} />
        <Path d={wave} stroke={colors.accent} strokeWidth={1.5} fill="none" />
        {spectrum.map((value, i) => (
          <Line
            key={i}
            x1={i * 5}
            x2={i * 5}
            y1={155}
            y2={155 - Math.max(0, Math.min(1, value)) * 50}
            stroke="#8aa8ff"
            strokeWidth={3}
          />
        ))}
      </Svg>
      <Caption>Waveform · normalized byte spectrum · 10 updates/s</Caption>
    </View>
  );
}
export const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  body: { padding: 18, gap: 14, paddingBottom: 48 },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 14,
    overflow: "hidden",
  },
  cardBody: { padding: 16, gap: 12 },
  heading: { color: colors.text, fontSize: 20, fontWeight: "700" },
  title: { color: colors.text, fontSize: 17, fontWeight: "600" },
  text: { color: colors.text, fontSize: 14, lineHeight: 21 },
  caption: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  secondary: { backgroundColor: "#25334c" },
  buttonText: { color: "#0b2530", fontSize: 13, fontWeight: "700" },
  input: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.line,
    color: colors.text,
    borderRadius: 8,
    padding: 11,
    fontSize: 14,
  },
  select: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    padding: 12,
    minHeight: 46,
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#000b",
  },
  modalCard: {
    maxHeight: "80%",
    backgroundColor: colors.card,
    padding: 20,
    borderRadius: 16,
    gap: 16,
  },
  choiceItem: {
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  label: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 5,
  },
  code: {
    color: "#bfcef0",
    fontFamily: "monospace",
    fontSize: 11,
    lineHeight: 17,
  },
});
