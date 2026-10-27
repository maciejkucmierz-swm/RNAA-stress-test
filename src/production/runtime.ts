import { File } from "expo-file-system";
import { Platform } from "react-native";
import * as API from "react-native-audio-api";
import { backend, workshop } from "../workshop/runtime";
import { BlockedError } from "../workshop/types";
import { faultCapabilities, nativeFaults } from "./native";
import { ProductionSupervisor, type ProductionDriver } from "./supervisor";
export const production = new ProductionSupervisor();
export const productionDriver: ProductionDriver = {
  platform: Platform.OS,
  channel: backend.channel,
  capabilities: faultCapabilities,
  beginRun: (id) => nativeFaults?.beginRun(id),
  endRun: async () => {
    await nativeFaults?.endRun();
  },
  pressure: async (profile) => {
    if (!nativeFaults)
      throw new BlockedError("Rebuild to include native pressure support.");
    await nativeFaults.startPressure(
      profile.workers,
      profile.duty,
      profile.memoryMiB,
    );
  },
  stopPressure: async () => {
    await nativeFaults?.stopPressure();
  },
  renewPressure: () => nativeFaults?.renewPressure(),
  stallJavaScript: (ms) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      /* deliberate bounded RN JS stall; native watchdog remains independent */
    }
  },
  nativeSnapshot: () => nativeFaults?.snapshot() ?? null,
  observeFaults: (root, listener) =>
    workshop.observeScenarioFaults(root, listener),
  run: (id, action, settings, scope, emit) =>
    backend.run(id, action, settings, scope, emit),
  idle: () => backend.idle(),
  state: () => backend.scenarioState(),
  applyIntent: (intent) =>
    backend.applyScenarioIntent(intent, intent.recording),
  fileBytes: (paths) =>
    paths.reduce((total, path) => {
      const file = new File(path);
      return total + (file.exists ? file.size : 0);
    }, 0),
  async verifyFiles(paths) {
    let frames = 0,
      seconds = 0,
      bytes = 0;
    for (const path of paths) {
      const file = new File(path);
      if (!file.exists)
        throw new Error("A finalized recording file is missing.");
      bytes += file.size;
      const buffer = await API.decodeAudioData(file.uri);
      if (!buffer.getChannelData(0).every(Number.isFinite))
        throw new Error("Recording contains non-finite samples.");
      frames += buffer.length;
      seconds += buffer.duration;
    }
    return { frames, seconds, bytes };
  },
};
workshop.onStopAll(async () => {
  await nativeFaults?.stopPressure();
});
