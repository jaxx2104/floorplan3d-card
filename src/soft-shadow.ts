// Soft sun shadows (render quality 'high', QualityTier.softShadows): percentage-closer soft shadows (PCSS) for
// the directional lights' shadow maps (only the sun casts one; the moon does not). three has no PCSS, so the
// patched model materials (cloud-shadow.ts patchCloudShadow, material userData.fpPcss, part of the program cache
// key) call fpPcssShadow instead of getShadow for directional lights: a blocker search finds the mean depth of
// what shades the point, and the PCF kernel grows with the distance to it (hard where a leg meets the floor, soft
// at the end of a roof's shadow).
// The blocker search reads raw depths, which a PCF map (a depth texture with hardware compare, sampler2DShadow
// since three r182) cannot give: the tier draws its maps with BasicShadowMap (plain depth textures, sampler2D,
// view/look.ts) and compares itself. Basic maps alone are hard-edged, so the lamps' point-light shadows of the
// patched materials get a manual PCF (fpPointShadow, three's Vogel taps over the cube with an own compare).
// Built against any other map type the functions fall back to three's lookups (#define), never a broken shader.
/** Tangent of the sun's effective angular radius: the disc (0.27°) widened by the sky's forward scatter. */
export const PCSS_SUN_TAN = 0.02;
/** Blockers searched for up to this far (m) above a point. */
export const PCSS_REACH_M = 8;
/** Kernel radius bounds in shadow-map texels (the minimum about the standard tier's PCF softness). */
export const PCSS_MIN_TEXELS = 1;
export const PCSS_MAX_TEXELS = 24;
export const PCSS_BLOCKER_SAMPLES = 16;
export const PCSS_PCF_SAMPLES = 24;
/** Lamp (point light) shadows on Basic maps: taps and their spread in cube texels at shadow.radius 1. */
export const POINT_PCF_SAMPLES = 12;
export const POINT_PCF_TEXELS = 1.5;

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

// after #include <shadowmap_pars_fragment> (Basic maps: sampler2D / samplerCube with raw depths)
export const PCSS_HEAD = /* glsl */ `
#if defined( USE_SHADOWMAP ) && defined( SHADOWMAP_TYPE_BASIC ) && ( NUM_DIR_LIGHT_SHADOWS > 0 || NUM_POINT_LIGHT_SHADOWS > 0 )
vec2 fpVogel( int i, int n, float phi ) {
  float r = sqrt( ( float( i ) + 0.5 ) / float( n ) ), t = float( i ) * 2.39996323 + phi;
  return r * vec2( cos( t ), sin( t ) );
}
float fpNoiseAngle() {
  return 6.2831853 * fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
}
#endif
#if defined( USE_SHADOWMAP ) && defined( SHADOWMAP_TYPE_BASIC ) && NUM_DIR_LIGHT_SHADOWS > 0
uniform vec4 fpPcss;
// same arguments as three's getShadow; fpPcss: depth range (m), map span (m), light tan
float fpPcssShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
  shadowCoord.xyz /= shadowCoord.w;
  shadowCoord.z += shadowBias;
  bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
  if ( ! ( inFrustum && shadowCoord.z <= 1.0 ) ) return 1.0;
  float texel = 1.0 / shadowMapSize.x, perUv = fpPcss.z / fpPcss.y;
  float phi = fpNoiseAngle();
  float search = clamp( ${PCSS_REACH_M.toFixed(1)} * perUv, 2.0 * texel, ${PCSS_MAX_TEXELS.toFixed(1)} * texel );
  float sum = 0.0, n = 0.0;
  for ( int i = 0; i < ${PCSS_BLOCKER_SAMPLES}; i ++ ) {
    float d = texture2D( shadowMap, shadowCoord.xy + fpVogel( i, ${PCSS_BLOCKER_SAMPLES}, phi ) * search ).r;
    if ( d < shadowCoord.z ) { sum += d; n += 1.0; }
  }
  if ( n == 0.0 ) return 1.0;
  if ( n == ${PCSS_BLOCKER_SAMPLES.toFixed(1)} ) return 1.0 - shadowIntensity;
  float dist = ( shadowCoord.z - sum / n ) * fpPcss.x;
  float k = clamp( dist * perUv * max( shadowRadius, 1.0 ), ${PCSS_MIN_TEXELS.toFixed(1)} * texel, ${PCSS_MAX_TEXELS.toFixed(1)} * texel );
  float lit = 0.0;
  for ( int i = 0; i < ${PCSS_PCF_SAMPLES}; i ++ ) lit += step( shadowCoord.z, texture2D( shadowMap, shadowCoord.xy + fpVogel( i, ${PCSS_PCF_SAMPLES}, phi ) * k ).r );
  return mix( 1.0, lit / ${PCSS_PCF_SAMPLES.toFixed(1)}, shadowIntensity );
}
#else
#define fpPcssShadow getShadow
#endif
#if defined( USE_SHADOWMAP ) && defined( SHADOWMAP_TYPE_BASIC ) && NUM_POINT_LIGHT_SHADOWS > 0
// three's PCF point lookup (Vogel taps around the direction, the depth each face stores for it) on a Basic cube
float fpPointShadow( samplerCube shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord, float shadowCameraNear, float shadowCameraFar ) {
  vec3 l = shadowCoord.xyz, a = abs( l );
  float viewZ = max( max( a.x, a.y ), a.z );
  if ( viewZ > shadowCameraFar || viewZ < shadowCameraNear ) return 1.0;
  vec3 bd = normalize( l ), ad = abs( bd );
  float range = shadowCameraFar - shadowCameraNear;
  float depthA = shadowCameraFar / range + shadowBias, depthB = - shadowCameraNear * shadowCameraFar / ( range * length( l ) );
  float spread = ${POINT_PCF_TEXELS.toFixed(2)} * max( shadowRadius, 1.0 ) / shadowMapSize.x;
  vec3 t = normalize( cross( bd, ad.x > ad.z ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 ) ) ), b = cross( bd, t );
  float phi = fpNoiseAngle(), lit = 0.0;
  for ( int i = 0; i < ${POINT_PCF_SAMPLES}; i ++ ) {
    vec2 o = fpVogel( i, ${POINT_PCF_SAMPLES}, phi );
    vec3 dir = bd + ( t * o.x + b * o.y ) * spread, d = abs( dir );
    lit += step( depthA + depthB / max( max( d.x, d.y ), d.z ), textureCube( shadowMap, dir ).r );
  }
  return mix( 1.0, lit / ${POINT_PCF_SAMPLES.toFixed(1)}, shadowIntensity );
}
#else
#define fpPointShadow getPointShadow
#endif
`;

const DIR_SHADOW = "getShadow( directionalShadowMap[ i ]";
const POINT_SHADOW = "getPointShadow( pointShadowMap[ i ]";
// lights_fragment_begin with the directional lights' lookup swapped for fpPcssShadow and the point lights' for
// fpPointShadow, or null when three's light loop changed (no soft shadows then rather than a broken shader).
export function pcssLightLoop(chunk: string): string | null {
  if (!chunk.includes(DIR_SHADOW) || !chunk.includes(POINT_SHADOW)) return null;
  return chunk
    .replace(DIR_SHADOW, "fpPcssShadow( directionalShadowMap[ i ]")
    .replace(POINT_SHADOW, "fpPointShadow( pointShadowMap[ i ]");
}
