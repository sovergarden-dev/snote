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
  vec2 p  = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / min(u_resolution.x, u_resolution.y);

  float t = u_time * 0.18;

  // Two long ribbons. Noise only bends their path; it is not the picture.
  float n1 = fbm(vec2(p.x * 0.55 + t * 0.15, 2.0));
  float n2 = fbm(vec2(p.x * 0.40 - t * 0.10, 8.0));
  float y1 = 0.08 + n1 * 0.22 + 0.06 * sin(p.x * 1.4 + t);
  float y2 = -0.34 + n2 * 0.16 + 0.05 * sin(p.x * 0.8 - t * 0.7);
  float b1 = exp(-pow((p.y - y1) / 0.055, 2.0));
  float b2 = exp(-pow((p.y - y2) / 0.042, 2.0));
  float chi = b1 + b2 * 0.7;

  vec3 base = vec3(0.012, 0.016, 0.015);
  vec3 jade = vec3(0.22, 0.62, 0.48);
  vec3 col = base + jade * chi * 0.85;

  float centre = exp(-(p.x * p.x) * 3.5) * smoothstep(0.45, 0.0, abs(p.y));
  col = mix(col, base, centre * 0.45);

  float vig = smoothstep(1.15, 0.35, length(p));
  col *= mix(0.55, 1.0, vig);

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
