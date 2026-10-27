import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
import type { FaultCapabilities, NativeSnapshot } from "./catalog";
interface FaultModule {
  capabilities(): FaultCapabilities;
  beginRun(runId: string): void;
  startPressure(
    workers: number,
    duty: number,
    memoryMiB: number,
  ): Promise<void>;
  renewPressure(): void;
  stopPressure(): Promise<void>;
  snapshot(): NativeSnapshot;
  endRun(): Promise<void>;
}
export const nativeFaults =
  requireOptionalNativeModule<FaultModule>("ProductionFaults");
export function faultCapabilities(): FaultCapabilities {
  return (
    nativeFaults?.capabilities() ?? {
      available: false,
      pressure: false,
      cores: 1,
      realServiceReset: false,
      platform: Platform.OS,
      reason:
        "Rebuild this test app to include the ProductionFaults local native module.",
    }
  );
}
