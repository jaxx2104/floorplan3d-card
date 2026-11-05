// Soft sun shadows (render quality 'high', QualityTier.softShadows): percentage-closer soft shadows (PCSS) for
// the directional lights' shadow maps (only the sun casts one; the moon does not). three r169 has no PCSS, so
// the patched model materials (cloud-shadow.ts patchCloudShadow, material userData.fpPcss, part of the program
// cache key) call fpPcssShadow instead of getShadow for directional lights: a blocker search finds the mean
// depth of what shades the point, and the PCF kernel grows with the distance to it (hard where a leg meets the
// floor, soft at the end of a roof's shadow). Spot / point lamp shadows keep three's sampling. The shadow
// map, its size and when it is redrawn are unchanged; only the lookup differs.

/** Tangent of the sun's effective angular radius: the disc (0.27°) widened by the sky's forward scatter. */
export const PCSS_SUN_TAN = 0.02;
/** Blockers searched for up to this far (m) above a point. */
export const PCSS_REACH_M = 8;
/** Kernel radius bounds in shadow-map texels (the minimum about PCFSoftShadowMap's softness). */
export const PCSS_MIN_TEXELS = 1;
export const PCSS_MAX_TEXELS = 24;
export const PCSS_BLOCKER_SAMPLES = 16;
export const PCSS_PCF_SAMPLES = 24;

/** fpPcss uniform for an orthographic shadow camera: [depth range (m), map span (m), light tan, 1 = on]. */
export function pcssFrame(
  cam: { near: number; far: number; left: number; right: number },
  tan = PCSS_SUN_TAN,
): [number, number, number, number] {
  return [
    Math.max(1e-3, cam.far - cam.near),
    Math.max(1e-3, cam.right - cam.left),
    tan,
    1,
  ];
}

/** Penumbra radius (m) a blocker dist metres above a receiver casts (radius scales it: clouds soften). */
export function penumbraM(
  dist: number,
  tan = PCSS_SUN_TAN,
  radius = 1,
): number {
  return Math.max(0, dist) * tan * Math.max(1, radius);
}

/** Kernel radius in texels for a penumbra (m) on a map of size texels over span metres, clamped. */
export function kernelTexels(
  penumbra: number,
  span: number,
  size: number,
): number {
  return Math.min(
    PCSS_MAX_TEXELS,
    Math.max(PCSS_MIN_TEXELS, (penumbra / span) * size),
  );
}

// after #include <shadowmap_pars_fragment> (it defines texture2DCompare, packing is included before it)
export const PCSS_HEAD = /* glsl */ `
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
uniform vec4 fpPcss;
vec2 fpVogel( int i, int n, float phi ) {
  float r = sqrt( ( float( i ) + 0.5 ) / float( n ) ), t = float( i ) * 2.39996323 + phi;
  return r * vec2( cos( t ), sin( t ) );
}
// same arguments as three's getShadow; fpPcss: depth range (m), map span (m), light tan
float fpPcssShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
  shadowCoord.xyz /= shadowCoord.w;
  shadowCoord.z += shadowBias;
  bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
  if ( ! ( inFrustum && shadowCoord.z <= 1.0 ) ) return 1.0;
  float texel = 1.0 / shadowMapSize.x, perUv = fpPcss.z / fpPcss.y;
  float phi = 6.2831853 * fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
  float search = clamp( ${PCSS_REACH_M.toFixed(1)} * perUv, 2.0 * texel, ${PCSS_MAX_TEXELS.toFixed(1)} * texel );
  float sum = 0.0, n = 0.0;
  for ( int i = 0; i < ${PCSS_BLOCKER_SAMPLES}; i ++ ) {
    float d = unpackRGBAToDepth( texture2D( shadowMap, shadowCoord.xy + fpVogel( i, ${PCSS_BLOCKER_SAMPLES}, phi ) * search ) );
    if ( d < shadowCoord.z ) { sum += d; n += 1.0; }
  }
  if ( n == 0.0 ) return 1.0;
  if ( n == ${PCSS_BLOCKER_SAMPLES.toFixed(1)} ) return 1.0 - shadowIntensity;
  float dist = ( shadowCoord.z - sum / n ) * fpPcss.x;
  float k = clamp( dist * perUv * max( shadowRadius, 1.0 ), ${PCSS_MIN_TEXELS.toFixed(1)} * texel, ${PCSS_MAX_TEXELS.toFixed(1)} * texel );
  float lit = 0.0;
  for ( int i = 0; i < ${PCSS_PCF_SAMPLES}; i ++ ) lit += texture2DCompare( shadowMap, shadowCoord.xy + fpVogel( i, ${PCSS_PCF_SAMPLES}, phi ) * k, shadowCoord.z );
  return mix( 1.0, lit / ${PCSS_PCF_SAMPLES.toFixed(1)}, shadowIntensity );
}
#endif
`;

const DIR_SHADOW = "getShadow( directionalShadowMap[ i ]";
// lights_fragment_begin with the directional lights' lookup swapped for fpPcssShadow, or null when three's
// light loop changed (no soft shadows then rather than a broken shader).
export function pcssDirectional(chunk: string): string | null {
  return chunk.includes(DIR_SHADOW)
    ? chunk.replace(DIR_SHADOW, "fpPcssShadow( directionalShadowMap[ i ]")
    : null;
}
