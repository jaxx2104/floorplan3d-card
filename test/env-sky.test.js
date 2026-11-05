import { describe, it, expect } from "bun:test";
import { makeSky } from "../src/view/env-light.ts";

// The sky environment's shader is three's Sky patched in place: this fails when three's Sky changes under it.
describe("sky environment shader", () => {
  it("three's Sky without its sun disc and clouds, its old gamma back, ground and tint applied", () => {
    const sky = makeSky(),
      m = sky.material;
    expect(m.uniforms.showSunDisc.value).toBe(0);
    expect(m.uniforms.cloudCoverage.value).toBe(0);
    const fs = m.fragmentShader;
    expect(fs).toContain("varying float vSunfade;");
    expect(fs).toContain(
      "pow( max( texColor, vec3( 0.0 ) ), vec3( 1.0 / ( 1.2 + ( 1.2 * vSunfade ) ) ) )",
    );
    expect(fs).toMatch(
      /fpGround[\s\S]*fpTint[\s\S]*gl_FragColor = vec4\( retColor, 1\.0 \);/,
    );
    expect(fs.split("gl_FragColor =").length).toBe(2);
    for (const u of ["fpGrey", "fpTint", "fpGround"])
      expect(m.uniforms[u]).toBeTruthy();
    sky.geometry.dispose();
    m.dispose();
  });
});
