// A tiny signals core: signal / computed / effect / batch / untracked (push-pull, glitch-free).
// A write marks its observers: direct ones dirty, everything downstream "check". Computeds are lazy
// and recompute only when read and one of their sources really changed; a computed whose new value
// equals the old one (Object.is unless given an `equals`) stops the change there. Effects rerun after
// the outermost batch (or the write, outside a batch), in creation order, each at most once per flush;
// an effect created with a `schedule` hands its rerun to that instead (the card defers to a microtask).
// No dependencies, no global registry: a graph lives as long as its nodes are referenced.

const CLEAN = 0,
  CHECK = 1,
  DIRTY = 2;
type State = typeof CLEAN | typeof CHECK | typeof DIRTY;

export type Equals<T> = (a: T, b: T) => boolean;

/** Arrays equal when every element is identical (Object.is): a key of several identities. */
export const sameItems = <T extends readonly unknown[]>(a: T, b: T): boolean =>
  a === b || (a.length === b.length && a.every((x, i) => Object.is(x, b[i])));

interface Node {
  state: State;
  sources: Source[];
  run(): void; // recompute (computed) / rerun (effect)
  notify(): void; // an effect queues itself; a computed passes "check" on
}
interface Source {
  observers: Set<Node>;
  refresh(): void; // bring a computed up to date (no-op for a signal)
}

let current: Node | null = null; // the computed / effect being run (reads track into it)
let batchDepth = 0;
let flushing = false;
const queue = new Set<EffectNode>();
let nextId = 0;

function track(src: Source): void {
  if (current && !current.sources.includes(src)) {
    current.sources.push(src);
    src.observers.add(current);
  }
}

function untrack(node: Node): void {
  for (const s of node.sources) s.observers.delete(node);
  node.sources = [];
}

// Run fn with node as the reader: its sources are what fn reads now.
function tracked<R>(node: Node, fn: () => R): R {
  untrack(node);
  const prev = current;
  current = node;
  try {
    return fn();
  } finally {
    current = prev;
  }
}

// Bring a node up to date: "check" asks the sources first (a source that changed marks it dirty).
function update(node: Node): void {
  if (node.state === CHECK) {
    for (const s of node.sources) {
      s.refresh();
      if ((node.state as State) === DIRTY) break;
    }
  }
  if (node.state === DIRTY) node.run();
  node.state = CLEAN;
}

function mark(observers: Set<Node>, state: State): void {
  for (const o of [...observers]) {
    if (o.state >= state) continue;
    const was = o.state;
    o.state = state;
    if (was === CLEAN) o.notify();
  }
}

function flush(): void {
  if (flushing || batchDepth) return;
  flushing = true;
  try {
    let guard = 0;
    while (queue.size) {
      if (++guard > 100000)
        throw new Error("signals: effects keep re-triggering");
      // the oldest effect first: effects created earlier run earlier (pipelines rely on it)
      let next: EffectNode | null = null;
      for (const e of queue) if (!next || e.id < next.id) next = e;
      queue.delete(next!);
      next!.flushNow();
    }
  } finally {
    flushing = false;
  }
}

export interface ReadonlySignal<T> {
  readonly value: T; // tracked read
  peek(): T; // untracked read
}

export class Signal<T> implements Source, ReadonlySignal<T> {
  observers = new Set<Node>();
  _value: T;
  _equals: Equals<T>;
  constructor(value: T, equals: Equals<T> = Object.is) {
    this._value = value;
    this._equals = equals;
  }
  refresh(): void {}
  get value(): T {
    track(this);
    return this._value;
  }
  set value(v: T) {
    if (this._equals(this._value, v)) return;
    this._value = v;
    batchDepth++;
    try {
      mark(this.observers, DIRTY);
    } finally {
      batchDepth--;
    }
    flush();
  }
  peek(): T {
    return this._value;
  }
}

class Computed<T> implements Node, Source, ReadonlySignal<T> {
  state: State = DIRTY;
  sources: Source[] = [];
  observers = new Set<Node>();
  _value: T | undefined = undefined;
  _has = false;
  _running = false;
  _fn: () => T;
  _equals: Equals<T>;
  constructor(fn: () => T, equals: Equals<T> = Object.is) {
    this._fn = fn;
    this._equals = equals;
  }
  notify(): void {
    mark(this.observers, CHECK);
  }
  run(): void {
    if (this._running) throw new Error("signals: computed depends on itself");
    this._running = true;
    let v: T;
    try {
      v = tracked(this, this._fn);
    } finally {
      this._running = false;
    }
    if (this._has && this._equals(this._value as T, v)) return;
    this._value = v;
    this._has = true;
    // the observers asked "check": this one did change
    for (const o of this.observers) if (o.state === CHECK) o.state = DIRTY;
  }
  refresh(): void {
    update(this);
  }
  get value(): T {
    this.refresh();
    track(this);
    return this._value as T;
  }
  peek(): T {
    this.refresh();
    return this._value as T;
  }
}

type Cleanup = void | (() => void);
/** Takes an effect's rerun (and its creation order) and calls it later. */
export type Scheduler = (run: () => void, order: number) => void;

class EffectNode implements Node {
  state: State = DIRTY;
  sources: Source[] = [];
  id = nextId++;
  _fn: () => Cleanup;
  _cleanup: (() => void) | null = null;
  _schedule: Scheduler | null;
  _scheduled = false;
  _disposed = false;
  constructor(fn: () => Cleanup, schedule?: Scheduler) {
    this._fn = fn;
    this._schedule = schedule || null;
  }
  notify(): void {
    if (this._disposed) return;
    if (!this._schedule) {
      queue.add(this);
      return;
    }
    if (this._scheduled) return;
    this._scheduled = true;
    this._schedule(() => {
      this._scheduled = false;
      this.flushNow();
    }, this.id);
  }
  flushNow(): void {
    if (this._disposed) return;
    try {
      update(this);
    } catch (e) {
      this.state = CLEAN; // the next change runs it again
      console.error(e);
    }
  }
  run(): void {
    if (this._cleanup) this._cleanup();
    this._cleanup = null;
    const c = tracked(this, this._fn);
    if (typeof c === "function") this._cleanup = c;
  }
  dispose(): void {
    this._disposed = true;
    queue.delete(this);
    untrack(this);
    if (this._cleanup) this._cleanup();
    this._cleanup = null;
  }
}

export const signal = <T>(value: T, equals?: Equals<T>): Signal<T> =>
  new Signal(value, equals);

export const computed = <T>(
  fn: () => T,
  equals?: Equals<T>,
): ReadonlySignal<T> => new Computed(fn, equals);

export interface EffectOptions {
  /** Reruns go here instead of the flush after the write (the first run is always at once). */
  schedule?: Scheduler;
}

/** Run fn now and again whenever what it read changes. fn may return a cleanup. -> dispose */
export function effect(
  fn: () => Cleanup,
  opts: EffectOptions = {},
): () => void {
  const e = new EffectNode(fn, opts.schedule);
  batchDepth++;
  try {
    e.flushNow();
  } finally {
    batchDepth--;
  }
  flush(); // what the first run wrote
  return () => e.dispose();
}

/** Writes inside fn notify once, at its end. */
export function batch<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    flush();
  }
}

/** Read signals for their tracking only (an effect that depends on them without using the values). */
export const depend = (...sources: ReadonlySignal<unknown>[]): unknown[] =>
  sources.map((s) => s.value);

/** fn's reads do not track into the running computed / effect. */
export function untracked<T>(fn: () => T): T {
  const prev = current;
  current = null;
  try {
    return fn();
  } finally {
    current = prev;
  }
}

/**
 * A scheduler for effect(…, { schedule }) that reruns the effects one microtask after the write,
 * all due ones together and in creation order (a rerun that triggers an older effect runs it next).
 * pending(): reruns are waiting.
 */
export function microtaskScheduler(): {
  schedule: Scheduler;
  pending: () => boolean;
} {
  const runs = new Map<number, () => void>();
  let armed = false;
  const drain = () => {
    try {
      let guard = 0;
      while (runs.size) {
        if (++guard > 100000)
          throw new Error("signals: effects keep re-triggering");
        const order = Math.min(...runs.keys());
        const run = runs.get(order)!;
        runs.delete(order);
        run();
      }
    } finally {
      armed = false;
    }
  };
  return {
    schedule(run, order) {
      runs.set(order, run);
      if (!armed) {
        armed = true;
        queueMicrotask(drain);
      }
    },
    pending: () => armed,
  };
}
