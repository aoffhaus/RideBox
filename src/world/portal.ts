// The portal gate of a portal run: a glowing ring standing on the road, half sunk
// into it, filled with a swirling vortex around a dark tunnel. Riding through it
// at the end of an interval drops you somewhere else in another world.
// Local frame (as for the arches): +x is the direction of travel, z is across the
// road, y is up; the ring stands in the z-y plane.
import * as THREE from 'three';

/** Ring radius (m): wide enough to clear both road edges. */
export const PORTAL_R = 5.6;
/** The portal's own colours (the next interval's zone colour goes on the road strip and banner). */
export const PORTAL_VIOLET = '#8a4dff';
const PORTAL_CYAN = '#3fd8ff';

/** Height of the ring's centre above the road; the bottom of the ring is sunk below it. */
const CENTRE_Y = PORTAL_R - 0.9;

export interface PortalObj {
  group: THREE.Group;
  ring: THREE.MeshStandardMaterial;
  accent: THREE.MeshBasicMaterial;
  vortex: THREE.ShaderMaterial;
  halo: THREE.MeshBasicMaterial;
  sparks: THREE.PointsMaterial;
  strip: THREE.MeshBasicMaterial;
  /** spins in the ring plane: sparks and rune studs */
  spinner: THREE.Group;
  /** counter-spinning inner sparks */
  spinner2: THREE.Group;
  /** current zone colour of the strip */
  zone: THREE.Color;
  // countdown banner (same layout as the arches')
  canvas: HTMLCanvasElement;
  tex: THREE.CanvasTexture;
  lastText: string;
}

const VORTEX_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Spiral arms winding into a dark tunnel with a faint bright point at its far end.
// Colours above 1 are left for the bloom pass to pick up.
const VORTEX_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
uniform vec3 uColor2;
uniform float uOpacity;
uniform float uCharge;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float a = atan(p.y, p.x);
  float spin = uTime * (1.6 + 2.4 * uCharge);
  // arms wind tighter toward the centre, like water down a drain
  float arms = 0.5 + 0.5 * sin(a * 4.0 + 7.0 / (r + 0.22) - spin * 1.6);
  float fine = 0.5 + 0.5 * sin(a * 11.0 - 22.0 * r + spin * 2.3);
  float ripples = 0.5 + 0.5 * sin(30.0 * r - spin * 3.0);
  float tunnel = smoothstep(0.08, 0.75, r);           // 0 in the depths, 1 out at the rim
  vec3 deep = vec3(0.02, 0.0, 0.06);
  // violet arms, threaded with cyan filaments toward the middle
  vec3 armCol = mix(uColor2, uColor, smoothstep(0.25, 0.85, r)) * (1.1 + 1.2 * uCharge);
  vec3 col = mix(deep, armCol, arms * tunnel * (0.7 + 0.3 * fine));
  col += uColor2 * fine * ripples * tunnel * (1.0 - r) * 0.5;
  // the far end of the tunnel: a small light that swells as you arrive
  col += mix(uColor2, vec3(1.0), 0.5) * smoothstep(0.14 + 0.5 * uCharge, 0.0, r) * (1.0 + 2.0 * uCharge);
  // hot rim where the vortex meets the ring
  col += uColor * smoothstep(0.8, 0.98, r) * 1.4;
  float alpha = smoothstep(1.0, 0.94, r) * uOpacity * (0.86 + 0.14 * arms);
  gl_FragColor = vec4(col, alpha);
}`;

/** Soft glow ring for the halo behind the frame (white, tinted by the material). */
function haloTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.62, 'rgba(255,255,255,0)');
  grad.addColorStop(0.75, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.83, 'rgba(255,255,255,0.25)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

function sparkTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.7)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** Points scattered in a band around the ring (in the y-z plane, centred on the origin). */
function sparkRing(count: number, r0: number, r1: number, seed: number): THREE.BufferGeometry {
  let a = seed;
  const rand = () => ((a = (a * 16807) % 2147483647) / 2147483647);
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const ang = rand() * Math.PI * 2;
    const r = r0 + (r1 - r0) * rand();
    pos[i * 3] = (rand() - 0.5) * 0.9;
    pos[i * 3 + 1] = Math.sin(ang) * r;
    pos[i * 3 + 2] = Math.cos(ang) * r;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return geo;
}

/** `stripTex` is the arches' soft line texture, reused for the glow across the road. */
export function buildPortal(stripTex: THREE.Texture): PortalObj {
  const g = new THREE.Group();
  g.name = 'portal';
  const color = new THREE.Color(PORTAL_VIOLET);
  const cyan = new THREE.Color(PORTAL_CYAN);
  const glow = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false } as const;
  const facing = <T extends THREE.Object3D>(m: T): T => ((m.rotation.y = Math.PI / 2), m);

  // the frame: a heavy dark-metal torus with an emissive core, and a slim accent ring outside it
  const ring = new THREE.MeshStandardMaterial({ color: '#1a1530', emissive: color, emissiveIntensity: 0.9, metalness: 0.8, roughness: 0.3 });
  const torus = facing(new THREE.Mesh(new THREE.TorusGeometry(PORTAL_R, 0.46, 24, 140), ring));
  torus.position.y = CENTRE_Y;
  torus.castShadow = true;
  g.add(torus);
  const accent = new THREE.MeshBasicMaterial({ color: cyan, toneMapped: false });
  const accentRing = facing(new THREE.Mesh(new THREE.TorusGeometry(PORTAL_R + 0.72, 0.07, 8, 160), accent));
  accentRing.position.y = CENTRE_Y;
  g.add(accentRing);

  // the vortex filling the ring
  const vortex = new THREE.ShaderMaterial({
    vertexShader: VORTEX_VERT,
    fragmentShader: VORTEX_FRAG,
    uniforms: { uTime: { value: 0 }, uColor: { value: color.clone() }, uColor2: { value: cyan.clone() }, uOpacity: { value: 1 }, uCharge: { value: 0 } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const disc = facing(new THREE.Mesh(new THREE.CircleGeometry(PORTAL_R - 0.25, 120), vortex));
  disc.position.y = CENTRE_Y;
  disc.userData.mapSkip = true;
  g.add(disc);

  // halo glow around the frame
  const halo = new THREE.MeshBasicMaterial({ ...glow, map: haloTexture(), color, opacity: 0.6 });
  const haloMesh = facing(new THREE.Mesh(new THREE.PlaneGeometry(PORTAL_R * 2.9, PORTAL_R * 2.9), halo));
  haloMesh.position.set(-0.05, CENTRE_Y, 0);
  g.add(haloMesh);

  // orbiting sparks and rune studs set into the frame
  const sparks = new THREE.PointsMaterial({ ...glow, map: sparkTexture(), color: cyan, size: 0.55, sizeAttenuation: true, opacity: 1 });
  const spinner = new THREE.Group();
  spinner.position.y = CENTRE_Y;
  spinner.add(new THREE.Points(sparkRing(220, PORTAL_R + 0.3, PORTAL_R + 1.5, 7), sparks));
  const studGeo = new THREE.OctahedronGeometry(0.34, 0);
  for (let i = 0; i < 12; i++) {
    const ang = (i / 12) * Math.PI * 2;
    const stud = new THREE.Mesh(studGeo, accent);
    stud.position.set(0.5, Math.sin(ang) * PORTAL_R, Math.cos(ang) * PORTAL_R);
    stud.rotation.x = ang;
    spinner.add(stud);
  }
  g.add(spinner);
  const spinner2 = new THREE.Group();
  spinner2.position.y = CENTRE_Y;
  spinner2.add(new THREE.Points(sparkRing(160, 0.6, PORTAL_R - 0.6, 11), sparks));
  g.add(spinner2);

  // a bright line across the road where it swallows you
  const strip = new THREE.MeshBasicMaterial({ ...glow, map: stripTex, color, opacity: 1 });
  const stripMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.4, PORTAL_R * 2.2), strip);
  stripMesh.rotation.x = -Math.PI / 2;
  stripMesh.position.y = 0.05;
  g.add(stripMesh);

  // countdown banner facing the oncoming rider
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 256;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  // (in the top of the ring, where it stays in view above the HUD on the approach)
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 1.6), new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide }));
  sign.rotation.y = -Math.PI / 2;
  sign.position.set(-0.6, CENTRE_Y + PORTAL_R * 0.58, 0);
  g.add(sign);

  g.traverse((o) => (o.userData.mapSkip = true));
  return { group: g, ring, accent, vortex, halo, sparks, strip, spinner, spinner2, zone: color.clone(), canvas, tex, lastText: '' };
}

const _c = new THREE.Color();

/** The next interval's zone colour, on the line across the road. */
export function setPortalZone(p: PortalObj, color: string) {
  _c.set(color);
  if (_c.equals(p.zone)) return;
  p.zone.copy(_c);
  p.strip.color.copy(_c);
}

/**
 * Per-frame life. `charge` (0..1) rises over the last moments before you reach it:
 * the vortex spins up and brightens, the frame flares.
 */
export function animatePortal(p: PortalObj, time: number, dt: number, charge: number) {
  p.vortex.uniforms.uTime.value = time;
  p.vortex.uniforms.uCharge.value = charge;
  p.spinner.rotation.x += dt * (0.5 + 2.5 * charge);
  p.spinner2.rotation.x -= dt * (0.9 + 3.5 * charge);
  const pulse = 0.5 + 0.5 * Math.sin(time * 2.4);
  p.ring.emissiveIntensity = 0.8 + 0.4 * pulse + 2 * charge;
  p.halo.opacity = 0.4 + 0.2 * pulse + 0.4 * charge;
  p.strip.opacity = 0.7 + 0.3 * Math.sin(time * 4);
}
