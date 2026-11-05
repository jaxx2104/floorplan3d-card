// The signals core (src/signals.ts): tracking, cut-off by equality, batching, ordering, scheduling.
import { describe, it, expect } from "bun:test";
import {
  batch,
  computed,
  depend,
  effect,
  microtaskScheduler,
  sameItems,
  signal,
  untracked,
} from "../src/signals.ts";

describe("signals", () => {
  it("an effect runs at once and again when what it read changes", () => {
    const a = signal(1);
    const seen = [];
    effect(() => {
      seen.push(a.value);
    });
    a.value = 2;
    a.value = 2; // same value: nothing
    expect(seen).toEqual([1, 2]);
  });

  it("computeds are lazy and cached", () => {
    const a = signal(1);
    let runs = 0;
    const c = computed(() => (runs++, a.value * 2));
    expect(runs).toBe(0);
    expect(c.value).toBe(2);
    expect(c.value).toBe(2);
    expect(runs).toBe(1);
    a.value = 5;
    expect(c.peek()).toBe(10);
    expect(runs).toBe(2);
  });

  it("an equal computed stops the change (identity cut-off)", () => {
    const hass = signal({ states: { a: 1 }, areas: { x: 1 } });
    const areas = computed(() => hass.value.areas);
    let runs = 0;
    effect(() => {
      depend(areas);
      runs++;
    });
    const h = hass.peek();
    hass.value = { ...h, states: { a: 2 } }; // areas kept
    expect(runs).toBe(1);
    hass.value = { ...h, areas: { x: 1 } }; // a new areas object
    expect(runs).toBe(2);
  });

  it("sameItems compares keys element by element", () => {
    const o = {};
    const a = signal(o),
      b = signal(1);
    const key = computed(() => [a.value, b.value > 0], sameItems);
    let runs = 0;
    effect(() => {
      depend(key);
      runs++;
    });
    b.value = 2; // still > 0: same key
    expect(runs).toBe(1);
    a.value = {};
    expect(runs).toBe(2);
  });

  it("glitch-free: a diamond runs its effect once with consistent values", () => {
    const a = signal(1);
    const b = computed(() => a.value + 1);
    const c = computed(() => a.value * 10);
    const seen = [];
    effect(() => {
      seen.push([b.value, c.value]);
    });
    a.value = 2;
    expect(seen).toEqual([
      [2, 10],
      [3, 20],
    ]);
  });

  it("batch coalesces writes into one run", () => {
    const a = signal(1),
      b = signal(1);
    let runs = 0;
    effect(() => {
      depend(a, b);
      runs++;
    });
    batch(() => {
      a.value = 2;
      b.value = 3;
      a.value = 4;
    });
    expect(runs).toBe(2);
  });

  it("untracked reads do not subscribe", () => {
    const a = signal(1),
      b = signal(1);
    let runs = 0;
    effect(() => {
      depend(a);
      untracked(() => b.value);
      runs++;
    });
    b.value = 2;
    expect(runs).toBe(1);
    a.value = 2;
    expect(runs).toBe(2);
  });

  it("dynamic dependencies: a branch not taken is not tracked", () => {
    const on = signal(false),
      x = signal(1);
    let runs = 0;
    effect(() => {
      if (on.value) depend(x);
      runs++;
    });
    x.value = 2;
    expect(runs).toBe(1);
    on.value = true;
    x.value = 3;
    expect(runs).toBe(3);
  });

  it("effects run in creation order; an effect's write reaches later ones in the same flush", () => {
    const a = signal(0),
      gen = signal(0);
    const order = [];
    effect(() => {
      depend(a);
      order.push("first");
      gen.value = gen.peek() + 1;
    });
    effect(() => {
      depend(gen);
      order.push("second");
    });
    order.length = 0;
    a.value = 1;
    expect(order).toEqual(["first", "second"]);
  });

  it("cleanup runs before a rerun and on dispose", () => {
    const a = signal(0);
    const log = [];
    const stop = effect(() => {
      const v = a.value;
      log.push(`run ${v}`);
      return () => log.push(`clean ${v}`);
    });
    a.value = 1;
    stop();
    a.value = 2;
    expect(log).toEqual(["run 0", "clean 0", "run 1", "clean 1"]);
  });

  it("a computed reading itself throws", () => {
    let c;
    c = computed(() => c.value);
    expect(() => c.value).toThrow(/itself/);
  });

  it("a scheduled effect reruns once per microtask, in creation order", async () => {
    const s = microtaskScheduler();
    const a = signal(0),
      b = signal(0);
    const log = [];
    effect(
      () => {
        log.push(`one ${a.value}`);
      },
      { schedule: s.schedule },
    );
    effect(
      () => {
        log.push(`two ${b.value}`);
      },
      { schedule: s.schedule },
    );
    log.length = 0;
    b.value = 1;
    a.value = 1;
    a.value = 2;
    expect(log).toEqual([]);
    expect(s.pending()).toBe(true);
    await Promise.resolve();
    expect(log).toEqual(["one 2", "two 1"]);
    expect(s.pending()).toBe(false);
  });
});
