// The card's state flow as a signal graph: what the card is shown from (inputs), the keys derived from
// them (computeds, compared by identity or value so an unrelated change stops there), and the steps
// that rebuild or refresh a part of the scene (effects, one per step, in pipeline order). It replaces
// the hand-written per-update diff (the old _built bag): a step runs when, and only when, one of the
// keys it read changed. The steps themselves stay on the card (CardSteps); this module only decides
// when they run, so the graph is unit-tested with stub steps (test/card-state.test.js).
//
// Inputs: hass (the object HA pushes; its registries and states are split off by identity, so a push
// that only changes states rebuilds nothing), config, layout (edits replace only the parts they touch),
// the loaded model, editing, labels (fetched once where hass.labels is missing), rendered (the view
// exists), reconnects and tick (an untracked change: something the card cannot see as a signal).
//
// Steps (the order of the old _update): theme -> views / structure -> object bindings -> markers ->
// model load -> mower config -> states -> tail (objects, popup, edit panel). Reruns are deferred to a
// microtask and coalesced (one flush per burst of writes), as the old _schedule did.

import {
  computed,
  depend,
  effect,
  microtaskScheduler,
  sameItems,
  signal,
  untracked,
  type ReadonlySignal,
  type Signal,
} from "../signals.ts";
import type { ResolvedCardConfig } from "../types/config.ts";
import type { Hass } from "../types/ha.ts";
import type { Layout } from "../types/layout.ts";

/** The model bindings as far as the graph looks at them (ModelLoader.modelBindings). */
export interface BindingsLike {
  manifest: unknown;
}

/** The card's rebuild / refresh steps the graph runs (implemented on the card). */
export interface CardSteps<MB extends BindingsLike = BindingsLike> {
  /** hass.themes changed (or the first build): the theme colours into the view. */
  applyTheme(): void;
  /** The loaded model's bindings against HA and the layout (cached per input identity). */
  modelBindings(): MB | null;
  /** The model's placement and bindings as a string: the structure rebuilds when it changes. */
  modelKey(mb: MB | null): string;
  /** Resolve the view list: true (views and scene), "views" (only the view list), false. */
  resolveViews(mb: MB | null): boolean | "views";
  /** The view list changed: rules that match nothing may need a merge reload. */
  checkMergeKeep(): void;
  buildStructure(mb: MB | null, viewsChanged: boolean): void;
  /** Only layout.views / view_order changed: refresh the chips and the current view. */
  refreshViews(): void;
  /** Bind model objects to entities; true when the bindings changed. */
  syncBindings(): boolean;
  buildMarkers(): void;
  loadModel(): void;
  mowerConfig(m: Layout["mower"] | null): void;
  /** Marker states, glows, badges and the live mower from hass.states. */
  refreshStates(): void;
  /** After every update: objects, popup, edit panel (rebuilt: markers or the view list changed). */
  tail(rebuilt: boolean): void;
}

/** Layout parts the steps read, split off by identity (an edit replaces just the parts it touches). */
const part = <K extends keyof Layout>(
  layout: ReadonlySignal<Layout | null>,
  key: K,
): ReadonlySignal<Layout[K] | undefined> =>
  computed(() => {
    const l = layout.value;
    return l ? l[key] : undefined;
  });

export class CardState<MB extends BindingsLike = BindingsLike> {
  // inputs
  hass = signal<Hass | null>(null);
  config = signal<ResolvedCardConfig | null>(null);
  layout = signal<Layout | null>(null);
  editing = signal<boolean>(false);
  /** The loaded model (view.model), set when a load finished. */
  model = signal<unknown>(null);
  /** Label names fetched from the label registry where hass.labels is missing. */
  labels = signal<Record<string, { name: string }> | undefined>(undefined);
  /** The view and the card's DOM exist (the card rendered). */
  rendered = signal<boolean>(false);
  /** Bumped on reconnect: the states refresh once more (map / image timers re-arm there). */
  reconnects = signal<number>(0);
  /** Bumped by schedule(): something outside the graph changed, the per-update steps run again. */
  tick = signal<number>(0);

  // hass pieces by identity: HA replaces each object only when it changes
  states = computed(() => this.hass.value?.states);
  entities = computed(() => this.hass.value?.entities);
  devices = computed(() => this.hass.value?.devices);
  areas = computed(() => this.hass.value?.areas);
  floors = computed(() => this.hass.value?.floors);
  themes = computed(() => this.hass.value?.themes);
  hassLabels = computed(() => this.hass.value?.labels || this.labels.value);

  // layout parts
  rooms = part(this.layout, "rooms");
  roomLabels = part(this.layout, "room_labels");
  layoutFloors = part(this.layout, "floors");
  layoutModel = part(this.layout, "model");
  pins = part(this.layout, "pins");
  hidden = part(this.layout, "hidden");
  badges = part(this.layout, "badges");
  views = part(this.layout, "views");
  viewOrder = part(this.layout, "view_order");
  objects = part(this.layout, "objects");
  tags = part(this.layout, "tags");
  mower = computed(() => this.layout.value?.mower || null);
  /** The mower marker depends on the entity and its floor only (not on calibration or overlay). */
  mowerKey = computed(() => {
    const m = this.mower.value;
    return m ? `${m.entity}|${m.floor_id}` : "";
  });

  /** Everything is there to build: the view, hass and the stored layout. */
  ready = computed(
    () => this.rendered.value && !!this.hass.value && !!this.layout.value,
  );

  // derived from the steps (set by connect)
  declare mb: ReadonlySignal<MB | null>;
  declare modelKey: ReadonlySignal<string>;
  declare viewKey: ReadonlySignal<unknown[]>;
  declare structureKey: ReadonlySignal<unknown[]>;
  declare registryKey: ReadonlySignal<unknown[]>;

  // what the steps produced (later steps depend on them)
  structureGen = signal<number>(0);
  viewsGen = signal<number>(0);
  bindingsGen = signal<number>(0);
  markersGen = signal<number>(0);
  mowerGen = signal<number>(0);

  _scheduler = microtaskScheduler();
  _disposers: (() => void)[] = [];

  /** Reruns are waiting for their microtask (the headless checks wait for a settled card). */
  pending(): boolean {
    return this._scheduler.pending();
  }

  /** Something the graph cannot see changed: run the per-update steps again. */
  schedule(): void {
    this.tick.value = this.tick.peek() + 1;
  }

  /** Build the derived keys and the step effects over the card's steps. Call once. */
  connect(steps: CardSteps<MB>): void {
    const opts = { schedule: this._scheduler.schedule };
    const bump = (s: Signal<number>) => (s.value = s.peek() + 1);
    const fx = (fn: () => void) => this._disposers.push(effect(fn, opts));

    this.mb = computed(() => {
      // The inputs of ModelLoader.modelBindings (it reads the card, so read them here to track). The
      // view swaps its model before the load settles (model is set then), so every push and tick
      // asks again too: modelBindings caches per input identity, the same bindings stop here.
      depend(
        this.model,
        this.layoutModel,
        this.layoutFloors,
        this.floors,
        this.areas,
        this.config,
        this.tick,
      );
      if (!this.hass.value) return null;
      return untracked(() => steps.modelBindings());
    });
    this.modelKey = computed(() => {
      const mb = this.mb.value;
      // the placement: model_* of a URL model (config), layout.model of an uploaded one
      depend(this.config, this.layoutModel);
      return untracked(() => steps.modelKey(mb));
    });
    this.viewKey = computed(
      () => [
        this.mb.value,
        this.views.value,
        this.viewOrder.value,
        this.layoutFloors.value,
        this.layoutModel.value,
        this.floors.value,
        this.config.value,
      ],
      sameItems,
    );
    this.structureKey = computed(
      () => [
        this.themes.value,
        this.rooms.value,
        this.roomLabels.value || null,
        this.layoutFloors.value,
        this.floors.value,
        this.areas.value,
        this.mb.value && this.mb.value.manifest,
        this.modelKey.value,
        this.editing.value, // the model look: outlines and labels only while editing
      ],
      sameItems,
    );
    // HA replaces these objects when the registries change (registry.ts registrySignature)
    this.registryKey = computed(
      () => [
        this.entities.value,
        this.devices.value,
        this.areas.value,
        this.floors.value,
      ],
      sameItems,
    );

    // 1. theme
    fx(() => {
      if (!this.ready.value) return;
      depend(this.themes);
      untracked(() => steps.applyTheme());
    });

    // 2. views and structure
    let builtKey: unknown[] | null = null;
    fx(() => {
      if (!this.ready.value) return;
      const sk = this.structureKey.value;
      depend(this.viewKey);
      const mb = this.mb.value;
      untracked(() => {
        const views = steps.resolveViews(mb);
        if (views) steps.checkMergeKeep();
        if (sk !== builtKey || (views && views !== "views")) {
          builtKey = sk;
          steps.buildStructure(mb, !!views);
          bump(this.structureGen);
        } else if (views === "views") {
          steps.refreshViews();
          bump(this.viewsGen);
        }
      });
    });

    // 3. object bindings (which entities exist is part of them: they follow the states)
    fx(() => {
      if (!this.ready.value) return;
      depend(
        this.model,
        this.objects,
        this.tags,
        this.mower,
        this.states,
        this.entities,
        this.hassLabels,
        this.tick,
      );
      untracked(() => {
        if (steps.syncBindings()) bump(this.bindingsGen);
      });
    });

    // 4. markers: registries, pins, hidden, the mower marker, after the structure and the bindings
    fx(() => {
      if (!this.ready.value) return;
      depend(
        this.structureGen,
        this.bindingsGen,
        this.registryKey,
        this.pins,
        this.hidden,
        this.mowerKey,
      );
      untracked(() => steps.buildMarkers());
      bump(this.markersGen);
    });

    // 5. model load: a layout model replaced (the first one is loaded by the card's render)
    let loadedFor: unknown = undefined;
    fx(() => {
      if (!this.ready.value) return;
      const m = this.layoutModel.value;
      if (m === loadedFor) return;
      loadedFor = m;
      untracked(() => steps.loadModel());
    });

    // 6. mower config
    let mowerFor: unknown = undefined;
    fx(() => {
      if (!this.ready.value) return;
      const m = this.mower.value;
      if (m === mowerFor) return;
      mowerFor = m;
      untracked(() => steps.mowerConfig(m));
      bump(this.mowerGen);
    });

    // 7. states
    fx(() => {
      if (!this.ready.value) return;
      depend(
        this.states,
        this.badges,
        this.structureGen,
        this.markersGen,
        this.mowerGen,
        this.reconnects,
      );
      untracked(() => steps.refreshStates());
    });

    // 8. after every update (any hass push, edit, model load or schedule())
    let seen: unknown[] | null = null;
    fx(() => {
      if (!this.ready.value) return;
      const gens = [this.markersGen.value, this.viewsGen.value];
      depend(
        this.hass,
        this.layout,
        this.config,
        this.model,
        this.editing,
        this.hassLabels,
        this.tick,
      );
      const rebuilt = !seen || !sameItems(gens, seen);
      seen = gens;
      untracked(() => steps.tail(rebuilt));
    });
  }

  dispose(): void {
    for (const d of this._disposers) d();
    this._disposers = [];
  }
}
