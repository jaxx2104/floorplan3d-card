// Contact shadows (every render quality, with a model): the soft dark grounding where furniture,
// walls and objects meet a floor. Per storey an orthographic camera at the floor looks up and draws every shadow
// caster from CONTACT_NEAR_M above it up as a darkness that fades to 0 at CONTACT_HEIGHT_M (the lowest surface
// wins the depth test). A back face first means the camera starts inside a solid standing on the floor (a wall,
// a cabinet, a table leg: their sides are edge-on from below and their bottoms lie in the floor): darkness 1.
// The result is blurred into one tile of an atlas. The patched model materials (cloud-shadow.ts,
// material userData.fpContact) look the atlas up on upward-facing surfaces at a storey's floor height and
// darken their ambient light (and a share of the direct light). The atlas is rebuilt only when the shadow
// casters change (model load, visibility, objects: RenderLook._shadowDirty), at the next frame; never per frame,
// and the frame itself costs one texture lookup on floor pixels.
//
// Why baked planes rather than the AO pass: AO is a separate opt-in (card option ao) that runs every frame;
// this is the same few-centimetre grounding at no per-frame cost, and it sees what is hidden from the camera
// (under a sofa seen from above). The tiers with contact shadows skip the AO pass (RenderLook.aoPass).
import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import type { Drawable } from "./view/core.ts";

/** Storeys (tiles) at most. */
export const CONTACT_MAX_FLOORS = 4;
/** Casters from this height (m) above the floor (below: rugs, the floor itself, slightly-off elevations). */
export const CONTACT_NEAR_M = 0.03;
/** The darkness of a caster fades to 0 at this height (m) above the floor. */
export const CONTACT_HEIGHT_M = 0.8;
/** The camera sees up to this far (m): the inside of tall solids (walls) is found from their back faces. */
export const CONTACT_FAR_M = 100;
/** A surface counts as the floor within this distance (m) of the storey's floor height. */
export const CONTACT_FLOOR_EPS_M = 0.03;
/** Darkness under a caster at the floor (share of the ambient light taken). */
export const CONTACT_STRENGTH = 0.7;
/** Share of the contact shade applied to direct light (lamps, sun) too. */
export const CONTACT_DIRECT = 0.7;
/** Target texel size (m) of a tile and its size bounds (px). */
export const CONTACT_TEXEL_M = 0.03;
export const CONTACT_TILE_MIN = 256;
export const CONTACT_TILE_MAX = 1024;
/** Margin (m) around a storey's footprint. */
export const CONTACT_MARGIN_M = 1;

/** A storey to ground: its floor height (world y) and footprint (world x / z bounds). */
export interface ContactFloor {
  y: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

// Tile size (px, power of two) for a footprint extent (m).
export function contactTileSize(extent: number): number {
  const px = Math.max(1, extent) / CONTACT_TEXEL_M;
  return Math.min(
    CONTACT_TILE_MAX,
    Math.max(CONTACT_TILE_MIN, 2 ** Math.ceil(Math.log2(px))),
  );
}

// Storeys to ground (at most CONTACT_MAX_FLOORS, lowest first): floors closer than CONTACT_HEIGHT_M to one
// already kept are dropped (a split level would shade itself).
export function contactFloors(floors: ContactFloor[]): ContactFloor[] {
  const out: ContactFloor[] = [];
  for (const f of [...floors]
    .filter((f) => Number.isFinite(f.y))
    .sort((a, b) => a.y - b.y)) {
    if (out.some((o) => Math.abs(o.y - f.y) < CONTACT_HEIGHT_M)) continue;
    out.push(f);
    if (out.length >= CONTACT_MAX_FLOORS) break;
  }
  return out;
}

/** Uniforms the patched materials read (shared, see makeCloudUniforms). */
export interface ContactUniforms {
  fpContactMap: THREE.IUniform<THREE.Texture | null>;
  fpContactM: THREE.IUniform<THREE.Matrix4[]>;
  fpContactY: THREE.IUniform<THREE.Vector4>;
  fpContact: THREE.IUniform<THREE.Vector2>;
}
export function makeContactUniforms(): ContactUniforms {
  return {
    fpContactMap: { value: null },
    fpContactM: {
      value: Array.from(
        { length: CONTACT_MAX_FLOORS },
        () => new THREE.Matrix4(),
      ),
    },
    fpContactY: { value: new THREE.Vector4() },
    fpContact: { value: new THREE.Vector2(0, CONTACT_STRENGTH) }, // tiles in use (0: off), strength
  };
}

// fragment head of the patched materials (needs vFpCloudW, the world position)
export const CONTACT_HEAD = /* glsl */ `
uniform sampler2D fpContactMap;
uniform mat4 fpContactM[ ${CONTACT_MAX_FLOORS} ];
uniform vec4 fpContactY;
uniform vec2 fpContact;
float fpContactShade( vec3 nView ) {
  if ( fpContact.x < 0.5 ) return 1.0;
  if ( ( vec4( nView, 0.0 ) * viewMatrix ).y < 0.7 ) return 1.0; // upward-facing surfaces only
  for ( int i = 0; i < ${CONTACT_MAX_FLOORS}; i ++ ) {
    if ( float( i ) >= fpContact.x ) break;
    if ( abs( vFpCloudW.y - fpContactY[ i ] ) > ${CONTACT_FLOOR_EPS_M.toFixed(3)} ) continue;
    vec2 uv = ( fpContactM[ i ] * vec4( vFpCloudW, 1.0 ) ).xy * 0.5 + 0.5;
    if ( uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0 ) continue;
    return 1.0 - fpContact.y * sqrt( texture2D( fpContactMap, vec2( ( float( i ) + uv.x ) / fpContact.x, uv.y ) ).r ); // sqrt: a wider skirt
  }
  return 1.0;
}
`;
// after #include <aomap_fragment>: the ambient light fully, the direct light in part
export const CONTACT_BODY = /* glsl */ `
{
  float fpC = fpContactShade( normalize( geometryNormal ) );
  reflectedLight.indirectDiffuse *= fpC;
  reflectedLight.indirectSpecular *= fpC;
  reflectedLight.directDiffuse *= mix( 1.0, fpC, ${CONTACT_DIRECT.toFixed(2)} );
}
`;

const CASTER_VERT = /* glsl */ `
uniform float floorY;
varying float vH;
void main() {
  vec4 p = vec4( position, 1.0 );
  #ifdef USE_INSTANCING
    p = instanceMatrix * p;
  #endif
  vec4 w = modelMatrix * p;
  vH = w.y - floorY;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const CASTER_FRAG = /* glsl */ `
varying float vH;
void main() {
  float t = clamp( vH / ${CONTACT_HEIGHT_M.toFixed(2)}, 0.0, 1.0 );
  gl_FragColor = vec4( vec3( gl_FrontFacing ? ( 1.0 - t ) * ( 1.0 - t ) : 1.0 ), 1.0 );
}`;
const BLUR_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }`;
// separable 9-tap gaussian inside one tile (samples clamped to it)
const BLUR_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 dir;
uniform vec2 tile; // index, count
uniform float size; // tile px
varying vec2 vUv;
void main() {
  float h = 0.5 / size, sum = 0.0, ws = 0.0;
  for ( int i = -4; i <= 4; i ++ ) {
    vec2 uv = clamp( vUv + float( i ) * dir / size, vec2( h ), vec2( 1.0 - h ) );
    float w = exp( - float( i * i ) / 8.0 );
    sum += texture2D( tSrc, vec2( ( tile.x + uv.x ) / tile.y, uv.y ) ).r * w;
    ws += w;
  }
  gl_FragColor = vec4( vec3( sum / ws ), 1.0 );
}`;

type Flags = {
  isMesh?: boolean;
  isPoints?: boolean;
  isLine?: boolean;
  isSprite?: boolean;
};

export class ContactShadows {
  renderer: THREE.WebGLRenderer;
  uniforms: ContactUniforms;
  /** the casters changed: rebuild before the next frame */
  stale: boolean;
  stats: { builds: number };
  tiles: number;
  size: number;
  atlas: THREE.WebGLRenderTarget;
  temp: THREE.WebGLRenderTarget;
  caster: THREE.ShaderMaterial;
  blur: THREE.ShaderMaterial;
  fsQuad: FullScreenQuad;
  camera: THREE.OrthographicCamera;

  constructor(renderer: THREE.WebGLRenderer, uniforms: ContactUniforms) {
    this.renderer = renderer;
    this.uniforms = uniforms;
    this.stale = true;
    this.stats = { builds: 0 };
    this.tiles = 0;
    this.size = 0;
    const opts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    };
    this.atlas = new THREE.WebGLRenderTarget(1, 1, {
      ...opts,
      depthBuffer: true,
    });
    this.temp = new THREE.WebGLRenderTarget(1, 1, {
      ...opts,
      depthBuffer: false,
    });
    this.caster = new THREE.ShaderMaterial({
      vertexShader: CASTER_VERT,
      fragmentShader: CASTER_FRAG,
      side: THREE.DoubleSide,
      uniforms: { floorY: { value: 0 } },
    });
    this.blur = new THREE.ShaderMaterial({
      vertexShader: BLUR_VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tSrc: { value: null },
        dir: { value: new THREE.Vector2() },
        tile: { value: new THREE.Vector2() },
        size: { value: 1 },
      },
    });
    this.fsQuad = new FullScreenQuad(this.blur);
    this.camera = new THREE.OrthographicCamera(
      -1,
      1,
      1,
      -1,
      CONTACT_NEAR_M,
      CONTACT_FAR_M,
    );
  }

  // Off: the materials skip the lookup.
  clear(): void {
    this.tiles = 0;
    this.uniforms.fpContact.value.x = 0;
  }

  // Draw the casters (visible meshes with castShadow) of the scene for these floors into the atlas.
  update(scene: THREE.Scene, floors: ContactFloor[]): void {
    this.stale = false;
    const list = contactFloors(floors);
    if (!list.length) {
      this.clear();
      return;
    }
    this.stats.builds++;
    const r = this.renderer,
      n = list.length;
    const size = Math.max(
      ...list.map((f) =>
        contactTileSize(Math.max(f.maxX - f.minX, f.maxZ - f.minZ)),
      ),
    );
    const max = r.capabilities.maxTextureSize || 4096;
    const tile = Math.min(size, 2 ** Math.floor(Math.log2(max / n)));
    if (this.atlas.width !== tile * n || this.atlas.height !== tile) {
      this.atlas.setSize(tile * n, tile);
      this.temp.setSize(tile * n, tile);
    }
    this.size = tile;
    const swapped: [Drawable, THREE.Material | THREE.Material[] | undefined][] =
        [],
      hidden: THREE.Object3D[] = [];
    scene.traverseVisible((obj) => {
      const o = obj as Drawable,
        f = obj as Flags;
      if (!(f.isMesh || f.isPoints || f.isLine || f.isSprite)) return;
      if (!f.isMesh || !obj.castShadow || (o.userData && o.userData.helper)) {
        o.visible = false;
        hidden.push(o);
        return;
      }
      swapped.push([o, o.material]);
      o.material = this.caster;
    });
    const prevTarget = r.getRenderTarget(),
      prevAutoClear = r.autoClear,
      prevShadow = r.shadowMap.needsUpdate;
    const clear = r.getClearColor(new THREE.Color()),
      clearAlpha = r.getClearAlpha();
    const bg = scene.background,
      env = scene.environment,
      fog = scene.fog;
    r.shadowMap.needsUpdate = false; // no shadow pass for this render
    r.autoClear = false;
    r.setClearColor(0x000000, 1);
    scene.background = null;
    scene.environment = null;
    scene.fog = null;
    const cam = this.camera,
      U = this.uniforms;
    try {
      list.forEach((f, i) => {
        const cx = (f.minX + f.maxX) / 2,
          cz = (f.minZ + f.maxZ) / 2;
        const hx = (f.maxX - f.minX) / 2 + CONTACT_MARGIN_M,
          hz = (f.maxZ - f.minZ) / 2 + CONTACT_MARGIN_M;
        cam.left = -hx;
        cam.right = hx;
        cam.top = hz;
        cam.bottom = -hz;
        cam.position.set(cx, f.y, cz);
        cam.up.set(0, 0, -1);
        cam.lookAt(cx, f.y + 1, cz);
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld();
        U.fpContactM.value[i].multiplyMatrices(
          cam.projectionMatrix,
          cam.matrixWorldInverse,
        );
        U.fpContactY.value.setComponent(i, f.y);
        this.caster.uniforms.floorY.value = f.y;
        this._tile(this.atlas, i);
        r.clear(true, true, false);
        r.render(scene, cam);
      });
    } finally {
      for (const [o, m] of swapped) o.material = m;
      for (const o of hidden) o.visible = true;
      scene.background = bg;
      scene.environment = env;
      scene.fog = fog;
      r.shadowMap.needsUpdate = prevShadow;
    }
    // two blur rounds: atlas -> temp (x) -> atlas (y)
    const u = this.blur.uniforms;
    u.size.value = tile;
    for (let round = 0; round < 2; round++) {
      for (const [src, dst, dx, dy] of [
        [this.atlas, this.temp, 1, 0],
        [this.temp, this.atlas, 0, 1],
      ] as const) {
        u.tSrc.value = src.texture;
        u.dir.value.set(dx, dy).multiplyScalar(round ? 2.5 : 1);
        for (let i = 0; i < n; i++) {
          u.tile.value.set(i, n);
          this._tile(dst, i);
          this.fsQuad.render(r);
        }
      }
    }
    this.atlas.scissorTest = false;
    this.temp.scissorTest = false;
    this.atlas.viewport.set(0, 0, this.atlas.width, this.atlas.height);
    this.temp.viewport.set(0, 0, this.temp.width, this.temp.height);
    r.setRenderTarget(prevTarget);
    r.setClearColor(clear, clearAlpha);
    r.autoClear = prevAutoClear;
    this.tiles = n;
    U.fpContactMap.value = this.atlas.texture;
    U.fpContact.value.set(n, CONTACT_STRENGTH);
  }

  // Bind a target with its viewport / scissor on tile i.
  _tile(target: THREE.WebGLRenderTarget, i: number): void {
    const s = this.size;
    target.viewport.set(i * s, 0, s, s);
    target.scissor.set(i * s, 0, s, s);
    target.scissorTest = true;
    this.renderer.setRenderTarget(target);
  }

  dispose(): void {
    this.clear();
    this.uniforms.fpContactMap.value = null;
    this.caster.dispose();
    this.blur.dispose();
    this.fsQuad.dispose();
    this.atlas.dispose();
    this.temp.dispose();
  }
}
