// GLSL fragment shader — "Ethereal Aurora".
//
// Three drifting pastel light bands stacked vertically, warped by curl-ish
// simplex noise. Soft additive blend so they never clip into pure white;
// a generous vignette pulls the eye toward the centered hero copy.
//
// Tuned for dark mode only — ThemeToggle pins next-themes to "dark" when this
// scene is active. The `u_isDark` uniform is kept for API parity.
export const ETHEREAL_AURORA_FRAG = /* glsl */ `
precision mediump float;

uniform float u_time;
uniform vec2  u_resolution;
uniform float u_isDark;

// --- Simplex noise (Ashima / Stefan Gustavson, public domain) ---
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                     -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v -   i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
                          + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy),
                          dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

// Aurora ribbon centred on yc, thickness s. A slow curl term bends the
// ribbon into an arc (varies along x and drifts with time) so bands sweep
// across the frame instead of sitting as flat horizontal blurs.
float ribbon(vec2 p, float yc, float s, float t, float wobble) {
  float curl = sin(p.x * 1.1 + wobble + t * 0.18) * 0.16
             + 0.18 * p.x * p.x * sin(wobble * 0.7 + t * 0.09);
  float warp = snoise(vec2(p.x * 1.2 + curl, t * 0.5 + wobble)) * 0.16;
  float d = abs(p.y - yc - curl - warp);
  return exp(-d * d / (2.0 * s * s));
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec2 p  = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / min(u_resolution.x, u_resolution.y);

  float t = u_time * 0.55;

  // Deep midnight base — slight purple shift toward the top.
  vec3 base = mix(vec3(0.020, 0.012, 0.040), vec3(0.046, 0.020, 0.071), uv.y);

  float b1 = ribbon(p, 0.20 + sin(t * 0.21) * 0.05, 0.16, t, 0.0);
  float b2 = ribbon(p, -0.04 + cos(t * 0.17) * 0.06, 0.13, t, 4.7);
  float b3 = ribbon(p, -0.30 + sin(t * 0.13 + 1.1) * 0.04, 0.19, t, 9.3);

  vec3 peach = vec3(0.86, 0.70, 0.52);
  vec3 steel = vec3(0.55, 0.64, 0.74);
  vec3 dusk  = vec3(0.42, 0.36, 0.48);

  vec3 col = base;
  col += peach * b1 * 0.28;
  col += steel * b2 * 0.22;
  col += dusk  * b3 * 0.12;

  // Darken the middle third slightly so copy stays readable.
  float mid = smoothstep(0.30, 0.0, abs(uv.y - 0.5)) * smoothstep(0.55, 0.0, abs(p.x));
  col *= 1.0 - 0.28 * mid;

  // Vignette.
  float vig = smoothstep(1.20, 0.30, length(p));
  col *= mix(0.55, 1.0, vig);

  gl_FragColor = vec4(col, 1.0);
}
`;

export const ETHEREAL_AURORA_VERT = /* glsl */ `
attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;
