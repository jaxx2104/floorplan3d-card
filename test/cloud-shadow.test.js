import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  cloudShadowParams, cloudShadowOffset, roomMaskFrame, equalize, shadeDirectional, patchCloudShadow, makeCloudUniforms, shadable,
  CLOUD_UMBRA, CLOUD_TILE_M, CLOUD_WIND_MS,
} from '../src/cloud-shadow.js';

describe('cloudShadowParams', () => {
  it('clear sky: no shadows, rooms untouched', () => {
    expect(cloudShadowParams(0, 0.4)).toEqual({ cover: 1, strength: 0, roomShade: 1 });
  });
  it('the threshold shades about the coverage share; a cloud leaves CLOUD_UMBRA of the sun', () => {
    const p = cloudShadowParams(60, 0.55);
    expect(p.cover).toBeCloseTo(0.4);
    expect(p.strength).toBeCloseTo(1 - CLOUD_UMBRA);
    expect(p.roomShade).toBeCloseTo(0.55); // the rooms get the average dimming
    expect(cloudShadowParams(100, 0.25).cover).toBe(0); // overcast: everything in shade
  });
});

describe('cloudShadowOffset', () => {
  it('moves with the wind, wrapped to one tile', () => {
    expect(cloudShadowOffset(0)).toEqual([-0, -0]);
    const [x, y] = cloudShadowOffset(10);
    const d = (10 * CLOUD_WIND_MS) / CLOUD_TILE_M;
    expect(Math.hypot(x, y)).toBeCloseTo(d);
    for (const v of cloudShadowOffset(1e5)) expect(Math.abs(v)).toBeLessThan(1);
  });
});

describe('roomMaskFrame', () => {
  it('bounds of the polygons in world x / z (z = -y) plus a margin', () => {
    expect(roomMaskFrame([[[0, 0], [4, 0], [4, 3]], [[4, 0], [6, 0], [6, 2]]], 0.5)).toEqual({ minX: -0.5, minZ: -3.5, sizeX: 7, sizeZ: 4 });
    expect(roomMaskFrame([])).toBe(null);
  });
});

describe('equalize', () => {
  it('spreads the values evenly: a threshold of 1 - c keeps about a share c', () => {
    const n = 4096, d = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) d[i * 4] = Math.round(255 * Math.pow(i / n, 3)); // skewed to dark
    equalize(d);
    for (const c of [0.2, 0.5, 0.8]) {
      let above = 0;
      for (let i = 0; i < n; i++) if (d[i * 4] / 255 > 1 - c) above++;
      expect(Math.abs(above / n - c)).toBeLessThan(0.03);
    }
    expect(d[3]).toBe(255);
    expect(d[1]).toBe(d[0]);
  });
});

describe('patching', () => {
  it('shades the directional lights in three\'s light loop, not the lamps', () => {
    const out = shadeDirectional(THREE.ShaderChunk.lights_fragment_begin);
    expect(out).toBeTruthy();
    expect(out.startsWith('float fpShade = fpCloudShade();')).toBe(true);
    const dir = out.indexOf('getDirectionalLightInfo( directionalLight, directLight );');
    expect(out.indexOf('directLight.color *= fpShade;')).toBeGreaterThan(dir);
    expect(out.match(/fpShade;/g).length).toBe(1); // point / spot lights untouched
    expect(shadeDirectional('no loop here')).toBe(null);
  });
  it('lit materials once, with their own cache key; the shader gets the uniforms and the shade', () => {
    const U = makeCloudUniforms(), m = new THREE.MeshStandardMaterial();
    expect(patchCloudShadow(m, U)).toBe(true);
    expect(patchCloudShadow(m, U)).toBe(false);
    expect(m.customProgramCacheKey()).toContain('fpcloud');
    const sh = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
    m.onBeforeCompile(sh);
    expect(sh.uniforms.fpCloudStrength).toBe(U.fpCloudStrength); // shared: uniforms only afterwards
    expect(sh.vertexShader).toContain('vFpCloudW = ( modelMatrix * fpCloudW ).xyz;');
    expect(sh.fragmentShader).toContain('directLight.color *= fpShade;');
    expect(sh.fragmentShader).not.toContain('#include <lights_fragment_begin>');
    expect(shadable(new THREE.MeshBasicMaterial())).toBe(false);
    expect(patchCloudShadow(new THREE.MeshBasicMaterial(), U)).toBe(false);
  });
});
