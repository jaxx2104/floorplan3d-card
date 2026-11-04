// Mower layer of the floorplan view: the ground under plan points (model surface rays, cached), the
// mower map overlay, the warning sprite, the status chip and the driven track. Shown with the
// outdoors when a model is loaded.

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { outdoorShown } from '../views.js';
import { GroundCache } from '../surface.js';
import { planToWorld } from './core.js';

const MOWER_RAY_ABOVE_M = 1.5; // mower ground ray: starts this far over the lawn (overlay ground or floor)
const MOWER_RAY_M = 4.5; // ... and reaches 3 m below it

export class MowerLayer {
  constructor(view) {
    this.view = view;
    this.mapPlane = null;
    this._mapSeq = 0; // map processing run (results of older runs are dropped)
    this.warning = null; // { sprite, kind, floorId, timer }
    this.mowerChip = null; // { obj, floorId }
    this.mowerTrack = null; // { mesh, sig, floorId }
    this._ground = new GroundCache(); // ground seen from above the model, per 0.5 m cell (cleared with _surfMeshes)
    this._mowerGround = new GroundCache(); // ground under the mower: a bounded ray (eaves, canopies ignored)
    this._mapGround = null; // model ground under the map overlay centre
    this._groundLevel = null; // level id of the lawn under the map overlay
  }

  // World height of the model surface seen from above at plan (x, y) (cached per 0.5 m cell, one ray down
  // from over the model against the surface meshes: helpers, objects and glass ignored), or null.
  groundAt(x, y) {
    const g = this._groundHit(x, y);
    return g ? g.y : null;
  }

  // The ground height, else the floor's elevation (no model, or nothing under the point).
  groundHeight(x, y, floorId) {
    const g = this.groundAt(x, y);
    return g ?? this.view.floorElevation(floorId);
  }

  _groundHit(x, y) {
    if (!this.view.model) return null;
    return this._ground.get(x, y, this.view.model.id, (cx, cy) => this._groundRay(cx, cy));
  }

  // Ground under the mower (marker, model node, warning): a ray down from 1.5 m over the map overlay's
  // ground (else the floor's elevation), at most MOWER_RAY_M long, so roofs, eaves, carports and tree canopies
  // over the mower are ignored. Falls back to the ray from above the model when that finds nothing.
  mowerGround(x, y, floorId) {
    if (!this.view.model) return null;
    if (this.view.mowerOnFloor) return this.view.floorElevation(floorId); // indoors: a ray would land on tables and beds
    const base = this._mapGround ?? this.view.floorElevation(floorId);
    const key = `${this.view.model.id}|${base}`;
    const g = this._mowerGround.get(x, y, key, (cx, cy) => {
      const from = base + MOWER_RAY_ABOVE_M;
      const hit = this.view.modelLayer.surfaceRays([cx, from, -cy], [[0, -1, 0]], MOWER_RAY_M)[0];
      return hit ? hit.point[1] : this._groundHit(cx, cy)?.y ?? null;
    });
    return g;
  }

  // mowerGround, else the floor's elevation
  mowerHeight(x, y, floorId) {
    return this.mowerGround(x, y, floorId) ?? this.view.floorElevation(floorId);
  }

  _groundRay(x, y) {
    const meshes = this.view.modelLayer._surfaceMeshes();
    if (!meshes.length) return null;
    let top = -Infinity, bottom = Infinity;
    for (const { box } of meshes) {
      if (box.max.y > top) top = box.max.y;
      if (box.min.y < bottom) bottom = box.min.y;
    }
    const from = top + 1;
    const hit = this.view.modelLayer.surfaceRays([x, from, -y], [[0, -1, 0]], from - bottom + 1)[0];
    if (!hit) return null;
    let level = null;
    const levels = this.view.model.manifest.levels || [];
    for (let o = hit.object; o && !level; o = o.parent) level = levels.find((l) => l.node === o) || null;
    return { y: hit.point[1], level: level ? level.id : null };
  }

  // Map and marker of the mower: with a model, shown wherever the outdoors (an exterior level, or
  // the level holding the lawn) shows, whatever the mower's HA floor; else the floor rule.
  _mowerShows(floorId) {
    if (this.view.model) {
      const mv = this.view._modelVisibility;
      const o = outdoorShown(this.view.model.manifest.levels, mv && mv.index, mv && mv.flags, this._groundLevel);
      if (o !== null) return o;
    }
    return this.view._shows(floorId);
  }

  // Mower map image laid on the lawn. o: {url, x, y, rotation, width, opacity, floorId, heightOffset,
  // hidden} or null. x, y = image centre in plan metres, rotation in degrees counter-clockwise, top of
  // image = north. Height: the model surface under the centre + 2 cm (independent of the HA floor's
  // elevation), else the floor + 1.5 cm; plus heightOffset. hidden: loaded (detection reads it) but not drawn.
  setMapOverlay(o) {
    if (!o || !o.url) {
      if (this.mapPlane) {
        const u = this.mapPlane.userData;
        this.view.mowerGroup.remove(this.mapPlane);
        this.mapPlane.geometry.dispose();
        if (u.rawTex) u.rawTex.dispose();
        if (u.canvasTex) u.canvasTex.dispose();
        this.mapPlane.material.dispose();
        this.mapPlane = null;
        this.view.dirty = true;
      }
      this._mapGround = null;
      return;
    }
    if (!this.mapPlane) {
      // under objects: depth tested, pulled toward the camera against the lawn, drawn before other transparents
      const mat = new THREE.MeshBasicMaterial({
        transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      this.mapPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat);
      this.mapPlane.renderOrder = -1;
      this.mapPlane.visible = false; // until the first image arrives
      this.view.mowerGroup.add(this.mapPlane);
    }
    const plane = this.mapPlane;
    // per-push calls with the same overlay draw nothing
    const hit = this._groundHit(o.x || 0, o.y || 0); // cached: no ray per update
    const ground = hit ? hit.y : null;
    this._groundLevel = hit ? hit.level : null;
    this._mapGround = ground;
    const off = Number(o.heightOffset) || 0;
    const sig = [o.url, o.x, o.y, o.rotation, o.width, o.opacity, o.floorId, this.view.floorElevation(o.floorId), this.view._shows(o.floorId), ground, off, !!o.hidden].join('|');
    if (sig === plane.userData.sig) return;
    plane.userData.sig = sig;
    plane.userData.floorId = o.floorId;
    plane.userData.hidden = !!o.hidden;
    plane.position.copy(planToWorld(o.x || 0, o.y || 0, 0, 0));
    plane.position.y = (ground != null ? ground + 0.02 : this.view.floorElevation(o.floorId) + 0.015) + off;
    plane.rotation.y = ((o.rotation || 0) * Math.PI) / 180;
    plane.material.opacity = o.opacity ?? 0.6;
    const aspect = plane.userData.aspect || 1;
    const w = o.width || 20;
    plane.scale.set(w, 1, w * aspect);
    plane.userData.external = !!o.external;
    if (o.external) plane.userData.url = o.url; // the card draws the picture (setMapCanvas)
    if (plane.userData.url !== o.url) {
      plane.userData.url = o.url;
      // swap textures only once the new image has loaded, so camera refreshes don't flicker
      new THREE.TextureLoader().load(o.url, (tex) => {
        if (plane.userData.url !== o.url || this.mapPlane !== plane) { tex.dispose(); return; }
        tex.colorSpace = THREE.SRGBColorSpace;
        const old = plane.userData.rawTex;
        plane.userData.rawTex = tex;
        // the size may change between refreshes: aspect from this picture
        const W = tex.image.naturalWidth || tex.image.width, H = tex.image.naturalHeight || tex.image.height;
        plane.userData.aspect = H / W;
        plane.userData.loaded = { url: o.url, image: tex.image, at: Date.now() };
        plane.scale.set(w, 1, w * plane.userData.aspect);
        if (old && old !== tex && plane.material.map === old) { // shown raw: switch now, nothing stale
          plane.material.map = tex;
          plane.material.needsUpdate = true;
        }
        if (old && old !== tex) old.dispose();
        this._applyMapImage(plane); // shown once the picture (processed or as loaded) is in place
        this.view.dirty = true;
      }, undefined, () => console.warn('floorplan3d: could not load mower map', o.url));
    }
    if (plane.material.map) plane.visible = this._mapShown(plane);
    this.view.dirty = true;
  }

  // The loaded picture through onMapImage (image, width, height) -> (a promise of) { canvas, width,
  // height } | null | undefined: a processed canvas is drawn through one reused CanvasTexture (new only
  // when its size changes), null draws the picture as loaded, undefined keeps what is shown. Results of
  // an older run (a newer picture or reprocess started since) are dropped.
  _applyMapImage(plane) {
    const ld = plane.userData.loaded;
    if (!ld) return;
    const img = ld.image;
    const seq = (this._mapSeq = (this._mapSeq || 0) + 1);
    let res = null;
    try {
      res = this.view.onMapImage ? this.view.onMapImage(img, img.naturalWidth || img.width, img.naturalHeight || img.height) : null;
    } catch (e) {
      console.warn('floorplan3d: could not process the mower map', e);
    }
    const done = (r) => {
      if (seq !== this._mapSeq || this.mapPlane !== plane) return;
      this._setMapTexture(plane, r);
    };
    if (res && typeof res.then === 'function') {
      res.then(done, (e) => { console.warn('floorplan3d: could not process the mower map', e); done(null); });
    } else done(res);
  }

  _setMapTexture(plane, res) {
    if (res === undefined && plane.material.map) return;
    const mat = plane.material;
    let next = plane.userData.rawTex;
    if (res && res.canvas) {
      let ct = plane.userData.canvasTex;
      if (ct && (ct.image !== res.canvas || ct.userData.w !== res.width || ct.userData.h !== res.height)) {
        ct.dispose();
        ct = null;
      }
      if (!ct) {
        ct = new THREE.CanvasTexture(res.canvas);
        ct.colorSpace = THREE.SRGBColorSpace;
        ct.userData = { w: res.width, h: res.height };
        plane.userData.canvasTex = ct;
      }
      ct.needsUpdate = true;
      next = ct;
    }
    if (mat.map !== next) {
      mat.map = next;
      mat.needsUpdate = true;
    }
    plane.visible = this._mapShown(plane);
    this.view.dirty = true;
  }

  // External map (auto mode: the card decodes and processes the live map off the main thread): the
  // processed canvas (w x h) drawn for a picture of natW x natH; changed regions are already drawn into
  // it, so the one reused CanvasTexture is flagged once per batch. loaded: { image (raw picture for the
  // edit-mode pickers) | null, url }.
  setMapCanvas(canvas, natW, natH, loaded = null) {
    const plane = this.mapPlane;
    if (!plane || !plane.userData.external) return;
    const aspect = natH / natW;
    if (plane.userData.aspect !== aspect) {
      plane.userData.aspect = aspect;
      plane.scale.z = plane.scale.x * aspect;
    }
    const was = plane.userData.loaded;
    if (was && was.image && was.image !== (loaded && loaded.image) && was.image.close) was.image.close();
    plane.userData.loaded = { url: plane.userData.url, image: (loaded && loaded.image) || null, width: natW, height: natH, at: Date.now() };
    this._setMapTexture(plane, { canvas, width: canvas.width, height: canvas.height });
    this.view.stats.mapUploads = (this.view.stats.mapUploads || 0) + 1;
  }

  // Run the map processing again on the loaded picture (settings changed, no new image).
  reprocessMap() {
    if (this.mapPlane && this.mapPlane.userData.external) { if (this.view.onMapReprocess) this.view.onMapReprocess(); return; }
    if (this.mapPlane && this.mapPlane.userData.loaded) this._applyMapImage(this.mapPlane);
  }

  _mapShown(plane) {
    return !plane.userData.hidden && this._mowerShows(plane.userData.floorId);
  }

  // Warning over the mower: { kind: 'error' | 'stuck', x, y, floorId } or null. A world-size sprite 0.6 m
  // above the ground under the mower, pulsing at 2 Hz by a timer that exists only while it is shown
  // (the render loop stays idle otherwise).
  setMowerWarning(w) {
    const cur = this.warning;
    if (!w) {
      if (cur) {
        clearInterval(cur.timer);
        this.view.mowerGroup.remove(cur.sprite);
        cur.sprite.material.map.dispose();
        cur.sprite.material.dispose();
        this.warning = null;
        this.view.dirty = true;
      }
      return;
    }
    const y = this.mowerHeight(w.x, w.y, w.floorId) + 0.6;
    if (cur && cur.kind === w.kind) {
      const at = cur.sprite.position;
      if (at.x !== w.x || at.y !== y || at.z !== -w.y || cur.floorId !== w.floorId) {
        at.set(w.x, y, -w.y);
        cur.floorId = w.floorId;
        this._warningVisible();
        this.view.dirty = true;
      }
      return;
    }
    this.setMowerWarning(null);
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const col = w.kind === 'stuck' ? '#f5b800' : '#e53935';
    g.beginPath();
    g.moveTo(64, 10); g.lineTo(122, 112); g.lineTo(6, 112); g.closePath();
    g.fillStyle = col; g.fill();
    g.lineWidth = 8; g.lineJoin = 'round'; g.strokeStyle = '#ffffff'; g.stroke();
    g.fillStyle = w.kind === 'stuck' ? '#3a2e00' : '#ffffff';
    g.font = 'bold 66px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('!', 64, 80);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    sprite.scale.set(0.5, 0.5, 1);
    sprite.renderOrder = 20; // above objects
    sprite.position.set(w.x, y, -w.y);
    sprite.userData.helper = true; // never picked by the model ray
    sprite.raycast = () => {};
    this.view.mowerGroup.add(sprite);
    let bright = true;
    const timer = setInterval(() => {
      bright = !bright;
      sprite.material.opacity = bright ? 1 : 0.55;
      if (sprite.visible) this.view.dirty = true; // no frames for a warning on a hidden floor
    }, 500);
    this.warning = { sprite, kind: w.kind, floorId: w.floorId, timer };
    this._warningVisible();
    this.view.dirty = true;
  }

  // Chip next to the mower: { kind ('offline' | 'rain' | 'drying'), icon, text, x, y, floorId } or null.
  // A DOM label (CSS2D) 0.5 m above the ground under the mower; its element is removed with it.
  setMowerChip(c) {
    const cur = this.mowerChip;
    if (!c) {
      if (cur) { this.view.mowerGroup.remove(cur.obj); cur.obj.element.remove(); this.mowerChip = null; this.view.dirty = true; }
      return;
    }
    let obj = cur && cur.obj;
    if (!obj) {
      const el = document.createElement('div');
      el.innerHTML = '<ha-icon></ha-icon><span></span>';
      obj = new CSS2DObject(el);
      obj.userData.helper = true;
      obj.raycast = () => {};
      this.view.mowerGroup.add(obj);
      this.mowerChip = { obj };
    }
    const el = obj.element;
    el.className = `fp-mower-chip ${c.kind}`;
    const ic = el.querySelector('ha-icon');
    if (ic.getAttribute('icon') !== c.icon) ic.setAttribute('icon', c.icon);
    el.querySelector('span').textContent = c.text || '';
    obj.position.set(c.x, this.mowerHeight(c.x, c.y, c.floorId) + 0.5, -c.y);
    obj.visible = this._mowerShows(c.floorId);
    this.mowerChip.floorId = c.floorId;
    this.view.dirty = true;
  }

  _warningVisible() {
    this.warning.sprite.visible = this._mowerShows(this.warning.floorId);
  }

  // Path the mower drove: { segments: [[[x, y], ...], ...] (plan metres), floorId, color, width, opacity }
  // or null. A flat ribbon (one quad per step) 1 cm over the floor, rebuilt only when the points change.
  setMowerTrack(t) {
    const cur = this.mowerTrack;
    const sig = t ? JSON.stringify([t.segments, t.floorId, t.color, t.width, t.opacity]) : null;
    if (cur && cur.sig === sig) return;
    if (cur) {
      this.view.mowerGroup.remove(cur.mesh);
      cur.mesh.geometry.dispose();
      cur.mesh.material.dispose();
      this.mowerTrack = null;
      this.view.dirty = true;
    }
    if (!t || !t.segments || !t.segments.length) return;
    const y = this.view.floorElevation(t.floorId) + 0.01, half = (t.width || 0.05) / 2;
    const pos = [];
    for (const seg of t.segments) {
      for (let i = 1; i < seg.length; i++) {
        const [x0, y0] = seg[i - 1], [x1, y1] = seg[i];
        const len = Math.hypot(x1 - x0, y1 - y0);
        if (len < 1e-4) continue;
        const nx = (-(y1 - y0) / len) * half, ny = ((x1 - x0) / len) * half;
        // world (x, h, -y); two triangles per step
        const a = [x0 + nx, y, -(y0 + ny)], b = [x0 - nx, y, -(y0 - ny)], c = [x1 + nx, y, -(y1 + ny)], d = [x1 - nx, y, -(y1 - ny)];
        pos.push(...a, ...b, ...c, ...c, ...b, ...d);
      }
    }
    if (!pos.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(t.color || '#4fc3f7'), transparent: true, opacity: t.opacity ?? 0.7,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = -1;
    mesh.userData.helper = true; // never picked by the model ray
    mesh.raycast = () => {};
    mesh.visible = this._mowerShows(t.floorId);
    this.view.mowerGroup.add(mesh);
    this.mowerTrack = { mesh, sig, floorId: t.floorId };
    this.view.dirty = true;
  }

  // World position of the warning sprite while shown (the tap target), else null.
  warningWorld() {
    const w = this.warning;
    return w && w.sprite.visible ? w.sprite.position.clone() : null;
  }
}
