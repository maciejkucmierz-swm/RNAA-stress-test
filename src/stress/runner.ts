import type { ScenarioEvidence } from "../production/catalog";
import { redact } from "../workshop/history";
import type { SessionScope } from "../workshop/session";
import { BlockedError, CancelledError, formatError } from "../workshop/types";
import {
  stressFeature,
  stressLimits,
  type StressId,
  type StressOptions,
} from "./catalog";
import { featureLoadPlan } from "./feature-load";

export type StressVerdict =
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "inconclusive";
export interface StressCheck {
  name: string;
  status: "passed" | "failed" | "unverified";
  detail: string;
}
export interface StressReport {
  id: string;
  featureId: StressId;
  name: string;
  explanation: string;
  usage: string;
  previousFunctionalResult: string;
  options: StressOptions;
  limits: ReturnType<typeof stressLimits>;
  environment: Record<string, unknown>;
  startedAt: string;
  finishedAt?: string;
  completionReason?:
    | "completed"
    | "cancelled"
    | "limit"
    | "blocked"
    | "error"
    | "process-ended";
  elapsedMs: number;
  heartbeatAt: string;
  phase: string;
  verdict: StressVerdict;
  counters: {
    requested: number;
    completed: number;
    cancelled: number;
    failed: number;
  };
  metrics: Record<string, number | string | boolean | null>;
  checks: StressCheck[];
  events: { at: string; name: string; detail: unknown }[];
  droppedEvents: number;
  manual: {
    instruction: string;
    verdict: "pending" | "passed" | "failed";
    notes: string;
  }[];
  scenario?: ScenarioEvidence;
  method: string;
  operatorNotes: string;
  humanEffortSeconds: number | null;
  nextAction: string;
}
export function randomForSeed(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
export class StressBudgetError extends Error {}
export function reportVerdict(report: StressReport): StressVerdict {
  if (
    report.counters.failed ||
    report.checks.some((check) => check.status === "failed") ||
    report.manual.some((check) => check.verdict === "failed")
  )
    return "failed";
  if (
    report.counters.requested !==
    report.counters.completed + report.counters.cancelled
  )
    return "inconclusive";
  if (
    !report.checks.length ||
    report.checks.some((check) => check.status === "unverified") ||
    report.manual.some((check) => check.verdict === "pending")
  )
    return "inconclusive";
  return "passed";
}

export class StressProbe {
  readonly random: () => number;
  private started = Date.now();
  private samples: number[] = [];
  private lastChange = 0;
  constructor(
    readonly report: StressReport,
    readonly scope: SessionScope,
    private changed: () => void,
  ) {
    this.random = randomForSeed(report.options.seed);
  }
  tick(phase?: string) {
    this.scope.ensureActive();
    this.report.elapsedMs = Date.now() - this.started;
    this.report.heartbeatAt = new Date().toISOString();
    if (phase) this.report.phase = phase;
    if (this.report.elapsedMs >= this.report.limits.runtimeMs)
      throw new StressBudgetError(
        "Runtime ceiling reached before the workload completed.",
      );
    if (Date.now() - this.lastChange >= 500 || phase) {
      this.lastChange = Date.now();
      this.changed();
    }
  }
  async wait(ms: number) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      this.tick();
      await this.scope.wait(Math.min(250, deadline - Date.now()));
    }
    this.tick();
  }
  async operation<T>(
    name: string,
    action: () => Promise<T> | T,
    expectedCancellation = false,
  ): Promise<T | undefined> {
    this.tick();
    const sequence = ++this.report.counters.requested,
      start = Date.now();
    try {
      const result = await action();
      this.scope.ensureActive();
      this.report.counters.completed++;
      this.samples.push(Date.now() - start);
      if (this.samples.length > 2048) this.samples.shift();
      if (Date.now() - start > 1000)
        this.event("slowAcknowledgement", {
          sequence,
          name,
          ms: Date.now() - start,
        });
      return result;
    } catch (error) {
      if (
        error instanceof CancelledError ||
        (expectedCancellation && error instanceof BlockedError)
      )
        this.report.counters.cancelled++;
      else this.report.counters.failed++;
      this.event("operationError", {
        sequence,
        name,
        error: formatError(error),
        expectedCancellation,
      });
      if (
        !(
          expectedCancellation &&
          (error instanceof CancelledError || error instanceof BlockedError)
        )
      )
        throw error;
    } finally {
      if (Date.now() - this.lastChange >= 500) {
        this.lastChange = Date.now();
        this.changed();
      }
    }
  }
  check(name: string, passed: boolean, detail: string) {
    this.report.checks.push({
      name,
      status: passed ? "passed" : "failed",
      detail,
    });
    this.changed();
  }
  unverified(name: string, detail: string) {
    this.report.checks.push({ name, status: "unverified", detail });
  }
  metric(name: string, value: number | string | boolean | null) {
    this.report.metrics[name] = value;
  }
  event(name: string, detail?: unknown) {
    if (this.report.events.length === 200) {
      this.report.events.shift();
      this.report.droppedEvents++;
    }
    this.report.events.push({ at: new Date().toISOString(), name, detail });
  }
  finish() {
    const sorted = [...this.samples].sort((a, b) => a - b);
    for (const [name, percentile] of [
      ["p50", 0.5],
      ["p95", 0.95],
      ["p99", 0.99],
      ["max", 1],
    ] as const) {
      this.metric(
        `operationAcknowledgementMs.${name}`,
        sorted.length
          ? sorted[
              Math.min(
                sorted.length - 1,
                Math.ceil(sorted.length * percentile) - 1,
              )
            ]
          : null,
      );
    }
    this.metric("acknowledgementSampleWindow", sorted.length);
    this.report.elapsedMs = Date.now() - this.started;
  }
}

export interface StressDependencies {
  environment(): Record<string, unknown>;
  exclusive(
    id: string,
    task: (scope: SessionScope) => Promise<void>,
  ): Promise<void>;
  execute(
    id: StressId,
    options: StressOptions,
    scope: SessionScope,
    probe: StressProbe,
  ): Promise<void>;
  load(): Promise<StressReport[]>;
  save(reports: StressReport[]): Promise<void>;
}
export class StressRunner {
  private listeners = new Set<() => void>();
  private revision = 0;
  private initialized = false;
  private loading: Promise<void> | null = null;
  private saving = Promise.resolve();
  private active: StressReport | null = null;
  private generation = 0;
  private reports: StressReport[] = [];
  private snapshot = {
    revision: 0,
    active: this.active,
    reports: this.reports,
    error: "",
  };
  constructor(private dependencies: StressDependencies) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private changed(error = this.snapshot.error) {
    this.snapshot = {
      revision: ++this.revision,
      active: this.active,
      reports: this.reports,
      error,
    };
    for (const listener of this.listeners) listener();
  }
  async initialize() {
    if (this.initialized) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        this.reports = (await this.dependencies.load()).slice(0, 40);
        let interrupted = false;
        for (const report of this.reports)
          if (report.verdict === "running") {
            interrupted = true;
            report.verdict =
              reportVerdict(report) === "failed" ? "failed" : "inconclusive";
            report.completionReason = "process-ended";
            report.phase = "Previous process ended before completion";
            report.nextAction =
              "Inspect native crash/hang evidence; replay the same seed. A restart is not a pass.";
          }
        if (interrupted) await this.persist();
      } catch (error) {
        this.changed(`Stress history could not be read: ${formatError(error)}`);
      }
      this.initialized = true;
      this.changed();
    })();
    return this.loading;
  }
  private persist() {
    // The storage adapter serializes synchronously before returning its promise.
    // Keep completed reports by reference instead of deep-copying all history.
    this.saving = this.saving
      .catch(() => {})
      .then(() => this.dependencies.save([...this.reports]));
    return this.saving;
  }
  async start(id: StressId, options: StressOptions) {
    const generation = this.generation;
    await this.initialize();
    if (generation !== this.generation)
      throw new CancelledError(
        "Stress start cancelled before initialization finished.",
      );
    if (this.active)
      throw new BlockedError(
        "Stop the active stress run before starting another.",
      );
    const limits = stressLimits(id, options),
      feature = stressFeature(id, options);
    const now = new Date().toISOString();
    const report: StressReport = {
      id: `stress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      featureId: id,
      name: feature.name,
      explanation: feature.explanation,
      usage: feature.usage,
      previousFunctionalResult: feature.previous,
      options: {
        ...options,
        ...(options.targetSettings
          ? { targetSettings: redact({ ...options.targetSettings }) }
          : {}),
      },
      limits,
      environment: this.dependencies.environment(),
      startedAt: now,
      heartbeatAt: now,
      elapsedMs: 0,
      phase: "Preparing exclusive audio session",
      verdict: "running",
      counters: { requested: 0, completed: 0, cancelled: 0, failed: 0 },
      metrics: {},
      checks: [],
      events: [],
      droppedEvents: 0,
      manual: feature.manual.map((instruction) => ({
        instruction,
        verdict: "pending",
        notes: "",
      })),
      method: `${feature.method} Started by ${options.operator}; instrumentation ${options.instrumentation}.`,
      operatorNotes: "",
      humanEffortSeconds: null,
      nextAction:
        "Wait for the workload, then complete the listed manual/native checks.",
    };
    this.active = report;
    this.reports = [report, ...this.reports].slice(0, 40);
    this.changed("");
    let probe: StressProbe | undefined;
    let checkpoint: ReturnType<typeof setInterval> | undefined;
    try {
      await this.dependencies.exclusive(`stress-${id}`, async (scope) => {
        await this.persist();
        if (generation !== this.generation)
          throw new CancelledError(
            "Stress start cancelled before the workload began.",
          );
        scope.ensureActive();
        probe = new StressProbe(report, scope, () => this.changed());
        checkpoint = setInterval(() => {
          void this.persist().catch((error) =>
            this.changed(`Stress checkpoint failed: ${formatError(error)}`),
          );
        }, 5000);
        await this.dependencies.execute(id, options, scope, probe);
        scope.ensureActive();
      });
      report.checks.push({
        name: "Owned session cleanup completed",
        status: "passed",
        detail: "Exclusive session cleanup settled before the run ended.",
      });
      report.verdict = reportVerdict(report);
      report.completionReason = "completed";
      report.phase = "Finished";
    } catch (error) {
      report.completionReason =
        error instanceof BlockedError
          ? "blocked"
          : error instanceof CancelledError
            ? "cancelled"
            : error instanceof StressBudgetError
              ? "limit"
              : "error";
      report.verdict =
        reportVerdict(report) === "failed"
          ? "failed"
          : error instanceof BlockedError
            ? "blocked"
            : error instanceof CancelledError ||
                error instanceof StressBudgetError
              ? "inconclusive"
              : "failed";
      report.phase = formatError(error);
      if (report.events.length === 200) {
        report.events.shift();
        report.droppedEvents++;
      }
      report.events.push({
        at: new Date().toISOString(),
        name: "runEnded",
        detail: report.phase,
      });
    } finally {
      if (checkpoint) clearInterval(checkpoint);
      probe?.finish();
      report.finishedAt = new Date().toISOString();
      report.nextAction =
        report.verdict === "passed"
          ? "Quick gate passed; optional longer qualification remains separate."
          : report.verdict === "inconclusive"
            ? "Complete unverified/manual checks or replay the incomplete workload with the same seed."
            : "Inspect the first failure and its seed/settings before increasing load.";
      this.active = null;
      this.changed();
      try {
        await this.persist();
      } catch (error) {
        this.changed(`Stress result could not be saved: ${formatError(error)}`);
      }
    }
    return report;
  }
  observe(name: string, detail: unknown) {
    if (!this.active) return;
    if (this.active.events.length >= 200) {
      this.active.events.shift();
      this.active.droppedEvents++;
    }
    this.active.events.push({ at: new Date().toISOString(), name, detail });
    this.changed();
  }
  finishLive() {
    if (this.active?.featureId !== "feature-load") return;
    const plan = featureLoadPlan(this.active.options);
    if (!plan.keepRunning) return;
    this.active.metrics.finishLiveRequested = true;
    this.changed();
  }
  cancelPending = () => {
    this.generation++;
  };
  async review(
    id: string,
    manualIndex: number,
    verdict: "passed" | "failed",
    notes: string,
    effortSeconds: number | null,
  ) {
    const report = this.reports.find((result) => result.id === id);
    if (!report || report.verdict === "running") return;
    const check = report.manual[manualIndex];
    if (!check) return;
    const updated = {
      ...report,
      manual: report.manual.map((item) => ({ ...item })),
    };
    this.reports = this.reports.map((item) =>
      item === report ? updated : item,
    );
    const updatedCheck = updated.manual[manualIndex];
    updatedCheck.verdict = verdict;
    updatedCheck.notes = notes;
    updated.humanEffortSeconds = effortSeconds;
    // A review cannot turn an aborted/blocked/native-failed workload into a pass.
    if (updated.phase === "Finished") updated.verdict = reportVerdict(updated);
    this.changed();
    await this.persist();
  }
  async note(id: string, notes: string, effortSeconds: number | null) {
    const report = this.reports.find((result) => result.id === id);
    if (!report) return;
    this.reports = this.reports.map((item) =>
      item === report
        ? { ...item, operatorNotes: notes, humanEffortSeconds: effortSeconds }
        : item,
    );
    this.changed();
    await this.persist();
  }
}
