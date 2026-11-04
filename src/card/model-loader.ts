// The card's 3D model: which one to load (YAML model: url, else the one uploaded to the integration),
// its bytes through the local cache, the merge keep-list from the view rules, the alignment and the
// level / room bindings resolved against HA. What happens once it is there is the card's (_afterModel).

import { headerVersion, layoutModelVersion, evictModel, loadModelBuffer } from '../model-cache.ts';
import { nodeIndex, unmatchedSelectors } from '../views.ts';
import { threeAdapter } from '../manifest.ts';
import { levelsFromFloorMap, resolveLevels, resolveRoomAreas, bindingDiff, snapshotDiff } from '../bindings.ts';
import { mergeFloors } from '../layout.ts';
import type { Floorplan3dCard } from '../card-impl.ts';
import type { CardConfig } from '../types/config.ts';
import type { LayoutModel } from '../types/layout.ts';
import type { ModelManifest, ModelOptions } from '../view/model.ts';

declare global {
  interface Window {
    /** Headless checks: the model download timeout (ms) instead of 60 s. */
    __fpModelTimeoutMs?: number;
  }
}

const MODEL_API = '/api/floorplan3d/model';

type FetchFn = (init?: { signal?: AbortSignal }) => Promise<Response>;

/** Where the last model bytes came from: cache key base, version, how to fetch them again. */
export interface ModelSource {
  base: string;
  version: string | null;
  fetchFn: FetchFn;
}

/** Model placement in the card plan (bindings.js transformPoint). */
export interface ModelAlign {
  position: number[];
  rotation: number;
  scale: number;
}

/** The loaded model's levels / rooms resolved against HA (modelBindings). */
export interface ModelBindings {
  manifest: ModelManifest;
  levels: ReturnType<typeof resolveLevels>;
  rooms: ReturnType<typeof resolveRoomAreas>;
  diff: ReturnType<typeof bindingDiff>;
  notice: ReturnType<typeof snapshotDiff>;
}

export class ModelLoader {
  card: Floorplan3dCard;
  _loadGen: number | undefined;
  _mbCache: { inputs: unknown[]; value: ModelBindings } | undefined;
  _mergeReloadFor: unknown;
  _modelSrc: ModelSource | undefined;
  _modelFromCache: boolean | undefined;
  _modelEvicted: number | undefined;

  /** @param card the Floorplan3dCard (host): read live, never captured */
  constructor(card: Floorplan3dCard) {
    this.card = card;
    this._loadGen = undefined; // a later load owns the loading drawing
    this._mbCache = undefined; // modelBindings() per input identity
    this._mergeReloadFor = undefined;
    this._modelSrc = undefined; // { base, version, fetchFn } of the last fetch
    this._modelFromCache = undefined; // headless checks
    this._modelEvicted = undefined; // headless checks
  }

  // model: from YAML (model: url) if set, else the one uploaded to the integration (layout.model)
  _loadModel(reload = false): void {
    const c = this.card._config;
    let opts: ModelOptions | null = null;
    if (c.model) {
      const url = new URL(String(c.model), location.href).href;
      opts = {
        url: String(c.model),
        // versioned by the server's validators (HEAD), cached locally like an uploaded model
        data: async () => {
          let version = null;
          try {
            const h = await fetch(url, { method: 'HEAD', credentials: 'same-origin' });
            if (h.ok) version = headerVersion(h.headers);
          } catch (e) { /* offline or no HEAD: fetched below (and not cached) */ }
          const src: ModelSource = (this._modelSrc = { base: url, version, fetchFn: ({ signal } = {}) => fetch(url, { credentials: 'same-origin', signal }) });
          return this._modelBytes(url, version, src.fetchFn);
        },
        dataFresh: () => this._modelFresh(),
        position: Array.isArray(c.model_position) ? c.model_position.map(Number) : [0, 0, 0],
        rotation: Number(c.model_rotation) || 0, scale: Number(c.model_scale) || 1,
        opacity: c.model_opacity === undefined ? 1 : Number(c.model_opacity),
      };
    } else {
      const m = this.card._layout && this.card._layout.model;
      if (m && m.version && this.card._hass && this.card._hass.fetchWithAuth) {
        const base = `${MODEL_API}/${encodeURIComponent(c.layout_key)}`;
        const url = `${base}?v=${m.version}`;
        opts = {
          id: m.version, name: m.name,
          // cached locally by version (only the body, keyed by the plain URL: no auth headers stored)
          data: () => {
            const src: ModelSource = (this._modelSrc = { base: new URL(base, location.href).href, version: layoutModelVersion(m), fetchFn: ({ signal } = {}) => this.card._hass.fetchWithAuth(url, { signal }) });
            return this._modelBytes(src.base, src.version, src.fetchFn);
          },
          dataFresh: () => this._modelFresh(),
          position: m.position || [0, 0, 0], rotation: m.rotation || 0, scale: m.scale || 1, opacity: m.opacity ?? 1,
        };
      }
    }
    if (opts) {
      opts.merge = c.merge !== false;
      // node: rules in the layout must be known before merging: wait for it when it has not loaded yet
      opts.keep = () => (this.card._layout ? this._mergeKeepSelectors() : this.card._layoutReady.then(() => this._mergeKeepSelectors()));
      opts.onMerged = () => this._modelMerged();
      opts.reload = reload;
    }
    const prevModel = this.card._view.model;
    const fresh = !!opts && !this.card._view.isModelLoaded(opts) && !this.card._view.isModelLoading(opts);
    // a later load owns the drawing: an earlier one finishing must not fade it
    const gen = fresh ? (this._loadGen = (this._loadGen || 0) + 1) : (this._loadGen || 0);
    if (fresh) {
      if (!prevModel) this.card._loadUI.loading(); // the plan drawing until the model is there
      this.card._loadUI.progress('Loading model…');
    }
    // the model is there (or failed): the card rebuilds around it
    this.card._view.setModel(opts).then((err: string | null | undefined) => this.card._afterModel(err, { fresh, opts, gen, prevModel }));
  }

  // Model bytes through the local cache, with the download progress on the stage. -> ArrayBuffer
  // The cached copy did not parse: evicted and fetched once more (a fresh download that fails is final).
  async _modelFresh(): Promise<ArrayBuffer> {
    const s = this._modelSrc;
    if (!s || !this._modelFromCache) throw new Error('not from the cache');
    await evictModel(s.base);
    this._modelEvicted = (this._modelEvicted || 0) + 1; // headless checks
    return this._modelBytes(s.base, s.version, s.fetchFn, { skipCache: true });
  }

  async _modelBytes(base: string, version: string | null, fetchFn: FetchFn, { skipCache = false }: { skipCache?: boolean } = {}): Promise<ArrayBuffer> {
    const ui = this.card._loadUI;
    const timeoutMs = Number(window.__fpModelTimeoutMs) || undefined; // headless checks shorten the 60 s
    const { buf, cached } = await loadModelBuffer({ base, version, fetchFn, skipCache, timeoutMs, onProgress: (l: number, t: number) => ui.download(l, t) });
    this._modelFromCache = cached; // headless checks
    ui.progress('Preparing model…');
    return buf;
  }

  // The model was merged after it was shown (the layout came later): index the merged tree, re-apply the view.
  _modelMerged(): void {
    const vw = this.card._view;
    if (!vw.model) return;
    if (this.card._index && this.card._built.viewManifest === vw.model.manifest) {
      this.card._viewCtl.setIndex(nodeIndex(threeAdapter(vw.model.root), vw.model.manifest));
      this.card._tagIndex();
      this.card._viewCtl.refreshViewState();
      if (!this.card._floorOnly) this.card._applyViewVisibility();
      this.card._applyMarkerStates();
    }
    if (this.card._editing) this.card._edit?.render();
    this.card._scheduleSurfaces();
    this.card._schedule();
  }

  // Layout node: rules that match nothing and were not known when the model was merged (an imported or
  // later-loaded layout may target merged parts): load the model once more, merging around them.
  _checkMergeKeep(): void {
    const vw = this.card._view, ms = vw.mergeStats;
    if (!vw.model || !ms || !ms.enabled || !ms.merged || !this.card._index || this._mergeReloadFor === vw.model.id) return;
    const known = new Set(ms.keep);
    const fresh = this._mergeKeepSelectors().filter((x) => x.startsWith('node:') && !known.has(x));
    if (!fresh.length || !unmatchedSelectors(this.card._index, fresh.map((x) => ({ hide: x }))).length) return;
    this._mergeReloadFor = vw.model.id;
    this._loadModel(true);
  }

  // View rule selectors from the layout and the card YAML: their node: matches are not merged away.
  _mergeKeepSelectors(): string[] {
    const out: string[] = [];
    // layout.views / YAML views: { [id]: { rules: [{ show | hide: selector }] } }, read defensively
    const add = (views: unknown): void => {
      if (!views || typeof views !== 'object') return;
      for (const v of Object.values(views) as ({ rules?: unknown } | null)[]) {
        for (const r of (v && Array.isArray(v.rules) ? v.rules as ({ show?: unknown; hide?: unknown } | null)[] : [])) {
          const sel = r && (r.show ?? r.hide);
          if (typeof sel === 'string') out.push(sel);
        }
      }
    };
    add(this.card._layout && this.card._layout.views);
    add(this.card._config.views);
    return out;
  }

  _modelAlign(): ModelAlign {
    const c: CardConfig = this.card._config;
    if (c.model) {
      return {
        position: Array.isArray(c.model_position) ? c.model_position.map(Number) : [0, 0, 0],
        rotation: Number(c.model_rotation) || 0, scale: Number(c.model_scale) || 1,
      };
    }
    const m: LayoutModel = (this.card._layout && this.card._layout.model) || {};
    return { position: m.position || [0, 0, 0], rotation: m.rotation || 0, scale: m.scale || 1 };
  }

  // Saved level/room bindings (layout.model; YAML model_floors for URL models) resolved
  // against the loaded model and the current HA floors and areas.
  modelBindings(): ModelBindings | null {
    const manifest = this.card._view && this.card._view.modelManifest();
    if (!manifest || !this.card._hass) return null;
    // cached per input identity: per hass state update nothing here changes
    const inputs = [manifest, this.card._layout && this.card._layout.model, this.card._layout && this.card._layout.floors, this.card._hass.floors, this.card._hass.areas, this.card._config];
    const c = this._mbCache;
    if (c && c.inputs.every((x, i) => x === inputs[i])) return c.value;
    const value = this._computeBindings(manifest);
    this._mbCache = { inputs, value };
    return value;
  }

  _computeBindings(manifest: ModelManifest): ModelBindings {
    const saved: LayoutModel = (this.card._layout && this.card._layout.model) || {};
    const savedLevels = { ...(this.card._config.model ? levelsFromFloorMap(this.card._config.model_floors) : {}), ...saved.levels };
    const haFloors = mergeFloors(this.card._hass, this.card._layout || {}); // HA floors plus layout-only floors
    return {
      manifest,
      levels: resolveLevels(manifest.levels, haFloors, savedLevels),
      rooms: resolveRoomAreas(manifest.rooms, Object.keys(this.card._hass.areas || {}), saved.rooms || {}),
      diff: bindingDiff(manifest, saved),
      notice: snapshotDiff(manifest, saved.known),
    };
  }
}
