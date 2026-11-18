import * as THREE from 'three';
import type { RideSession } from '../app/session';
import type { Route } from './route';
import { rng } from './route';
import { formatDuration, intervalFtpFraction, toWatts, zoneFor } from '../workout/model';

const ROAD_HALF = 4.5;

/** Terrain height offset beside the road (same function for ground + trees). */
function terrainBump(i: number, off: number): number {
  const a = Math.abs(off);
  if (a < ROAD_HALF + 1.5) return -0.15;
  const k = (a - ROAD_HALF - 1.5) / 170;
  const wave = Math.sin(i * 0.013 + Math.sign(off) * 1.7) * 0.6 + Math.sin(i * 0.047 + off * 0.02) * 0.4;
  return -0.15 + k * k * (18 + 30 * wave) + k * 4;
}

function roadTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#3b3e44';
  g.fillRect(0, 0, 256, 512);
  const r = rng(42);
  for (let i = 0; i < 5000; i++) {
    const v = 50 + r() * 40;
    g.fillStyle = `rgb(${v},${v},${v + 4})`;
    g.fillRect(r() * 256, r() * 512, 1.5, 1.5);
  }
  g.fillStyle = '#e8e8e8';
  g.fillRect(10, 0, 6, 512);
  g.fillRect(240, 0, 6, 512);
  g.fillStyle = '#f2c94c';
  g.fillRect(124, 0, 4, 256);
  g.fillRect(130, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildRoad(route: Route): THREE.Mesh {
  const n = route.x.length;
  const pos = new Float32Array((n + 1) * 2 * 3);
  const uv = new Float32Array((n + 1) * 2 * 2);
  const idx: number[] = [];
  for (let k = 0; k <= n; k++) {
    const i = k % n;
    const h = route.heading[i];
    const lx = -Math.sin(h);
    const lz = Math.cos(h);
    for (let s = 0; s < 2; s++) {
      const off = s === 0 ? -ROAD_HALF : ROAD_HALF;
      const o = (k * 2 + s) * 3;
      pos[o] = route.x[i] + lx * off;
      pos[o + 1] = route.y[i] + 0.02;
      pos[o + 2] = route.z[i] + lz * off;
      uv[(k * 2 + s) * 2] = s;
      uv[(k * 2 + s) * 2 + 1] = (k * route.step) / 12;
    }
    if (k < n) {
      const a = k * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ map: roadTexture() });
  const m = new THREE.Mesh(geo, mat);
  m.receiveShadow = true;
  return m;
}

function buildTerrain(route: Route): THREE.Mesh {
  const n = route.x.length;
  const offs = [-200, -120, -70, -40, -22, -12, -7, -ROAD_HALF - 0.3, ROAD_HALF + 0.3, 7, 12, 22, 40, 70, 120, 200];
  const cols = offs.length;
  const step = 2; // every other route sample
  const rows = Math.ceil(n / step) + 1;
  const pos = new Float32Array(rows * cols * 3);
  const col = new Float32Array(rows * cols * 3);
  const idx: number[] = [];
  const grassA = new THREE.Color('#4f8a3a');
  const grassB = new THREE.Color('#6fa04a');
  const dirt = new THREE.Color('#8a7a55');
  const tmp = new THREE.Color();
  for (let r = 0; r < rows; r++) {
    const i = (r * step) % n;
    const h = route.heading[i];
    const lx = -Math.sin(h);
    const lz = Math.cos(h);
    for (let c = 0; c < cols; c++) {
      const off = offs[c];
      const o = (r * cols + c) * 3;
      pos[o] = route.x[i] + lx * off;
      pos[o + 1] = route.y[i] + terrainBump(i, off);
      pos[o + 2] = route.z[i] + lz * off;
      const w = 0.5 + 0.5 * Math.sin(i * 0.03 + off * 0.05);
      tmp.copy(grassA).lerp(grassB, w);
      if (Math.abs(off) < ROAD_HALF + 1) tmp.lerp(dirt, 0.6);
      col[o] = tmp.r;
      col[o + 1] = tmp.g;
      col[o + 2] = tmp.b;
    }
    if (r < rows - 1) {
      for (let c = 0; c < cols - 1; c++) {
        if (c === 7) continue; // the road sits here
        const a = r * cols + c;
        const b = a + cols;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  m.receiveShadow = true;
  return m;
}

function buildTrees(route: Route): THREE.Group {
  const n = route.x.length;
  const r = rng(route.seed * 31 + 7);
  const spots: { x: number; y: number; z: number; s: number }[] = [];
  for (let i = 0; i < n; i += 2) {
    for (const side of [-1, 1]) {
      if (r() > 0.45) continue;
      const off = side * (ROAD_HALF + 5 + Math.pow(r(), 1.5) * 110);
      const h = route.heading[i];
      spots.push({
        x: route.x[i] - Math.sin(h) * off + (r() - 0.5) * 6,
        y: route.y[i] + terrainBump(i, off) - 0.3,
        z: route.z[i] + Math.cos(h) * off + (r() - 0.5) * 6,
        s: 0.7 + r() * 0.9,
      });
    }
  }
  const g = new THREE.Group();
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.25, 2, 6).translate(0, 1, 0);
  const leafGeo = new THREE.ConeGeometry(1.8, 5, 7).translate(0, 4.2, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: '#6b4a2b' }), spots.length);
  const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshLambertMaterial({ color: '#2f6b35' }), spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const c = new THREE.Color();
  spots.forEach((p, k) => {
    m.compose(new THREE.Vector3(p.x, p.y, p.z), q, new THREE.Vector3(p.s, p.s, p.s));
    trunks.setMatrixAt(k, m);
    leaves.setMatrixAt(k, m);
    c.setHSL(0.3 + r() * 0.06, 0.45, 0.22 + r() * 0.1);
    leaves.setColorAt(k, c);
  });
  leaves.castShadow = true;
  g.add(trunks, leaves);
  return g;
}

function buildRider(): { group: THREE.Group; wheels: THREE.Mesh[]; crank: THREE.Group } {
  const g = new THREE.Group();
  const frameMat = new THREE.MeshStandardMaterial({ color: '#d33', metalness: 0.4, roughness: 0.4 });
  const tyreMat = new THREE.MeshStandardMaterial({ color: '#111', roughness: 0.9 });
  const skin = new THREE.MeshStandardMaterial({ color: '#e0b48f' });
  const jersey = new THREE.MeshStandardMaterial({ color: '#1f6feb' });
  const shorts = new THREE.MeshStandardMaterial({ color: '#111' });
  const wheels: THREE.Mesh[] = [];
  for (const x of [-0.5, 0.5]) {
    const w = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.03, 8, 24), tyreMat);
    w.position.set(x, 0.34, 0);
    wheels.push(w);
    g.add(w);
  }
  const bar = (a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material) => {
    const len = a.distanceTo(b);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 6), mat);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    return m;
  };
  const V = (x: number, y: number, z = 0) => new THREE.Vector3(x, y, z);
  const bb = V(0, 0.32);
  const seat = V(-0.15, 0.85);
  const head = V(0.38, 0.85);
  [
    [bb, seat],
    [bb, head],
    [seat, head],
    [V(-0.5, 0.34), bb],
    [V(-0.5, 0.34), seat],
    [head, V(0.5, 0.34)],
    [head, V(0.42, 1.0)],
  ].forEach(([a, b]) => g.add(bar(a, b, 0.022, frameMat)));
  // body
  g.add(bar(V(-0.12, 0.98), V(0.32, 1.32), 0.17, jersey)); // torso
  g.add(bar(V(0.3, 1.3), V(0.44, 1.02, 0.18), 0.05, skin));
  g.add(bar(V(0.3, 1.3), V(0.44, 1.02, -0.18), 0.05, skin));
  const headM = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), skin);
  headM.position.set(0.42, 1.48, 0);
  g.add(headM);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.135, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), jersey);
  helmet.position.copy(headM.position);
  g.add(helmet);
  g.add(bar(V(-0.15, 0.95, 0), V(-0.12, 0.98, 0), 0.16, shorts));
  // legs on a rotating crank
  const crank = new THREE.Group();
  crank.position.copy(bb);
  g.add(crank);
  const hip = V(-0.12, 0.95);
  const legs: { foot: THREE.Object3D; thigh?: THREE.Mesh; shin?: THREE.Mesh; side: number }[] = [];
  for (const side of [1, -1]) {
    const foot = new THREE.Object3D();
    foot.position.set(0.17 * side, 0, 0.1 * side);
    crank.add(foot);
    legs.push({ foot, side });
  }
  (g as any).__legs = { legs, hip, shorts, skin };
  g.traverse((o) => ((o as THREE.Mesh).castShadow = true));
  return { group: g, wheels, crank };
}

function makeLabel(): { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture } {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 256;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { canvas, tex };
}

interface ArchObj {
  group: THREE.Group;
  mat: THREE.MeshStandardMaterial;
  label: ReturnType<typeof makeLabel>;
  lastText: string;
}

function buildArch(opacity: number): ArchObj {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: '#f2c94c',
    emissive: '#f2c94c',
    emissiveIntensity: 0.6,
    transparent: opacity < 1,
    opacity,
  });
  const postGeo = new THREE.BoxGeometry(0.5, 6, 0.5).translate(0, 3, 0);
  for (const z of [-ROAD_HALF - 0.6, ROAD_HALF + 0.6]) {
    const p = new THREE.Mesh(postGeo, mat);
    p.position.z = z;
    g.add(p);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.6, (ROAD_HALF + 0.85) * 2), mat);
  beam.position.y = 6.2;
  g.add(beam);
  const label = makeLabel();
  const signMat = new THREE.MeshBasicMaterial({ map: label.tex, transparent: true, opacity, side: THREE.DoubleSide });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(9.6, 2.4), signMat);
  // face the approaching rider (rider comes from -x)
  sign.rotation.y = -Math.PI / 2;
  sign.position.set(-0.3, 6.2, 0);
  g.add(sign);
  return { group: g, mat, label, lastText: '' };
}

function drawLabel(a: ArchObj, big: string, small: string, color: string) {
  const text = big + '|' + small + '|' + color;
  if (text === a.lastText) return;
  a.lastText = text;
  const g = a.label.canvas.getContext('2d')!;
  g.clearRect(0, 0, 1024, 256);
  g.fillStyle = 'rgba(10,12,16,0.85)';
  g.beginPath();
  g.roundRect(8, 8, 1008, 240, 28);
  g.fill();
  g.fillStyle = color;
  g.fillRect(8, 8, 24, 240);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'bold 120px system-ui, sans-serif';
  g.fillText(big, 520, 100);
  g.font = '600 52px system-ui, sans-serif';
  g.fillStyle = '#cfd6e0';
  g.fillText(small, 520, 200);
  a.label.tex.needsUpdate = true;
}

/** The 3D world view. Reads the session each frame; never changes it. */
export class WorldView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(62, 1, 0.3, 1500);
  private rider: ReturnType<typeof buildRider>;
  private arch: ArchObj;
  private nextArch: ArchObj;
  private sun: THREE.DirectionalLight;
  private raf = 0;
  private ro: ResizeObserver;
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private crankAngle = 0;
  private wheelAngle = 0;
  private last = performance.now();
  private legMeshes: THREE.Mesh[] = [];

  constructor(private container: HTMLElement, private session: RideSession) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    const sky = new THREE.Color('#9cc9ef');
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 120, 900);
    this.scene.add(new THREE.HemisphereLight('#dbeeff', '#4a6b34', 1.1));
    this.sun = new THREE.DirectionalLight('#fff4e0', 1.8);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -40;
    sc.right = 40;
    sc.top = 40;
    sc.bottom = -40;
    sc.far = 300;
    this.scene.add(this.sun, this.sun.target);

    const route = session.route;
    this.scene.add(buildTerrain(route), buildRoad(route), buildTrees(route));
    // distant ground to fill gaps
    let minY = Infinity;
    for (const y of route.y) minY = Math.min(minY, y);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000), new THREE.MeshLambertMaterial({ color: '#557f3d' }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = minY - 2;
    this.scene.add(ground);

    this.rider = buildRider();
    this.scene.add(this.rider.group);
    // simple animated legs (thigh + shin from hip to pedal)
    const legMat = new THREE.MeshStandardMaterial({ color: '#111' });
    for (let k = 0; k < 4; k++) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.05, 1, 6), k < 2 ? legMat : new THREE.MeshStandardMaterial({ color: '#e0b48f' }));
      m.castShadow = true;
      this.rider.group.add(m);
      this.legMeshes.push(m);
    }

    this.arch = buildArch(1);
    this.nextArch = buildArch(0.35);
    this.scene.add(this.arch.group, this.nextArch.group);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    const p = route.at(0);
    this.camPos.set(p.x - 8, p.y + 3, p.z);
    this.loop();
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private place(obj: THREE.Object3D, distance: number, lateral = 0) {
    const p = this.session.route.at(distance);
    obj.position.set(p.x - Math.sin(p.heading) * lateral, p.y, p.z + Math.cos(p.heading) * lateral);
    obj.rotation.set(0, -p.heading, 0);
    return p;
  }

  private updateLegs() {
    const legs = (this.rider.group as any).__legs as { legs: { foot: THREE.Object3D; side: number }[]; hip: THREE.Vector3 };
    const set = (m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) => {
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.scale.set(1, a.distanceTo(b), 1);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    };
    legs.legs.forEach((l, k) => {
      const foot = new THREE.Vector3();
      l.foot.getWorldPosition(foot);
      this.rider.group.worldToLocal(foot);
      const hip = legs.hip.clone();
      hip.z = 0.09 * l.side;
      foot.z = 0.12 * l.side;
      // knee: two-bone IK with thigh/shin length 0.46
      const L = 0.46;
      const d = Math.min(hip.distanceTo(foot), 2 * L - 0.001);
      const mid = hip.clone().add(foot).multiplyScalar(0.5);
      const hgt = Math.sqrt(Math.max(0, L * L - (d / 2) * (d / 2)));
      const dir = foot.clone().sub(hip).normalize();
      const perp = new THREE.Vector3(dir.y, -dir.x, 0).multiplyScalar(-1); // forward-up
      const knee = mid.add(perp.multiplyScalar(hgt));
      set(this.legMeshes[k], hip, knee);
      set(this.legMeshes[k + 2], knee, foot);
    });
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const s = this.session.snapshot();
    const route = this.session.route;

    // rider
    const p = this.place(this.rider.group, s.distance, 1.6);
    const pitch = Math.atan(p.grade);
    this.rider.group.rotateZ(pitch);
    this.wheelAngle -= (s.speed / 0.34) * dt;
    this.rider.wheels.forEach((w) => (w.rotation.z = this.wheelAngle));
    this.crankAngle -= ((s.cadence || 0) / 60) * Math.PI * 2 * dt;
    this.rider.crank.rotation.z = this.crankAngle;
    this.rider.group.updateMatrixWorld(true);
    this.updateLegs();

    // camera: chase from behind & above, smoothed
    const back = route.at(s.distance - 7.5);
    const ahead = route.at(s.distance + 14);
    const lat = 1.6;
    const camTarget = new THREE.Vector3(back.x - Math.sin(back.heading) * lat, Math.max(back.y, p.y) + 2.6, back.z + Math.cos(back.heading) * lat);
    const lookTarget = new THREE.Vector3(ahead.x - Math.sin(ahead.heading) * lat, ahead.y + 0.9, ahead.z + Math.cos(ahead.heading) * lat);
    const k = 1 - Math.exp(-dt * 4);
    this.camPos.lerp(camTarget, k);
    this.camLook.lerp(lookTarget, k * 1.5 > 1 ? 1 : k * 1.5);
    if (this.camLook.lengthSq() === 0) this.camLook.copy(lookTarget);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);

    // sun follows rider so the shadow box covers it
    this.sun.position.set(p.x + 60, p.y + 120, p.z + 40);
    this.sun.target.position.set(p.x, p.y, p.z);

    // arches
    const st = s.workout;
    const ftp = this.session.engine?.ftp ?? 200;
    if (st && s.archDistance != null && st.interval) {
      this.arch.group.visible = true;
      this.place(this.arch.group, s.archDistance);
      const next = st.next;
      const color = next ? (next.free ? '#9aa4b2' : zoneFor(intervalFtpFraction(next, ftp)).color) : '#ffffff';
      this.arch.mat.color.set(color);
      this.arch.mat.emissive.set(color);
      const intensity = st.intensity / 100;
      const nextTxt = next
        ? next.free
          ? `Next: ${formatDuration(next.duration)} free ride`
          : `Next: ${formatDuration(next.duration)} @ ${Math.round(toWatts((next.powerStart + next.powerEnd) / 2, next.unit, ftp) * intensity)} W`
        : 'Workout complete!';
      drawLabel(this.arch, formatDuration(Math.ceil(st.remaining)), nextTxt, color);
      if (s.nextArchDistance != null && next) {
        this.nextArch.group.visible = true;
        this.place(this.nextArch.group, s.nextArchDistance);
        const nn = this.session.engine!.intervals[next.index + 1];
        const c2 = nn ? (nn.free ? '#9aa4b2' : zoneFor(intervalFtpFraction(nn, ftp)).color) : '#ffffff';
        this.nextArch.mat.color.set(c2);
        this.nextArch.mat.emissive.set(c2);
        drawLabel(this.nextArch, formatDuration(Math.ceil(st.remaining + next.duration)), nn ? 'End of next interval' : 'Finish', c2);
      } else this.nextArch.group.visible = false;
    } else {
      this.arch.group.visible = false;
      this.nextArch.group.visible = false;
    }

    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.renderer.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose?.();
    });
    this.renderer.domElement.remove();
  }
}
