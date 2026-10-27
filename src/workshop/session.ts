import { CancelledError } from "./types";

type Cleanup = () => void | Promise<void>;
export class SessionScope {
  alive = true;
  private cleanups = new Set<Cleanup>();
  private releaseParent?: () => void;
  private pending = new Set<Promise<void>>();
  private disposing: Promise<void> | null = null;
  private disposed = false;
  constructor(
    readonly featureId: string,
    readonly parent?: SessionScope,
  ) {
    this.releaseParent = parent?.defer(() => this.dispose());
  }
  owns(scope: SessionScope): boolean {
    return scope === this || (!!scope.parent && this.owns(scope.parent));
  }
  ensureActive() {
    if (!this.alive) throw new CancelledError("Session stopped or replaced.");
    this.parent?.ensureActive();
  }
  defer(cleanup: Cleanup) {
    this.ensureActive();
    this.cleanups.add(cleanup);
    return () => {
      this.cleanups.delete(cleanup);
    };
  }
  hold<T>(pending: Promise<T>): Promise<T> {
    // Native lifecycle work cannot be cancelled. Settle it before releasing
    // resources or allowing another session to reuse the same context/recorder.
    this.ensureActive();
    const settled = pending.then(
      () => {},
      () => {},
    );
    this.pending.add(settled);
    void settled.then(() => {
      this.pending.delete(settled);
    });
    return pending;
  }
  dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.disposing) return this.disposing;
    this.alive = false;
    this.disposing = (async () => {
      await Promise.all(this.pending);
      const errors: unknown[] = [];
      for (const cleanup of [...this.cleanups].reverse()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      this.cleanups.clear();
      if (errors.length)
        throw new AggregateError(
          errors,
          "Some audio resources failed to stop.",
        );
    })().finally(() => {
      this.disposed = true;
      this.releaseParent?.();
    });
    return this.disposing;
  }
  timeout(callback: () => void, ms: number) {
    this.ensureActive();
    const timer = setTimeout(() => {
      unregister();
      if (this.alive) callback();
    }, ms);
    const unregister = this.defer(() => clearTimeout(timer));
    return timer;
  }
  async wait(ms: number) {
    await new Promise<void>((resolve) => {
      let unregister = () => {};
      const timer = setTimeout(() => {
        unregister();
        resolve();
      }, ms);
      unregister = this.defer(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.ensureActive();
  }
}

export class SessionCoordinator {
  private generation = 0;
  private barrier = Promise.resolve();
  active: SessionScope | null = null;
  private detach(whenEmpty?: Cleanup) {
    const old = this.active;
    this.active = null;
    const cleanup = this.barrier.then(() =>
      old ? old.dispose() : whenEmpty?.(),
    );
    this.barrier = cleanup.catch(() => {});
    return cleanup;
  }
  async replace(featureId: string) {
    const ticket = ++this.generation;
    await this.detach();
    if (ticket !== this.generation)
      throw new CancelledError("A newer operation replaced this session.");
    const scope = new SessionScope(featureId);
    this.active = scope;
    return scope;
  }
  async stop(expected?: SessionScope, whenEmpty?: Cleanup) {
    if (expected && this.active !== expected) return;
    ++this.generation;
    await this.detach(whenEmpty);
  }
}
