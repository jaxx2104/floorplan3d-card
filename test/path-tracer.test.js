// The patches the 'still' tier applies to three-gpu-pathtracer's shaders find what they replace (a library update
// that changes them fails here, not on a wall tablet).
import { describe, it, expect } from 'bun:test';
import { PhysicalPathTracingMaterial } from 'three-gpu-pathtracer';
import { clampSamples } from '../src/path-tracer.ts';
import { STILL_SAMPLE_MAX } from '../src/still.ts';

describe('path tracer shader patches', () => {
  it('caps a path radiance and drops NaN before accumulation', () => {
    const m = new PhysicalPathTracingMaterial();
    const before = m.fragmentShader;
    clampSamples(m);
    expect(m.fragmentShader).not.toBe(before);
    expect(m.fragmentShader).toContain(`if ( l > ${STILL_SAMPLE_MAX.toFixed(1)} )`);
    expect(m.fragmentShader).toContain('isnan( gl_FragColor.rgb )');
    // the cap comes right before the opacity, after every contribution
    const i = m.fragmentShader.indexOf('isnan( gl_FragColor.rgb )'), j = m.fragmentShader.indexOf('gl_FragColor.a *= opacity;');
    expect(i).toBeGreaterThan(m.fragmentShader.lastIndexOf('gl_FragColor.rgb +='));
    expect(j).toBeGreaterThan(i);
  });
  it('refuses a shader it does not know', () => {
    expect(() => clampSamples({ fragmentShader: 'void main() {}' })).toThrow(/unexpected path tracing shader/);
  });
});
