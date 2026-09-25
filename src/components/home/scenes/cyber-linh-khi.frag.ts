// GLSL fragment shader — "Jade Chi".
//
// Design intent: deep near-black void with 2–3 long jade chi energy bands
// that flow, warp and curl across the canvas. Domain-warped fBm gives the
// bands structure (not cloud-blob mush), and a soft sin-based shimmer adds
// a subtle ngọc-bích lifeblood pulse. Dark-only — ThemeToggle pins
// next-themes to "dark" when this scene is active.
export const CYBER_LINH_KHI_FRAG = /* glsl */ `
precision mediump float;

uniform float u_time;
uniform vec2  u_resolution;
uniform float u_isDark; // kept for API parity; ignored.

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

// fBm — 4 octaves, low lacunarity → large coherent structure.
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.55;
  for (int i = 0; i < 4; i++) {
    v += a * snoise(p);
    p *= 2.1;
    a *= 0.55;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec2 p  = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / min(u_resolution.x, u_resolution.y);

  float t = u_time * 0.18; // very slow drift — chi flows, doesn't rush.

  // 2-pass domain warp: bend the field into long ribbons instead of blobs.
  vec2 q  = vec2(fbm(p * 0.9 + vec2(0.0, t)),
                 fbm(p * 0.9 + vec2(5.2, -t)));
  vec2 r  = vec2(fbm(p * 0.9 + 1.6 * q + vec2(1.7, 9.2) + 0.15 * t),
                 fbm(p * 0.9 + 1.6 * q + vec2(8.3, 2.8) - 0.13 * t));
  float field = fbm(p * 0.9 + 1.4 * r);

  // 2–3 long curling bands: a sharper ridge profile (not a wide fog wash),
  // warped by the field so each band curls as it crosses the canvas.
  float wave = p.y * 1.25 + r.x * 1.6 + 0.35 * sin(p.x * 1.3 + t * 0.4) + t * 0.5;
  float band = 1.0 - abs(sin(wave));
  band = pow(band, 8.0);

  // Chi only blooms where field peaks AND a band passes.
  float chi = smoothstep(-0.15, 0.75, field * 0.5 + 0.5) * band;
  chi = pow(chi, 1.15);

  // Palette — deep void → jade peak.
  vec3 base = vec3(0.003, 0.008, 0.014); // ~#01030a
  vec3 jade = vec3(0.09, 0.42, 0.34);

  vec3 col = base;
  col += jade * chi * 0.85;

  // Bottom edge stays nearly black so the form is not a second light source.
  float glow = pow(max(0.0, 0.12 - uv.y), 2.0) * 0.04;
  col += jade * glow;

  // Darken the hero column centre so copy reads on ink.
  float centre = exp(-(p.x * p.x) * 5.0) * smoothstep(0.55, 0.0, abs(p.y - 0.05));
  col *= 1.0 - 0.55 * centre;

  // Vignette — pull edges to void.
  float vig = smoothstep(1.20, 0.28, length(p));
  col *= mix(0.42, 1.0, vig);

  // Dither / grain to kill banding on OLED.
  float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (grain - 0.5) * 0.018;

  gl_FragColor = vec4(col, 1.0);
}
`;

export const CYBER_LINH_KHI_VERT = /* glsl */ `
attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;
