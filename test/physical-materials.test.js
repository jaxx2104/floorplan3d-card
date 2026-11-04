import { describe, it, expect } from 'bun:test';
import * as THREE from 'three';
import { nameSurface, classifyMaterial, normMaterialRules, ruleMatches } from '../src/material-class.ts';
import { setSurface, surfaceOf, materialFacts, surfaceCounts, SURFACE_LOOK, GLASS_FRESNEL } from '../src/physical-materials.ts';
import { patchCloudShadow, makeCloudUniforms, tierKey } from '../src/cloud-shadow.ts';
import { normRender, normRenderOption } from '../src/render-recipe.ts';
import { buildManifest, threeAdapter } from '../src/manifest.ts';

// a mesh use as the heuristics see it
const use = (o = {}) => ({ name: '', groups: [], layers: [], object: false, indoor: true, floorTop: false, chain: [], ...o });
const facts = (o = {}) => ({ name: '', physical: false, transparent: false, opacity: 1, textured: false, emissive: false, uses: [use()], ...o });

describe('material classes: names', () => {
  it('glass, fabric and floor words', () => {
    expect(nameSurface('Glass')).toBe('glass');
    expect(nameSurface('window_pane_living')).toBe('glass');
    expect(nameSurface('Glazing.001')).toBe('glass');
    expect(nameSurface('sofa_body')).toBe('fabric');
    expect(nameSurface('Curtain_L')).toBe('fabric');
    expect(nameSurface('master_bed_body')).toBe('fabric');
    expect(nameSurface('Floor_Kitchen')).toBe('floor');
    expect(nameSurface('parquet')).toBe('floor');
    expect(nameSurface('Tiles2')).toBe('floor');
    expect(nameSurface('oak wood')).toBe('floor');
  });
  it('words only: bedroom, fiberglass, panel and window frames are none of them', () => {
    expect(nameSurface('bedroom_wall')).toBe(null);
    expect(nameSurface('fiberglass')).toBe(null);
    expect(nameSurface('panel')).toBe(null);
    expect(nameSurface('window_frame')).toBe(null);
    expect(nameSurface('Plaster')).toBe(null);
    expect(nameSurface('')).toBe(null);
  });
  it('rugs and carpets are fabric, not floors; a window curtain is fabric, a glass curtain wall glass', () => {
    expect(nameSurface('floor_rug')).toBe('fabric');
    expect(nameSurface('Carpet_floor')).toBe('fabric');
    expect(nameSurface('window_curtain')).toBe('fabric');
    expect(nameSurface('glass_curtain_wall')).toBe('glass');
  });
});

describe('material classes: heuristics', () => {
  it('the material name decides first', () => {
    expect(classifyMaterial(facts({ name: 'Glass' }))).toBe('glass');
    expect(classifyMaterial(facts({ name: 'Velvet_sofa', uses: [use({ name: 'Cube.001' })] }))).toBe('fabric');
  });
  it('else every mesh using it must agree', () => {
    expect(classifyMaterial(facts({ uses: [use({ name: 'sofa_body' }), use({ name: 'bed_body' })] }))).toBe('fabric');
    expect(classifyMaterial(facts({ uses: [use({ name: 'sofa_body' }), use({ name: 'wall' })] }))).toBe(null);
    expect(classifyMaterial(facts({ uses: [use({ floorTop: true }), use({ floorTop: true })] }))).toBe('floor');
    expect(classifyMaterial(facts({ uses: [use({ floorTop: true }), use({ name: 'wall' })] }))).toBe(null); // shared with a wall
  });
  it('a cushion inside a Sofa group is fabric; the glass layer is glass', () => {
    expect(classifyMaterial(facts({ uses: [use({ name: 'Cube.003', groups: ['Sofa'] })] }))).toBe('fabric');
    expect(classifyMaterial(facts({ uses: [use({ name: 'Cube', layers: ['glass'] })] }))).toBe('glass');
  });
  it('floors only indoors: paving outside keeps its look', () => {
    expect(classifyMaterial(facts({ name: 'tiles', uses: [use({ indoor: false })] }))).toBe(null);
    expect(classifyMaterial(facts({ uses: [use({ name: 'exterior_floor_5', indoor: false })] }))).toBe(null);
  });
  it('see-through untextured materials are thin glass', () => {
    expect(classifyMaterial(facts({ transparent: true, opacity: 0.35 }))).toBe('glass');
    expect(classifyMaterial(facts({ transparent: true, opacity: 0.35, textured: true }))).toBe(null); // a decal
    expect(classifyMaterial(facts({ transparent: true, opacity: 0.35, emissive: true }))).toBe(null);
    expect(classifyMaterial(facts({ transparent: true, opacity: 0.9 }))).toBe(null);
  });
  it('KHR_materials_* (already physical) and model objects are never touched, not even by rules', () => {
    const rules = [{ sel: 'all', surface: 'glass' }];
    expect(classifyMaterial(facts({ name: 'Glass', physical: true }), rules)).toBe(null);
    expect(classifyMaterial(facts({ name: 'Glass', uses: [use({ object: true })] }), rules)).toBe(null);
    expect(classifyMaterial(facts({ uses: [use(), use({ object: true })] }), rules)).toBe(null);
  });
});

describe('material classes: explicit rules', () => {
  const chain = [{ tag: null, layers: [], path: 'house/level0/living_room/Rug' }, { tag: { kind: 'room', id: 'living_room', role: null, type: null, group: null }, layers: [], path: 'house/level0/living_room' }];
  it('selectors: material:<name glob>, node:, room:, layer:', () => {
    const m = facts({ name: 'Oak_Light', uses: [use({ chain })] });
    expect(ruleMatches('material:oak*', m)).toBe(true);
    expect(ruleMatches('material:Pine', m)).toBe(false);
    expect(ruleMatches('node:**/Rug', m)).toBe(true);
    expect(ruleMatches('room:living_room', m)).toBe(true); // an ancestor matches
    expect(ruleMatches('room:kitchen', m)).toBe(false);
    expect(ruleMatches('layer:rugs', facts({ uses: [use({ chain: [{ tag: null, layers: ['rugs'], path: 'x' }] })] }))).toBe(true);
  });
  it('opt in, opt out, later rules win, rules beat the heuristics', () => {
    const m = facts({ name: 'Oak_Light', uses: [use({ chain })] });
    expect(classifyMaterial(m)).toBe(null);
    expect(classifyMaterial(m, [{ sel: 'material:Oak*', surface: 'floor' }])).toBe('floor'); // opt in
    expect(classifyMaterial(m, [{ sel: 'material:Oak*', surface: 'floor' }, { sel: 'node:**/Rug', surface: 'fabric' }])).toBe('fabric');
    expect(classifyMaterial(facts({ name: 'Glass' }), [{ sel: 'material:glass', surface: 'none' }])).toBe(null); // opt out
    expect(classifyMaterial(facts({ name: 'tiles', uses: [use({ indoor: false })] }), [{ sel: 'all', surface: 'floor' }])).toBe('floor'); // outdoors too
  });
  it('material extras fp_surface, overridden by the rules', () => {
    expect(classifyMaterial(facts({ name: 'Plaster', extras: 'floor' }))).toBe('floor');
    expect(classifyMaterial(facts({ name: 'Glass', extras: 'none' }))).toBe(null);
    expect(classifyMaterial(facts({ name: 'Plaster', extras: 'floor' }), [{ sel: 'material:Plaster', surface: 'none' }])).toBe(null);
    expect(classifyMaterial(facts({ name: 'Glass', extras: 'bogus' }))).toBe('glass'); // invalid extras: ignored
  });
  it('normMaterialRules: selector -> class, in order, with warnings', () => {
    expect(normMaterialRules({ 'material:Glass*': 'glass', 'layer:rugs': 'None', 'node:**/Floor': 'floor' })).toEqual({
      rules: [{ sel: 'material:Glass*', surface: 'glass' }, { sel: 'layer:rugs', surface: 'none' }, { sel: 'node:**/Floor', surface: 'floor' }], warnings: [] });
    const bad = normMaterialRules({ 'shiny:x': 'glass', 'layer:a': 'metal', 'material:': 'glass' });
    expect(bad.rules).toEqual([]);
    expect(bad.warnings).toHaveLength(3);
    expect(normMaterialRules(['glass']).warnings[0]).toMatch(/needs an object/);
    expect(normMaterialRules(undefined)).toEqual({ rules: [], warnings: [] });
  });
  it('the model recipe and the card option carry the rules', () => {
    const r = normRender({ materials: { 'material:Glass': 'none', 'x': 'glass' } });
    expect(r.recipe.materials).toEqual([{ sel: 'material:Glass', surface: 'none' }]);
    expect(r.warnings.join()).toMatch(/render.materials: "x"/);
    const o = normRenderOption({ quality: 'high', materials: { 'layer:rugs': 'fabric' } });
    expect(o.option.materials).toEqual([{ sel: 'layer:rugs', surface: 'fabric' }]);
    expect(o.warnings).toEqual([]);
    expect('materials' in normRenderOption({ quality: 'high' }).option).toBe(false); // absent unless given
  });
});

describe('physical upgrade in place', () => {
  it('becomes a MeshPhysicalMaterial, same object, and back to the same standard material', () => {
    const m = new THREE.MeshStandardMaterial({ color: 0x6f86a6, roughness: 0.9, name: 'fabric' });
    m.userData.keep = 1;
    let disposed = 0;
    m.addEventListener('dispose', () => disposed++);
    const keysBefore = Object.keys(m).sort();
    expect(setSurface(m, 'fabric')).toBe(true);
    expect(m).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(m.isMeshPhysicalMaterial).toBe(true);
    expect(m.type).toBe('MeshPhysicalMaterial');
    expect(m.defines).toEqual({ STANDARD: '', PHYSICAL: '' });
    expect(m.sheen).toBe(SURFACE_LOOK.fabric.sheen);
    expect(m.sheenColor.r).toBeCloseTo(SURFACE_LOOK.fabric.sheenColor);
    expect(m.reflectivity).toBeCloseTo(new THREE.MeshPhysicalMaterial().reflectivity);
    expect(surfaceOf(m)).toBe('fabric');
    expect(disposed).toBe(1); // renderer state dropped: another shader
    expect(setSurface(m, 'fabric')).toBe(false); // nothing to do
    const v = m.version;
    expect(setSurface(m, null)).toBe(true);
    expect(m.version).toBeGreaterThan(v);
    expect(m).not.toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(m.isMeshPhysicalMaterial).toBe(undefined);
    expect(m.type).toBe('MeshStandardMaterial');
    expect(m.defines).toEqual({ STANDARD: '' });
    expect(Object.keys(m).sort()).toEqual(keysBefore);
    expect(m.roughness).toBe(0.9);
    expect(m.userData).toEqual({ keep: 1 });
    expect(m.clone()).toBeInstanceOf(THREE.MeshStandardMaterial);
  });
  it('glass: smooth dielectric with the fresnel variant, its roughness / metalness restored', () => {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.2, transparent: true, opacity: 0.35 });
    setSurface(m, 'glass');
    expect(m.roughness).toBe(SURFACE_LOOK.glass.roughness);
    expect(m.metalness).toBe(0);
    expect(m.transmission).toBe(0); // thin glass: no transmission pass
    expect(m.opacity).toBe(0.35);
    expect(m.userData.fpGlass).toBe(true);
    setSurface(m, 'floor'); // class change: restored, then upgraded again
    expect(m.roughness).toBe(0.3);
    expect(m.clearcoat).toBe(SURFACE_LOOK.floor.clearcoat);
    expect(m.userData.fpGlass).toBe(undefined);
    setSurface(m, null);
    expect([m.roughness, m.metalness]).toEqual([0.3, 0.2]);
  });
  it('leaves file-physical and non-standard materials alone', () => {
    const p = new THREE.MeshPhysicalMaterial({ transmission: 1 });
    expect(setSurface(p, 'glass')).toBe(false);
    expect(p.transmission).toBe(1);
    expect(setSurface(new THREE.MeshBasicMaterial(), 'glass')).toBe(false);
  });
  it('thin glass is its own program variant of the cloud patch; standard keys are unchanged', () => {
    const m = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.4 });
    patchCloudShadow(m, makeCloudUniforms());
    const std = m.customProgramCacheKey();
    expect(tierKey(m)).toBe('');
    setSurface(m, 'glass');
    expect(tierKey(m)).toBe('g');
    expect(m.customProgramCacheKey()).toBe(std + 'g');
    const sh = { uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
    m.onBeforeCompile(sh, null);
    expect(sh.fragmentShader).toContain(GLASS_FRESNEL.trim().split('\n')[0]);
    expect(sh.fragmentShader.indexOf('fpC')).toBeLessThan(sh.fragmentShader.indexOf('#include <opaque_fragment>'));
    setSurface(m, null);
    expect(m.customProgramCacheKey()).toBe(std);
  });
});

describe('material facts from a model', () => {
  it('rooms, floor surfaces, objects, groups, shared materials', () => {
    const root = new THREE.Group();
    const level = new THREE.Group();
    level.name = 'level0';
    level.userData.fp = { kind: 'level', id: 'level0', role: 'storey', elevation: 0, height: 2.7 };
    root.add(level);
    const room = new THREE.Group();
    room.name = 'living';
    room.userData.fp = { kind: 'room', id: 'living', outline: [[0, 0], [4, 0], [4, 3], [0, 3]] };
    level.add(room);
    const slabMat = new THREE.MeshStandardMaterial(), wallMat = new THREE.MeshStandardMaterial(), fabricMat = new THREE.MeshStandardMaterial();
    const slab = new THREE.Mesh(new THREE.BoxGeometry(4, 0.2, 3), slabMat);
    slab.name = 'slab';
    slab.position.y = -0.1;
    room.add(slab);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(4, 2.7, 0.15), wallMat);
    wall.position.y = 1.35;
    level.add(wall);
    const sofa = new THREE.Group();
    sofa.name = 'Sofa';
    const cushion = new THREE.Mesh(new THREE.BoxGeometry(1, 0.2, 0.5), fabricMat);
    cushion.name = 'Cube.001';
    sofa.add(cushion);
    room.add(sofa);
    const lamp = new THREE.Group();
    lamp.name = 'lamp';
    lamp.userData.fp = { kind: 'object', id: 'lamp', type: 'light' };
    const shade = new THREE.Mesh(new THREE.SphereGeometry(0.1), new THREE.MeshStandardMaterial({ name: 'glass', transparent: true, opacity: 0.4 }));
    lamp.add(shade);
    room.add(lamp);
    const manifest = buildManifest(threeAdapter(root));
    const f = materialFacts(root, manifest);
    expect(f.get(slabMat).uses[0]).toMatchObject({ floorTop: true, indoor: true, object: false });
    expect(f.get(wallMat).uses[0]).toMatchObject({ floorTop: false, indoor: true });
    expect(f.get(fabricMat).uses[0].groups).toEqual(['Sofa']);
    expect(f.get(shade.material).uses[0].object).toBe(true);
    expect(classifyMaterial(f.get(slabMat))).toBe('floor');
    expect(classifyMaterial(f.get(wallMat))).toBe(null);
    expect(classifyMaterial(f.get(fabricMat))).toBe('fabric');
    expect(classifyMaterial(f.get(shade.material))).toBe(null); // the card drives objects
    expect(classifyMaterial(f.get(wallMat), [{ sel: 'level:level0', surface: 'fabric' }])).toBe('fabric');
    for (const [m, x] of f) setSurface(m, classifyMaterial(x));
    expect(surfaceCounts(root)).toEqual({ glass: 0, floor: 1, fabric: 1 });
  });
});
