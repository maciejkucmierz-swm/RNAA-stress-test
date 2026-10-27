import Constants from "expo-constants";
import * as Device from "expo-device";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { AppState, Platform } from "react-native";
import fixtureManifest from "../../assets/audio/manifest.json";
import { production, productionDriver } from "../production/runtime";
import { historyEnvelope, jsonFile } from "../storage/json-file";
import { backend, build, workshop } from "../workshop/runtime";
import { BlockedError } from "../workshop/types";
import { reportEncoder } from "./history";
import { runFeatureLoad } from "./feature-load";
import { StressRunner, type StressReport } from "./runner";

const historyFile = new File(Paths.document, "audio-stress-history-v1.json");
const storage = jsonFile(historyFile, (value) =>
  historyEnvelope(value, "reports"),
);
const encodeReports = reportEncoder();
export const stress = new StressRunner({
  environment: () => ({
    ...build,
    expo: "57.0.30",
    reactNative: Platform.constants.reactNativeVersion,
    worklets: build.worklets,
    platform: Platform.OS,
    osVersion: Platform.Version,
    model: Device.modelName,
    physicalDevice: Device.isDevice,
    buildType: __DEV__ ? "development" : "release",
    appVersion: Constants.expoConfig?.version,
    patches: [],
    clientBaseline: "published-rnaa-client-v1",
    fixtures: fixtureManifest,
    context: backend.snapshot.context,
  }),
  exclusive: (id, task) => workshop.exclusiveStress(id, task),
  execute: (id, options, scope, probe) => {
    if (id === "production-case") {
      if (["devices", "volume"].includes(options.targetFeatureId ?? ""))
        workshop.enableObservationHooks();
      return production.run(options, scope, probe, productionDriver);
    }
    if (id !== "feature-load")
      return backend.runStress(id, options, scope, probe);
    if (["devices", "volume"].includes(options.targetFeatureId ?? ""))
      workshop.enableObservationHooks();
    return runFeatureLoad(options, scope, probe, {
      channel: backend.channel,
      platform: Platform.OS,
      run: (feature, action, settings, session, emit) =>
        backend.run(feature, action, settings, session, emit),
      idle: () => backend.idle(),
      fileBytes: () =>
        backend.snapshot.recordings.reduce(
          (sum, item) => sum + item.size * 1e6,
          0,
        ),
    });
  },
  async load() {
    const text = await storage.read();
    if (!text) return [];
    const value = JSON.parse(text);
    if (value.formatVersion !== 1 || !Array.isArray(value.reports))
      throw new Error("Unsupported stress report format.");
    return value.reports;
  },
  async save(reports) {
    storage.write(encodeReports(reports));
  },
});
workshop.onStopAll(stress.cancelPending);
export function observeStressAppState() {
  const subscriptions = [
    AppState.addEventListener("change", (state) => {
      stress.observe("appState", state);
      production.observe("appState", state);
    }),
    ...(Platform.OS === "android"
      ? ["blur", "focus"].map((event) =>
          AppState.addEventListener(event as "blur" | "focus", () =>
            stress.observe("appFocus", event),
          ),
        )
      : []),
  ];
  return () => subscriptions.forEach((subscription) => subscription.remove());
}
export async function exportStressReports(reports: StressReport[]) {
  if (!(await Sharing.isAvailableAsync()))
    throw new BlockedError("System sharing is unavailable.");
  const file = new File(Paths.cache, `rnaa-stress-${Date.now()}.json`);
  file.create();
  file.write(
    JSON.stringify(
      { formatVersion: 1, exportedAt: new Date().toISOString(), reports },
      null,
      2,
    ),
  );
  try {
    await Sharing.shareAsync(file.uri, {
      mimeType: "application/json",
      UTI: "public.json",
      dialogTitle: "Export stress reports",
    });
  } finally {
    if (file.exists) file.delete();
  }
}
