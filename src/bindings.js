// Bindings between a model's manifest and Home Assistant: which HA floor shows each level,
// which HA area each room/zone is. Saved choices live in layout.model.levels / .rooms; anything
// not saved is derived here, so re-exports and HA changes never need manual repair.

const SHOW = ['with', 'only', 'always', 'hidden', 'all-only'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && v.constructor === Object;

export function levelsFromFloorMap(map) {
  if (!isPlainObject(map)) return {};
  const out = {};
  for (const [id, v] of Object.entries(map)) {
    if (typeof v !== 'string') continue;
    out[id] = v === 'always' || v === 'hidden' ? { show: v } : { floor: v };
  }
  return out;
}

export function migrateModel(model) {
  if (!isPlainObject(model) || !('floor_map' in model)) return model;
  const { floor_map: fm, ...rest } = model;
  return { ...rest, levels: { ...levelsFromFloorMap(fm), ...model.levels } };
}

const byOrder = (a, b) => {
  // legacy models without order/elevation: stack bottom-up by their lowest point
  if (a.order == null && b.order == null && a.elevation == null && b.elevation == null) return (a.minY || 0) - (b.minY || 0);
  const aOrd = a.order ?? (a.role === 'basement' ? -1 : 0);
  const bOrd = b.order ?? (b.role === 'basement' ? -1 : 0);
  return aOrd - bOrd;
};

export function resolveLevels(levels, floors, saved = {}) {
  const safeSaved = isPlainObject(saved) ? saved : {};
  const ids = new Set(floors.map((f) => f.id));
  const out = {};
  const stale = new Set();
  for (const l of levels) {
    const s = safeSaved[l.id];
    if (!isPlainObject(s)) continue;
    if (s.show && SHOW.includes(s.show) && s.show !== 'with' && s.show !== 'only') {
      out[l.id] = { show: s.show, floor: ids.has(s.floor) ? s.floor : null, auto: false };
    } else if (s.floor === null && !s.show) {
      out[l.id] = { show: 'always', floor: null, auto: false }; // "belongs to no HA floor"
    } else if (ids.has(s.floor)) {
      out[l.id] = { show: s.show === 'only' ? 'only' : 'with', floor: s.floor, auto: false };
    } else {
      stale.add(l.id); // saved floor was deleted in HA: fall back to the defaults below
    }
  }
  for (const l of levels) if (!out[l.id] && ids.has(l.id)) out[l.id] = { show: 'with', floor: l.id, auto: true };

  // only with/only bindings reserve a floor; pinned always/hidden/all-only keep their floor for zones only
  const used = new Set(Object.values(out).filter((v) => v.show === 'with' || v.show === 'only').map((v) => v.floor).filter(Boolean));
  const storeys = levels.filter((l) => !out[l.id] && (l.role === 'storey' || l.role === 'basement')).sort(byOrder);
  const free = floors.filter((f) => !used.has(f.id)).sort((a, b) => a.elevation - b.elevation);
  // align the model's order 0 with HA's floor at elevation 0 (a basement must not take the ground floor)
  const k = storeys.findIndex((l) => (l.order ?? null) === 0);
  const j = free.findIndex((f) => f.elevation === 0);
  const shift = k >= 0 && j >= 0 ? j - k : 0;
  storeys.forEach((l, i) => {
    const f = free[i + shift];
    out[l.id] = f ? { show: 'with', floor: f.id, auto: true } : { show: 'always', floor: null, auto: true };
  });

  // the exterior goes with the lowest above-ground storey's floor (not a basement)
  const storeyFloors = levels.filter((l) => (l.role === 'storey' || l.role === 'basement') && out[l.id] && out[l.id].floor)
    .map((l) => floors.find((f) => f.id === out[l.id].floor));
  const byElev = (a, b) => a.elevation - b.elevation;
  const ground = storeyFloors.filter((f) => f.elevation >= 0).sort(byElev)[0] || storeyFloors.sort(byElev)[0]
    || floors.slice().sort(byElev)[0];
  const groundFloor = ground ? ground.id : null;
  for (const l of levels) {
    if (out[l.id]) continue;
    if (l.role === 'roof') out[l.id] = { show: 'all-only', floor: null, auto: true };
    else if (l.role === 'exterior') out[l.id] = { show: 'always', floor: groundFloor, auto: true };
    else out[l.id] = { show: 'always', floor: null, auto: true };
  }
  for (const id of stale) out[id] = { ...out[id], stale: true };
  return out;
}

// Visibility of a model level for the selected floor ('all' or a floor id). `with` stacks:
// shown on its floor and on every floor above it (by elevation).
export function levelVisible(assign, visibleFloor, elevationOf) {
  if (!assign) return true;
  if (assign.show === 'hidden') return false;
  if (assign.show === 'always') return true;
  if (assign.show === 'all-only') return visibleFloor === 'all';
  if (visibleFloor === 'all' || visibleFloor === assign.floor) return true;
  if (assign.show === 'only') return false;
  const a = elevationOf && elevationOf(assign.floor);
  const v = elevationOf && elevationOf(visibleFloor);
  return a !== undefined && a !== null && v !== undefined && v !== null && a < v;
}

export function resolveRoomAreas(rooms, areaIds, saved = {}) {
  const safeSaved = isPlainObject(saved) ? saved : {};
  const areas = new Set(areaIds);
  const out = {};
  for (const r of rooms) {
    const s = safeSaved[r.id];
    if (isPlainObject(s) && 'area' in s && (s.area === null || areas.has(s.area))) { out[r.id] = { area: s.area, auto: false }; continue; }
    const sug = r.suggest && r.suggest.area;
    const area = sug && areas.has(sug) ? sug : areas.has(r.id) ? r.id : null;
    out[r.id] = isPlainObject(s) && 'area' in s ? { area, auto: true, stale: true } : { area, auto: true };
  }
  return out;
}

export function transformPoint([x, y], { position = [0, 0, 0], rotation = 0, scale = 1 } = {}) {
  const a = (rotation * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const px = x * scale, py = y * scale;
  return [px * c - py * s + (position[0] || 0), px * s + py * c + (position[1] || 0)];
}

// Inverse of transformPoint: world plan point -> model plan point.
export function inverseTransformPoint([x, y], { position = [0, 0, 0], rotation = 0, scale = 1 } = {}) {
  const a = (rotation * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const dx = x - (position[0] || 0), dy = y - (position[1] || 0);
  const k = scale || 1;
  return [(dx * c + dy * s) / k, (-dx * s + dy * c) / k];
}

export function modelRooms(rooms, levelAssign, roomAreas, align) {
  const safeLevelAssign = isPlainObject(levelAssign) ? levelAssign : {};
  const safeRoomAreas = isPlainObject(roomAreas) ? roomAreas : {};
  const out = [];
  for (const r of rooms) {
    const lv = safeLevelAssign[r.level];
    if (!r.outline || !lv || !lv.floor || lv.show === 'hidden') continue; // levels without an HA floor or hidden carry no rooms
    out.push({
      id: 'm:' + r.id, modelId: r.id, label: r.label,
      area_id: safeRoomAreas[r.id] ? safeRoomAreas[r.id].area : null,
      floor_id: lv.floor,
      polygon: r.outline.map((p) => transformPoint(p, align)),
      doors: (r.doors || []).map((p) => transformPoint(p, align)),
      outdoor: r.kind === 'zone',
      fromModel: true,
    });
  }
  return out;
}

export function combineRooms(drawn, fromModel) {
  const covered = new Set(fromModel.map((r) => r.area_id).filter(Boolean));
  return [...fromModel, ...(drawn || []).filter((r) => !covered.has(r.area_id))];
}

export function levelFloorOverrides(levels, levelAssign, { position = [0, 0, 0], scale = 1 } = {}) {
  const safeLevelAssign = isPlainObject(levelAssign) ? levelAssign : {};
  const out = [];
  const done = new Set();
  for (const l of levels) {
    const a = safeLevelAssign[l.id];
    if (l.role === 'exterior' || l.role === 'roof' || !a || (a.show !== 'with' && a.show !== 'only') || !a.floor || done.has(a.floor)) continue;
    if (l.elevation === null || l.elevation === undefined) continue;
    done.add(a.floor);
    const o = { id: a.floor, elevation: Math.round((l.elevation * scale + (position[2] || 0)) * 1000) / 1000 };
    if (l.height) o.height = Math.round(l.height * scale * 1000) / 1000;
    out.push(o);
  }
  return out;
}

export function bindingDiff(manifest, model) {
  const one = (entries, saved) => {
    const ids = new Set((Array.isArray(entries) ? entries : []).map((e) => e.id));
    const keys = Object.keys(isPlainObject(saved) ? saved : {});
    return {
      kept: [...ids].filter((id) => keys.includes(id)),
      added: [...ids].filter((id) => !keys.includes(id)),
      missing: keys.filter((id) => !ids.has(id)),
    };
  };
  const safeManifest = isPlainObject(manifest) ? manifest : {};
  return { levels: one(safeManifest.levels, model && model.levels), rooms: one(safeManifest.rooms, model && model.rooms) };
}

// Compare the manifest with the snapshot of ids the user has already seen ({ levels: [], rooms: [] }).
// No snapshot means nothing to report.
export function snapshotDiff(manifest, known) {
  const one = (entries, ids) => {
    const cur = (Array.isArray(entries) ? entries : []).map((e) => e.id);
    if (!Array.isArray(ids)) return { added: [], missing: [] };
    return { added: cur.filter((id) => !ids.includes(id)), missing: ids.filter((id) => !cur.includes(id)) };
  };
  const m = isPlainObject(manifest) ? manifest : {};
  const k = isPlainObject(known) ? known : {};
  return { levels: one(m.levels, k.levels), rooms: one(m.rooms, k.rooms) };
}

// Elevation/height for levels the model did not tag with numbers, measured from their geometry.
export function measuredElevations(levels) {
  const storeys = levels.filter((l) => (l.role === 'storey' || l.role === 'basement')).slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.minY ?? 0) - (b.minY ?? 0));
  const snap = (v) => Math.round(v / 0.05) * 0.05;
  const r3 = (v) => Math.round(v * 1000) / 1000 + 0;
  const ground = storeys.find((l) => l.role === 'storey' && (l.minY ?? 0) <= 0.5) || storeys.find((l) => l.role === 'storey');
  const elev = (l) => (Number.isFinite(l.elevation) ? l.elevation : l === ground ? ((l.minY ?? 0) <= 0.5 ? 0 : Math.max(0, Math.round(l.minY))) : snap(l.minY ?? 0));
  const out = {};
  storeys.forEach((l, i) => {
    if (Number.isFinite(l.elevation)) return;
    const e = elev(l);
    const next = storeys[i + 1];
    out[l.id] = { elevation: r3(e), height: next ? r3(elev(next) - e) : 2.7 };
  });
  return out;
}
