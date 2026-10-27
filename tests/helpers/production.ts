import type { TestContext } from "node:test";
import {
  ProductionSupervisor,
  type ProductionDriver,
} from "../../src/production/supervisor";
import { defaultStressOptions } from "../../src/stress/catalog";
import { StressRunner, type StressReport } from "../../src/stress/runner";
import { SessionScope } from "../../src/workshop/session";
export function productionHarness(
  t: TestContext,
  id: string,
  target = "buffer-source",
  level = 1,
  overrides: Partial<ProductionDriver> = {},
  hook?: (controller: ProductionSupervisor, report: StressReport) => void,
) {
  t.mock.timers.enable({ apis: ["Date"] });
  const controller = new ProductionSupervisor();
  let runId = "",
    pressured = false,
    stops = 0;
  let ownedRoot: SessionScope | null = null;
  const driver: ProductionDriver = {
    platform: "android",
    channel: "stable",
    capabilities: () => ({
      available: true,
      pressure: true,
      realServiceReset: false,
      cores: 4,
      platform: "android",
    }),
    beginRun: (id) => {
      runId = id;
    },
    endRun: async () => {
      pressured = false;
    },
    pressure: async () => {
      pressured = true;
    },
    stopPressure: async () => {
      stops++;
      pressured = false;
    },
    renewPressure() {},
    nativeSnapshot: () => ({
      runId,
      at: Date.now(),
      appState: "active",
      pressureActive: pressured,
      guardReason: null,
      residentBytes: 10,
      availableBytes: 1000000000,
      thermal: 0,
      allocatedBytes: pressured ? 16777216 : 0,
      workerBusyMs: pressured ? 1000 : 0,
      workers: pressured ? 1 : 0,
      duty: 0.3,
      cpuTimeMs: 10,
      events: [],
    }),
    stallJavaScript: (ms) => {
      t.mock.timers.tick(ms);
    },
    observeFaults: () => () => {},
    idle: async () => {},
    state: () => ({ gain: 0.1 }),
    applyIntent: async () => {},
    verifyFiles: async () => ({ frames: 48000, seconds: 1, bytes: 96000 }),
    fileBytes: () => 0,
    run: async (_id, _action, _settings, scope, emit) => {
      scope.ensureActive();
      emit("position", 1);
      return { status: "passed", summary: "Accepted" };
    },
    ...overrides,
  };
  const runner = new StressRunner({
    environment: () => ({}),
    load: async () => [],
    save: async () => {},
    exclusive: async (_id, task) => {
      const root = new SessionScope("supervisor");
      ownedRoot = root;
      try {
        await task(root);
      } finally {
        await root.dispose();
        ownedRoot = null;
      }
    },
    execute: async (_id, options, scope, probe) => {
      probe.wait = async (ms) => {
        t.mock.timers.tick(ms);
        hook?.(controller, probe.report);
        scope.ensureActive();
      };
      await controller.run(options, scope, probe, driver);
    },
  });
  return {
    controller,
    runner,
    driver,
    stops: () => stops,
    cancel: () => ownedRoot?.dispose(),
    start: () =>
      runner.start("production-case", {
        ...defaultStressOptions,
        scenarioId: id,
        targetFeatureId: target,
        level,
      }),
  };
}
