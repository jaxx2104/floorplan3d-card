// Cloud shadows: the weather shown on the model itself. The 3D camera looks down past the horizon,
// so clouds in the sky are rarely on screen; their shadows drift over the surroundings instead (lit
// model materials shade the directional lights - sun, moon - by world x/z; lamps are untouched),
// never inside the rooms (a mask of the room footprints, from the floor up), where the sun gets the
// average dimming instead. Uniforms only after the one-time material patch.
import * as THREE from 'three';

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// World size (m) of one tile of the shadow pattern, wind speed (m/s) and direction (unit x/z).
export const CLOUD_TILE_M = 56;
export const CLOUD_WIND_MS = 1.5;
export const CLOUD_WIND = [0.8, 0.6];
// Direct sunlight left under a cloud (the rest of the light there is the sky's).
export const CLOUD_UMBRA = 0.1;

// Shadow parameters for coverage (%): { cover: pattern threshold, about the share of the ground in
// shade (higher = fewer patches), strength: how much of the direct light a cloud takes, roomShade:
// the direct light in the rooms (no patches there: the average dimming, cloudLight's sun factor) }.
// With the shadows on, the sun itself stays at its clear-sky strength: sunny gaps between the patches.
export function cloudShadowParams(coverage, roomShade = 1) {
  const c = clamp01((Number(coverage) || 0) / 100);
  return { cover: 1 - c, strength: c > 0 ? 1 - CLOUD_UMBRA : 0, roomShade: c > 0 ? clamp01(Number(roomShade)) : 1 };
}

// Pattern offset (tiles) after t seconds of wind.
export function cloudShadowOffset(t) {
  const d = ((Number(t) || 0) * CLOUD_WIND_MS) / CLOUD_TILE_M;
  return [-(CLOUD_WIND[0] * d) % 1, -(CLOUD_WIND[1] * d) % 1];
}

// Room mask frame: the x/z bounds (card world: x, -y) of the room polygons plus a margin, as
// { minX, minZ, sizeX, sizeZ }, or null without rooms.
export function roomMaskFrame(polygons, margin = 0.3) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const poly of polygons || []) {
    for (const [x, y] of poly) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, -y); maxZ = Math.max(maxZ, -y);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minX: minX - margin, minZ: minZ - margin, sizeX: maxX - minX + 2 * margin, sizeZ: maxZ - minZ + 2 * margin };
}

// Uniforms shared by every patched material.
export function makeCloudUniforms() {
  return {
    fpCloudMap: { value: null },
    fpCloudOffset: { value: new THREE.Vector2() },
    fpCloudTile: { value: CLOUD_TILE_M },
    fpCloudCover: { value: 1 },
    fpCloudStrength: { value: 0 },
    fpRoomShade: { value: 1 },
    fpRoomMask: { value: null },
    fpRoomFrame: { value: new THREE.Vector4(0, 0, 0, 0) }, // minX, minZ, sizeX, sizeZ (size 0: no rooms)
    fpRoomFloor: { value: 0 }, // world y from which the mask applies (below: facade under the flat)
    // surroundings light (card option surround_light): sky / ground irradiance outside the rooms only
    fpOutSky: { value: new THREE.Color(0, 0, 0) },
    fpOutGround: { value: new THREE.Color(0, 0, 0) },
    // city lights at night (card option city_lights): 0..1, the site's ground height, and
    // [share of lit windows, window strength, street lamp strength, strength of the lit glass]
    fpCity: { value: 0 },
    fpCityGround: { value: 0 },
    fpCityParams: { value: new THREE.Vector4(0.45, 0.6, 1.2, 0.35) },
    // plants in the wind (card option sway): time (s), lean (m at SWAY_HEIGHT_M above the ground), wind direction
    fpTime: { value: 0 },
    fpSway: { value: 0 },
    fpWindDir: { value: new THREE.Vector2(...CLOUD_WIND) },
  };
}

// Height (m above the site's ground) where the sway reaches its full lean; below it grows with the square.
export const SWAY_HEIGHT_M = 8;

const VERT_HEAD = 'varying vec3 vFpCloudW;\n';
// plants sway in world x / z with the wind (two waves and a steady lean), more the higher they reach, never in
// the rooms (indoor plants share materials with the ones outside); the parts of a plant move together
const SWAY_HEAD = `
uniform float fpTime;
uniform float fpSway;
uniform vec2 fpWindDir;
uniform float fpCityGround;
uniform sampler2D fpRoomMask;
uniform vec4 fpRoomFrame;
uniform float fpRoomFloor;
`;
const SWAY_BODY = `
  if ( fpSway > 0.0 ) {
    vec4 fpSw = modelMatrix * vec4( transformed, 1.0 );
    float fpIn = 0.0;
    if ( fpRoomFrame.z > 0.0 && fpSw.y >= fpRoomFloor ) {
      vec2 fpM = ( fpSw.xz - fpRoomFrame.xy ) / fpRoomFrame.zw;
      if ( fpM.x >= 0.0 && fpM.y >= 0.0 && fpM.x <= 1.0 && fpM.y <= 1.0 ) fpIn = texture2D( fpRoomMask, fpM ).r;
    }
    float fpH = clamp( ( fpSw.y - fpCityGround ) / ${SWAY_HEIGHT_M.toFixed(1)}, 0.0, 1.0 );
    float fpPh = dot( fpSw.xz, vec2( 0.21, 0.17 ) );
    float fpWave = 0.3 + 0.45 * sin( fpTime * 1.3 + fpPh ) + 0.25 * sin( fpTime * 3.1 + fpPh * 1.7 );
    vec2 fpD = fpWindDir * fpWave * fpSway * fpH * fpH * ( 1.0 - fpIn );
    transformed += ( vec4( fpD.x, 0.0, fpD.y, 0.0 ) * modelMatrix ).xyz; // world -> local (rotation, scale 1)
  }
`;
const VERT_BODY = `
  vec4 fpCloudW = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    fpCloudW = instanceMatrix * fpCloudW;
  #endif
  vFpCloudW = ( modelMatrix * fpCloudW ).xyz;
`;
const FRAG_HEAD = `
varying vec3 vFpCloudW;
uniform sampler2D fpCloudMap;
uniform vec2 fpCloudOffset;
uniform float fpCloudTile;
uniform float fpCloudCover;
uniform float fpCloudStrength;
uniform float fpRoomShade;
uniform sampler2D fpRoomMask;
uniform vec4 fpRoomFrame;
uniform float fpRoomFloor;
uniform vec3 fpOutSky;
uniform vec3 fpOutGround;
uniform float fpCity;
uniform float fpCityGround;
uniform vec4 fpCityParams;
float fpHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
// 1 inside [lo, hi], antialiased over a pixel
float fpBand( float x, float lo, float hi ) {
  float w = max( fwidth( x ), 1e-4 );
  return clamp( ( x - lo ) / w + 0.5, 0.0, 1.0 ) * clamp( ( hi - x ) / w + 0.5, 0.0, 1.0 );
}
vec3 fpWindowTint( float h ) {
  return h < 0.6 ? vec3( 1.0, 0.66, 0.36 ) : h < 0.88 ? vec3( 1.0, 0.8, 0.58 ) : vec3( 0.8, 0.86, 1.0 );
}
float fpRoom() {
  if ( fpRoomFrame.z <= 0.0 || vFpCloudW.y < fpRoomFloor ) return 0.0;
  vec2 m = ( vFpCloudW.xz - fpRoomFrame.xy ) / fpRoomFrame.zw;
  if ( m.x < 0.0 || m.y < 0.0 || m.x > 1.0 || m.y > 1.0 ) return 0.0;
  return texture2D( fpRoomMask, m ).r;
}
float fpCloudShade() {
  if ( fpCloudStrength <= 0.0 ) return 1.0;
  float n = texture2D( fpCloudMap, vFpCloudW.xz / fpCloudTile + fpCloudOffset ).r;
  float cloud = smoothstep( fpCloudCover, fpCloudCover + 0.22, n );
  return mix( 1.0 - fpCloudStrength * cloud, fpRoomShade, fpRoom() );
}
`;
// directional lights only (sun, moon): the shade multiplies their colour before the shading model
const DIR_INFO = 'getDirectionalLightInfo( directionalLight, directLight );';
export function shadeDirectional(chunk) {
  if (!chunk.includes(DIR_INFO)) return null;
  return `float fpShade = fpCloudShade();\n${chunk.replace(DIR_INFO, `${DIR_INFO}\n\t\tdirectLight.color *= fpShade;`)}`;
}

// surroundings light: added to the indirect (ambient) irradiance outside the rooms, sky from above, ground below
const OUT_LIGHT = `
#if defined( RE_IndirectDiffuse )
  if ( fpOutSky.r + fpOutSky.g + fpOutSky.b + fpOutGround.r + fpOutGround.g + fpOutGround.b > 0.0 ) {
    float fpUp = 0.5 + 0.5 * normalize( ( vec4( geometryNormal, 0.0 ) * viewMatrix ).xyz ).y;
    irradiance += ( 1.0 - fpRoom() ) * mix( fpOutGround, fpOutSky, fpUp );
  }
#endif
`;

// city lights at night: lit windows on the walls of the neighbouring flats (materials with FP_WINDOWS), lit
// glass such as a lobby or shop front (FP_GLOW, bays a little uneven), and pools of street light near the ground
const CITY_LIGHTS = `
if ( fpCity > 0.0 ) {
  vec3 fpN = normalize( ( vec4( geometryNormal, 0.0 ) * viewMatrix ).xyz );
  float fpOut = 1.0 - fpRoom();
  #if defined( FP_WINDOWS ) || defined( FP_GLOW )
  if ( abs( fpN.y ) < 0.3 ) {
    float fpU = dot( vFpCloudW.xz, normalize( vec2( -fpN.z, fpN.x ) ) );
    float fpFace = floor( dot( vFpCloudW.xz, fpN.xz ) * 2.0 ) * 17.0; // parallel faces differ
    #ifdef FP_WINDOWS
    vec2 fpG = vec2( fpU / 1.8, ( vFpCloudW.y - fpCityGround ) / 3.0 );
    vec2 fpC = floor( fpG ) + fpFace, fpF = fract( fpG );
    float fpWin = fpBand( fpF.x, 0.18, 0.82 ) * fpBand( fpF.y, 0.3, 0.78 ) * step( fpHash( fpC ), fpCityParams.x );
    totalEmissiveRadiance += fpOut * fpWin * fpWindowTint( fpHash( fpC + 3.1 ) ) * ( 0.55 + 0.45 * fpHash( fpC + 7.7 ) ) * fpCityParams.y * fpCity;
    #else
    vec2 fpC = vec2( floor( fpU / 3.0 ), fpFace );
    totalEmissiveRadiance += fpOut * vec3( 1.0, 0.76, 0.5 ) * ( 0.45 + 0.55 * fpHash( fpC + 9.1 ) ) * fpCityParams.w * fpCity;
    #endif
  }
  #endif
  #if defined( RE_IndirectDiffuse )
  float fpH = vFpCloudW.y - fpCityGround;
  if ( fpCityParams.z > 0.0 && fpH < 6.0 ) {
    vec2 fpG = vFpCloudW.xz / 9.0, fpC0 = floor( fpG );
    float fpL = 0.0;
    for ( int i = -1; i <= 1; i ++ ) for ( int j = -1; j <= 1; j ++ ) {
      vec2 fpC = fpC0 + vec2( i, j );
      if ( fpHash( fpC + 5.0 ) > 0.7 ) continue;
      vec2 fpP = ( fpC + 0.2 + 0.6 * vec2( fpHash( fpC + 1.3 ), fpHash( fpC + 2.7 ) ) ) * 9.0;
      vec2 fpD = vFpCloudW.xz - fpP;
      fpL += exp( -dot( fpD, fpD ) / 9.7 );
    }
    irradiance += fpOut * vec3( 1.0, 0.68, 0.38 ) * fpL * fpCityParams.z * fpCity * ( 1.0 - smoothstep( 1.0, 6.0, fpH ) );
  }
  #endif
}
`;

// Lit materials only (the ones with direct light to shade).
export const shadable = (m) => !!(m && (m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial));

// Patch a material once (shader compiled with the shade; later changes are uniforms only).
export function patchCloudShadow(mat, uniforms) {
  if (!shadable(mat) || mat.userData.fpCloud) return false;
  mat.userData.fpCloud = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev.call(mat, sh, r);
    Object.assign(sh.uniforms, uniforms);
    const sway = !!mat.userData.fpSway;
    let vs = sh.vertexShader;
    if (sway) vs = SWAY_HEAD + vs.replace('#include <begin_vertex>', `#include <begin_vertex>${SWAY_BODY}`);
    sh.vertexShader = VERT_HEAD + vs.replace('#include <project_vertex>', `#include <project_vertex>${VERT_BODY}`);
    const begin = shadeDirectional(THREE.ShaderChunk.lights_fragment_begin);
    if (!begin) return; // three changed its light loop: no cloud shadows rather than a broken shader
    const city = mat.userData.fpCityLit, head = city === 'windows' ? '#define FP_WINDOWS\n' : city === 'glow' ? '#define FP_GLOW\n' : '';
    sh.fragmentShader = head + FRAG_HEAD + sh.fragmentShader.replace('#include <lights_fragment_begin>', begin + OUT_LIGHT + CITY_LIGHTS);
  };
  const key = mat.customProgramCacheKey;
  mat.customProgramCacheKey = () => `${key ? key.call(mat) : ''}|fpcloud${mat.userData.fpCityLit || ''}${mat.userData.fpSway ? 's' : ''}`;
  mat.needsUpdate = true;
  return true;
}

// Seamless shadow pattern (canvas, 256 px, red = density): soft blobs wrapped around the tile, then
// equalized (values spread evenly over 0..1) so a threshold of 1 - c shades a share c of the ground.
let pattern = null;
export function cloudPattern() {
  if (pattern) return pattern;
  const n = 256, c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = '#000';
    g.fillRect(0, 0, n, n);
    let seed = 1234567;
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    for (let i = 0; i < 40; i++) {
      const x = rnd() * n, y = rnd() * n, r = 14 + rnd() * 34, a = 0.35 + rnd() * 0.4;
      for (const dx of [-n, 0, n]) {
        for (const dy of [-n, 0, n]) {
          const grad = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
          grad.addColorStop(0, `rgba(255,255,255,${a})`);
          grad.addColorStop(1, 'rgba(255,255,255,0)');
          g.fillStyle = grad;
          g.fillRect(x + dx - r, y + dy - r, 2 * r, 2 * r);
        }
      }
    }
    const img = g.getImageData(0, 0, n, n), d = img.data;
    equalize(d);
    g.putImageData(img, 0, 0);
  }
  pattern = new THREE.CanvasTexture(c);
  pattern.wrapS = pattern.wrapT = THREE.RepeatWrapping;
  pattern.colorSpace = THREE.NoColorSpace;
  return pattern;
}

// Histogram equalization of the red channel of RGBA pixels (in place; g, b follow, alpha 255).
export function equalize(d) {
  const count = new Array(256).fill(0), n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) count[d[i]]++;
  const map = new Array(256);
  let below = 0;
  for (let v = 0; v < 256; v++) { map[v] = Math.round(((below + count[v] / 2) / n) * 255); below += count[v]; }
  for (let i = 0; i < d.length; i += 4) { const v = map[d[i]]; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
}

// Room mask texture (red = room) for a frame from roomMaskFrame: the polygons filled, edges a little
// soft. Returns a CanvasTexture (dispose it when replaced).
export function roomMaskTexture(polygons, frame, px = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d');
  if (g && frame) {
    g.fillStyle = '#000';
    g.fillRect(0, 0, px, px);
    g.fillStyle = '#fff';
    for (const poly of polygons) {
      g.beginPath();
      poly.forEach(([x, y], i) => {
        const u = ((x - frame.minX) / frame.sizeX) * px, v = ((-y - frame.minZ) / frame.sizeZ) * px;
        if (i) g.lineTo(u, v); else g.moveTo(u, v);
      });
      g.closePath();
      g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false; // canvas row v = texture v (z grows down the canvas and up the texture otherwise)
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

// Card option sway: true | { plants: [mesh / material names or layers that sway], strength } -> settings or null.
export const SWAY_DEFAULTS = Object.freeze({ plants: Object.freeze(['decoration']), strength: 1 });
export function normSway(opt) {
  if (!opt) return null;
  const o = opt === true ? {} : typeof opt === 'object' ? opt : null;
  if (!o) return null;
  const v = Number(o.strength);
  const strength = o.strength === undefined || !Number.isFinite(v) ? SWAY_DEFAULTS.strength : Math.min(5, Math.max(0, v));
  const plants = o.plants === undefined ? [...SWAY_DEFAULTS.plants] : [].concat(o.plants).filter((x) => typeof x === 'string' && x);
  return strength > 0 && plants.length ? { plants, strength } : null;
}

// Lean (m at SWAY_HEIGHT_M) for a wind speed (m/s): a breath in calm air, at most 0.6 m in a gale.
export const swayLean = (wind, strength = 1) => strength * Math.min(0.6, 0.08 + 0.04 * Math.max(0, Number(wind) || 0));
