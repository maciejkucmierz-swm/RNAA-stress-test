import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module";

test("tab presses navigate without treating RNGH payloads as synthetic events", () => {
  const calls: unknown[][] = [];
  let trigger: { isFocused: boolean } | undefined = { isFocused: false };
  const jsx = (type: unknown, props: unknown) => ({ type, props });
  const dependencies: Record<string, unknown> = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { View: "View", Text: "Text" },
    "react-native-gesture-handler": { RectButton: "RectButton" },
    "expo-router/ui": {
      useTabTrigger: () => ({
        trigger,
        switchTab: (...args: unknown[]) => calls.push(args),
      }),
    },
    "./ui": { colors: {} },
  };
  const module = {
    exports: loadModule("src/components/TabButton.tsx", dependencies) as {
      TabButton: (props: { name: string; children: string }) => {
        props: {
          enabled: boolean;
          onPress: (payload?: unknown) => void;
          children: { props: { accessibilityState: { selected: boolean } } };
        };
      };
    },
  };

  const button = () =>
    module.exports.TabButton({ name: "playback", children: "Playback" });
  // Actual RNGH payloads have nativeEvent but no isDefaultPrevented method.
  button().props.onPress({ nativeEvent: { locationX: 12, locationY: 4 } });
  assert.deepEqual(calls, [["playback", {}]]);
  trigger = { isFocused: true };
  const focused = button();
  assert.equal(focused.props.children.props.accessibilityState.selected, true);
  focused.props.onPress();
  assert.equal(
    calls.length,
    1,
    "pressing the selected tab should not reset it",
  );
  trigger = undefined;
  const missing = button();
  assert.equal(missing.props.enabled, false);
  missing.props.onPress();
  assert.equal(calls.length, 1, "unregistered tabs should not navigate");
});
