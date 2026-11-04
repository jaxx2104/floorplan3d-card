// Model objects as controls: bindings to HA entities, lamp / light pool updates, hit tests, tap / hold
// gestures, resolved actions (objects and markers), the object popup's content, tap hint dots and the
// desktop hover highlight.

import { tapHintsMode, reachability, hintAlpha, TOUCH_SHOW_MS } from '../objects/hints.js';
import { groupedHidden, groupedTapId, dockRows } from '../mower-track.js';
import { actionTarget, toggleCall } from '../objects/popup.js';
import { layoutTags, mowerTabEntity, bindObjects, effectiveGroups, screenByDistance } from '../objects/logic.js';
import { resolveActions } from '../actions.js';
import { typeOf } from '../objects/types.js';
import { deviceRows } from '../mower-device.js';
import { LONG_PRESS_MS, CLICK_SLOP_PX } from './constants.js';

const NONE = Object.freeze({}); // stable stand-in for a missing layout.objects / groups (binding cache key)
const TAP_TOGGLE = new Set(['light', 'switch', 'fan', 'input_boolean']);
const WARN_ID = '__mower_warning__'; // tap target of the warning when the mower is a marker, not a model object
const OBJECT_HIT_PX = { touch: 52, mouse: 30 };
const nodeShown = (n) => { for (let x = n; x; x = x.parent) if (!x.visible) return false; return true; };

export class ObjectInput {
  /** @param {object} card the Floorplan3dCard (host): read live, never captured */
  constructor(card) {
    this.card = card;
    this._bindings = new Map(); // object id -> binding (objects/logic.js bindObjects)
    this._boundEntities = new Set(); // entities bound to a model object: no marker of their own
    this._mowerObjectBound = false;
    this._groups = {}; // layout.groups whose controller exists in HA (objects/logic.js effectiveGroups)
    this._bindKey = null;
    this._tagsFor = undefined;
    this._gesture = undefined;
    this._hitWarning = undefined;
    this._hoverId = undefined;
    this._hoverRaf = undefined;
    this._hintKey = undefined;
    this._hintPtr = undefined;
    this._hintTouch = undefined;
    this._hintTouchTimer = undefined;
  }

  // Stage listeners (after the edit mode's): object taps in the capture phase, hints and hover.
  wire(stage, canvas) {
    // model objects: tap / hold, hit-tested on screen before markers and the canvas (capture phase)
    stage.addEventListener('pointerdown', (e) => this._objectDown(e, canvas), true);
    // tap hints (near the pointer) and the hover highlight of tappable objects; touch: hints for 3 s
    stage.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      this._hintPtr = { x: e.clientX, y: e.clientY, buttons: e.buttons, target: e.target };
      if (!this._hoverRaf) this._hoverRaf = requestAnimationFrame(() => { this._hoverRaf = null; this._hover(); this._hintsNear(); });
    });
    stage.addEventListener('pointerleave', () => { this._hintPtr = null; this._hover(); this._hintsNear(); });
    stage.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      this._hintTouch = performance.now() + TOUCH_SHOW_MS;
      this._hintsNear();
      clearTimeout(this._hintTouchTimer);
      this._hintTouchTimer = setTimeout(() => this._hintsNear(), TOUCH_SHOW_MS + 20);
    }, true);
  }

  // The labels arrived (card _fetchLabels): bindings are recomputed on the next update.
  resetBindKey() {
    this._bindKey = null;
  }

  // Entering / leaving edit mode: no hover highlight.
  clearHover() {
    if (!this._hoverId) return;
    this._hoverId = null;
    this.card._view.highlightModelNode(null);
    this.card._stage.classList.remove('fp-hover');
  }

  dispose() {
    this._endGesture();
    clearTimeout(this._hintTouchTimer);
    if (this._hoverRaf) { cancelAnimationFrame(this._hoverRaf); this._hoverRaf = null; }
  }

  // ObjectPopup resolve: the popup's content for an object id, null when it cannot show.
  popupResolve(id) {
    const card = this.card;
    const o = card._objects.objectAt(id);
    if (!o || !card._hass || (o.binding && o.binding.hidden)) return null;
    const extra = [];
    if (o.obj.type === 'mower') { // from the processed live map
      const mi = card.mapInfo();
      if (mi.stripes) extra.push({ kind: 'info', label: 'Stripes', value: mi.stripes });
      if (mi.mowed) extra.push({ kind: 'info', label: 'Mowed', value: mi.mowed });
      const wt = card._warningText();
      if (wt) extra.unshift({ kind: 'info', label: wt.label, value: wt.value });
      // docked: mower and dock are one object, the dock's rows (charging / docked, battery) join
      const grp = card._dockGroup();
      if (grp && grp.mower === id) {
        const dk = card._dockedNow(), mst = o.binding && o.binding.entity && card._hass.states[o.binding.entity];
        let bat = mst && mst.attributes ? mst.attributes.battery_level ?? null : null;
        if (bat === null && o.binding && o.binding.entity) { const r = deviceRows(card._hass, o.binding.entity).find((x) => x.key === 'battery'); bat = r ? parseFloat(r.value) : null; }
        extra.push(...dockRows(dk.word, bat));
      }
      // the mower's device entities (progress, rain, signal, zone ...): popup item 'device'
      const pl = this._objectActions(id, o).popup || (o.obj.ui && o.obj.ui.popup) || typeOf('mower').defaults.popup;
      if (Array.isArray(pl) && pl.includes('device') && o.binding && o.binding.entity) {
        const bst = card._hass.states[o.binding.entity];
        const skip = new Set(pl.includes('battery') && bst && bst.attributes && bst.attributes.battery_level !== undefined ? ['battery'] : []);
        if (mi.mowed) skip.add('progress');
        for (const r of deviceRows(card._hass, o.binding.entity)) if (!skip.has(r.key)) extra.push({ kind: 'info', label: r.label, value: r.value });
      }
    }
    return { obj: { ...o.obj, label: this.objectLabel(o.obj) }, chain: o.chain, states: card._hass.states, groups: this._groups, popup: this._objectActions(id, o).popup, popupSource: this._objectActions(id, o).popupSource, extra,
      badge: card._objectBadge(o.binding && o.binding.entity), dark: !!(card._built.theme && card._built.theme.dark) };
  }

  // Tap hint dots: every tappable object (as _objectHit counts them) with its reachability; cheap when
  // nothing changed (objects evaluated, placement, view, mode).
  _syncHints() {
    const hints = this.card._hints, layer = this.card._objects;
    if (!hints || !layer) return;
    const mode = tapHintsMode(this.card._layout);
    const on = mode !== 'off' && !!layer.model && !this.card._editing && !!this.card._hass;
    if (hints.setVisible(on)) this.card._view.markDirty();
    if (!on) return;
    const grp = this.card._dockGroup();
    const key = [layer.stats.evaluated, layer._labelSig, this.card._viewState, this.card._floorOnly, this._bindings, this._groups, mode, this.card._mode, grp ? grp.dock : null];
    if (this._hintKey && key.every((x, i) => x === this._hintKey[i])) return;
    this._hintKey = key;
    const levelShown = this._levelShown(), states = this.card._hass.states, groups = this._groups || {};
    const items = [];
    for (const a of layer.anchors()) {
      const o = layer.objectAt(a.id), b = o && o.binding;
      if (!b || b.hidden || groupedHidden(a.id, grp)) continue; // docked: the mower's dot stands for the dock too
      const own = this._objectHasOwnActions(a.id, o);
      if (!b.missing && !actionTarget(o.obj, b, groups) && !own) continue;
      if (!levelShown(o.obj.level) || !nodeShown(o.obj.node)) continue;
      const ok = own && !b.entity ? true : reachability(o.obj, b, o.chain, states, groups).ok;
      const r = o.result;
      items.push({ id: a.id, world: a.world, ok, color: r && r.lit && r.color ? r.color : null });
    }
    if (hints.setItems(items)) { this._hintsNear(true); this.card._view.markDirty(); }
  }

  // Dot fade: always shown, or near the pointer (touch: all of them for 3 s after a touch).
  _hintsNear(force = false) {
    const hints = this.card._hints;
    if (!hints || !hints.group.visible) return;
    const mode = tapHintsMode(this.card._layout);
    const touch = this._hintTouch && performance.now() < this._hintTouch;
    const p = this._hintPtr;
    if (mode === 'near' && !touch && !p && !force && hints._allZero) return;
    const changed = hints.setAlpha((it) => {
      if (mode === 'always' || touch) return 1;
      if (!p) return 0;
      const s = this.card._view.projectWorld(it.world);
      return s ? hintAlpha(Math.hypot(s[0] - p.x, s[1] - p.y)) : 0;
    });
    hints._allZero = mode === 'near' && !touch && !p;
    if (changed) this.card._view.markDirty();
  }

  // Desktop hover over a tappable object: its outline + a pointer cursor (view mode only).
  _hover() {
    const p = this._hintPtr;
    let id = null;
    if (p && !p.buttons && !this.card._editing && this._objectTapsOn() && !this._gesture && (p.target === this.card._view.renderer.domElement)) {
      id = this._objectHit(p.x, p.y, OBJECT_HIT_PX.mouse);
      if (id === WARN_ID) id = null;
    }
    if (id === this._hoverId) return;
    this._hoverId = id;
    const o = id && this.card._objects.objectAt(id);
    if (!this.card._editing) this.card._view.highlightModelNode(o ? o.obj.node : null);
    this.card._stage.classList.toggle('fp-hover', !!o);
  }

  // Object bindings, recomputed only when the model, layout.objects / groups or the existence of
  // a candidate entity changed. True when the set of bound entities (= hidden markers) changed.
  _syncBindings() {
    const model = this.card._objects && this.card._objects.model;
    const objs = model ? model.manifest.objects : [];
    const l = this.card._layout || {}, lo = l.objects || NONE, states = this.card._hass.states;
    if (!this._tagsFor || this._tagsFor[0] !== l.tags || this._tagsFor[1] !== l.groups) this._tagsFor = [l.tags, l.groups, layoutTags(l)];
    const groups = this._tagsFor[2]; // tag settings (old layout.groups included)
    const exists = objs.map((o) => {
      const e = lo[o.id] && lo[o.id].entity !== undefined ? lo[o.id].entity : (o.suggest || {}).entity;
      return e && states[e] ? 1 : 0;
    }).join('') + '|' + Object.values(groups).map((g) => (g && g.entity && states[g.entity] ? 1 : 0)).join('');
    const mowerEntity = mowerTabEntity(l.mower && l.mower.entity, this.card._hass.entities);
    // HA labels (default tags) live in the entity registry: hass.entities / hass.labels identity
    const key = [model, lo, groups, exists, mowerEntity && states[mowerEntity] ? mowerEntity : '', this.card._hass.entities, this.card._hass.labels || this.card._labels];
    if (this._bindKey && key.every((x, i) => x === this._bindKey[i])) return false;
    this._bindKey = key;
    this._bindings = bindObjects(objs, lo, states, { mowerEntity, hass: this.card._hass.labels || !this.card._labels ? this.card._hass : Object.create(this.card._hass, { labels: { value: this.card._labels } }) });
    this._groups = effectiveGroups(groups, states); // controllers HA doesn't know are ignored
    this.card._objects.setBindings(this._bindings, this._groups, { objects: lo, tags: groups }); // + "Light on wall" settings
    if (this._tagIndex() && this.card._index) { // tag: view rules follow the new tags
      this.card._viewCtl.refreshViewState();
      if (this.card._viewState && !this.card._floorOnly) this.card._applyViewVisibility();
    }
    const bound = new Set();
    for (const b of this._bindings.values()) if (b.entity && !b.hidden) bound.add(b.entity);
    // the mower marker depends on whether the mower object is bound (its entity may stay bound by the dock)
    const mower = this.card._objects.mowerBound();
    const changed = bound.size !== this._boundEntities.size || [...bound].some((e) => !this._boundEntities.has(e)) || mower !== this._mowerObjectBound;
    this._boundEntities = bound;
    this._mowerObjectBound = mower;
    return changed;
  }

  // Every object's tags into the view index (tag: selectors). True when a tag changed.
  _tagIndex() {
    if (!this.card._index) return false;
    let changed = false;
    for (const n of this.card._index.nodes) {
      if (!n.tag || n.tag.kind !== 'object') continue;
      const b = this._bindings && this._bindings.get(n.tag.id);
      const tags = b && b.tags ? b.tags : null;
      if (JSON.stringify(tags) !== JSON.stringify(n.tag.tags || null)) { n.tag.tags = tags; changed = true; }
    }
    return changed;
  }

  // Lamps and the light pool for the current states and view (cheap when nothing changed).
  _updateObjects() {
    const layer = this.card._objects;
    if (!layer || !layer.model || !this.card._hass || !this.card._config) return;
    layer.update(this.card._hass.states, { visibleLevel: this._levelShown(), lightsOn: this.card._config.lights !== 'off' });
    this._syncHints();
  }

  _levelShown() {
    const levels = (this.card._objects.model && this.card._objects.model.manifest.levels) || [];
    return (id) => { const lv = levels.find((x) => x.id === id); return !lv || nodeShown(lv.node); };
  }

  // Object taps: view mode; in edit mode only on the Objects tab.
  _objectTapsOn() {
    return !this.card._editing || (this.card._edit && this.card._edit.tab === 'objects');
  }

  // The nearest tappable object (visible, bound, not hidden, level shown) within radius px of a client point.
  _objectHit(x, y, radius, all = false) {
    const layer = this.card._objects;
    this._hitWarning = false;
    if (!all && this.card._hass) { // the warning sprite stands for the mower object (or the mower marker)
      const w = this.card._view.warningWorld(), p = w && this.card._view.projectWorld(w);
      if (p && Math.hypot(p[0] - x, p[1] - y) <= radius) {
        this._hitWarning = true;
        return (layer && layer.mowerId()) || WARN_ID;
      }
    }
    if (!layer || !layer.model || !this.card._hass) return null;
    const groups = this._groups || {};
    const levelShown = this._levelShown();
    const pts = [];
    for (const a of layer.anchors()) {
      const o = layer.objectAt(a.id);
      const b = o && o.binding;
      if (!all && (!b || b.hidden || (!b.missing && !actionTarget(o.obj, b, groups) && !this._objectHasOwnActions(a.id, o)))) continue;
      if (!levelShown(o.obj.level) || !nodeShown(o.obj.node)) continue;
      const p = this.card._view.projectWorld(a.world);
      if (p) pts.push({ id: a.id, x: p[0], y: p[1], world: a.world, node: o.obj.node });
    }
    // nearest first; one hidden behind visible model geometry (a lamp behind a facade wall) is skipped
    const byId = new Map(pts.map((p) => [p.id, p]));
    const grp = all ? null : this.card._dockGroup(); // docked (view mode): a tap on the dock is a tap on the mower
    for (const id of screenByDistance(pts, x, y, radius)) {
      const p = byId.get(id);
      if (!this.card._view.pointHidden(p.world, p.node)) return groupedTapId(id, grp);
    }
    return null;
  }

  // Tap = moved < 5 px; hold 500 ms (not moved) = hold action. Orbit still starts from the canvas.
  _objectDown(e, canvas) {
    if (this._gesture) { this._endGesture(); return; } // a second finger: pinch / orbit, no tap
    const path = e.composedPath();
    if (this.card._popup.closedBy === e) { // this tap closed the popup: no object or marker tap (orbit may start)
      if (e.target !== canvas && !path.some((n) => n.classList && n.classList.contains('toolbar'))) e.stopPropagation();
      return;
    }
    if (!this._objectTapsOn() || e.button !== 0 || !e.isPrimary) return;
    if ((this.card._popup.el && path.includes(this.card._popup.el)) || path.some((n) => n.classList && n.classList.contains('toolbar'))) return;
    const id = this._objectHit(e.clientX, e.clientY, e.pointerType === 'touch' ? OBJECT_HIT_PX.touch : OBJECT_HIT_PX.mouse, this.card._editing);
    if (!id) return; // markers and the model as before
    if (e.target !== canvas) e.stopPropagation(); // the object wins over a marker under the finger
    const g = { id, x: e.clientX, y: e.clientY, pointerId: e.pointerId, long: false };
    // edit mode (Objects tab): a tap selects the object's row; no hold action
    g.warn = this._hitWarning;
    if (!this.card._editing && !g.warn) {
      g.timer = setTimeout(() => {
        g.long = true;
        g.timer = null;
        this._runObjectAction(id, 'hold');
      }, LONG_PRESS_MS);
    }
    g.move = (ev) => {
      if (ev.pointerId === g.pointerId && Math.hypot(ev.clientX - g.x, ev.clientY - g.y) >= CLICK_SLOP_PX) this._endGesture();
    };
    g.up = (ev) => {
      if (ev.pointerId !== g.pointerId) return;
      const tap = !g.long && Math.hypot(ev.clientX - g.x, ev.clientY - g.y) < CLICK_SLOP_PX;
      this._endGesture();
      if (tap) {
        if (g.warn) { if (id === WARN_ID) this.card._moreInfo(this.card._mowerStateEntity()); else this._openObjectPopup(id); } // the warning always opens the mower popup
        else if (this.card._editing) this.card._edit.selectObject(id);
        else this.card._taps.tap(`object:${id}`, !!this._objectActions(id).double_tap, () => this._runObjectAction(id, 'tap'), () => this._runObjectAction(id, 'double_tap'));
      }
    };
    g.cancel = () => this._endGesture();
    g.menu = (ev) => ev.preventDefault(); // a touch hold opens no context menu
    window.addEventListener('pointermove', g.move, true);
    window.addEventListener('pointerup', g.up, true);
    window.addEventListener('pointercancel', g.cancel, true);
    window.addEventListener('contextmenu', g.menu, true);
    this._gesture = g;
  }

  _endGesture() {
    const g = this._gesture;
    if (!g) return;
    this._gesture = null;
    clearTimeout(g.timer);
    window.removeEventListener('pointermove', g.move, true);
    window.removeEventListener('pointerup', g.up, true);
    window.removeEventListener('pointercancel', g.cancel, true);
    // the contextmenu of a touch hold follows the pointerup
    setTimeout(() => window.removeEventListener('contextmenu', g.menu, true), 400);
  }

  // Objects tab "Test": the tap toggle (own entity, else the group controller). False when nothing can be toggled.
  testObject(id) {
    const o = this.card._objects && this.card._objects.objectAt(id);
    if (!o || !this.card._hass) return false;
    const target = actionTarget(o.obj, o.binding, this._groups || {}, this.card._hass.states);
    const st = target && this.card._hass.states[target];
    if (!st || st.state === 'unavailable' || st.state === 'unknown') return false;
    this.card._callService(...toggleCall(target));
    return true;
  }

  // Resolved actions of an object: type defaults < model fp.ui < layout ui (Objects tab) < YAML actions.
  _objectActions(id, o = this.card._objects && this.card._objects.objectAt(id)) {
    if (!o) return resolveActions({});
    const entity = (o.binding && o.binding.entity) || null;
    const reg = entity && this.card._hass && this.card._hass.entities && this.card._hass.entities[entity];
    return resolveActions({
      modelUi: o.obj.ui, layoutUi: (((this.card._layout && this.card._layout.objects) || {})[id] || {}).ui, yaml: this.card._config.actions,
      kind: 'object', id, entityId: entity, deviceId: (reg && reg.device_id) || null, typeDefaults: typeOf(o.obj.type).defaults,
      tags: (o.binding && o.binding.tags) || null,
    });
  }

  // An unbound object is still tappable when an action needs no entity (navigate, url, perform-action, assist).
  _objectHasOwnActions(id, o) {
    const a = this._objectActions(id, o);
    return [a.tap, a.hold, a.double_tap].some((x) => x && (['navigate', 'url', 'perform-action', 'assist'].includes(x.action) || x.entity));
  }

  _markerActions(m) {
    return resolveActions({
      yaml: this.card._config.actions, kind: 'marker', id: m.id, entityId: m.entityId, deviceId: m.deviceId,
      typeDefaults: { tap_action: { action: TAP_TOGGLE.has(m.domain) ? 'toggle' : 'more-info' }, hold_action: { action: 'more-info' } },
    });
  }

  // toggle / more-info on the object's entity (own, else the group controller); nothing usable
  // (missing / unavailable): the popup says so.
  _runObjectAction(id, which) {
    const o = this.card._objects.objectAt(id);
    if (!o || !this.card._hass) return;
    const action = this._objectActions(id, o)[which];
    if (!action || action.action === 'none') return;
    if (which !== 'hold' && action.action === 'toggle' && !action.entity) {
      // unreachable (offline / a controller off): no toggle, say why; hold still opens the popup
      const r = reachability(o.obj, o.binding, o.chain, this.card._hass.states, this._groups || {});
      if (!r.ok) { this.card._toast(r.reason); return; }
    }
    const target = actionTarget(o.obj, o.binding, this._groups || {}, this.card._hass.states);
    const st = target && this.card._hass.states[target];
    const usable = st && st.state !== 'unavailable' && st.state !== 'unknown';
    const onTarget = (action.action === 'toggle' || action.action === 'more-info') && !action.entity;
    if (action.action === 'popup' || (onTarget && !usable)) this._openObjectPopup(id, o);
    else this.card._runAction(action, { entity: target, objectId: id });
  }

  _openObjectPopup(id, o = this.card._objects.objectAt(id)) {
    const a = o && this.card._objects.anchors().find((x) => x.id === id);
    if (a) this.card._popup.open({ ...o.obj, label: this.objectLabel(o.obj) }, a.world);
  }

  _runMarkerAction(m, which) {
    const action = this._markerActions(m)[which];
    if (!action || action.action === 'none' || !this.card._hass) return;
    this.card._runAction(action.action === 'popup' ? { ...action, action: 'more-info' } : action, { entity: m.entityId });
  }

  // An object's label: layout.objects[id].label (Objects tab), else the model's.
  objectLabel(obj) {
    if (!obj) return '';
    const saved = this.card._layout && this.card._layout.objects && this.card._layout.objects[obj.id];
    return (saved && typeof saved.label === 'string' && saved.label) || obj.label || obj.id;
  }
}
