import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { rasterizeWorld, type MapStyle, type RasterBounds } from '../src/world/worldMap';

const bounds: RasterBounds = { minX: -50, minZ: -50, maxX: 50, maxZ: 50, mPerPx: 1, maxY: 500 };

function run(roots: THREE.Object3D[]) {
  const gen = rasterizeWorld(roots, bounds);
  let r = gen.next();
  while (!r.done) r = gen.next();
  return r.value;
}
const px = (r: ReturnType<typeof run>, x: number, z: number) => {
  const o = ((z - bounds.minZ) * r.w + (x - bounds.minX)) * 4;
  return [r.data[o], r.data[o + 1], r.data[o + 2]];
};
const flat = (size: number, color: string, y: number, opts: Partial<THREE.MeshLambertMaterialParameters> = {}) => {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color, ...opts }));
  m.position.y = y;
  return m;
};

describe('rasterizeWorld', () => {
  it('draws the highest surface seen from above', () => {
    const ground = flat(100, '#00ff00', 0);
    const lake = flat(20, '#0000ff', 1);
    lake.userData.mapWater = true;
    const r = run([ground, lake]);
    expect(r.w).toBe(100);
    const [gr, gg, gb] = px(r, 30, 30);
    expect(gg).toBeGreaterThan(150);
    expect(gr + gb).toBeLessThan(20);
    const [wr, wg, wb] = px(r, 0, 0); // middle of the lake: water colour, unshaded
    expect([wr, wg, wb]).toEqual([0, 0, 255]);
    const [sr, sg] = px(r, -10, 0); // lake edge: lighter shoreline
    expect(sr).toBeGreaterThan(80);
    expect(sg).toBeGreaterThan(80);
  });

  it('leaves out skies, glows and overlays', () => {
    const ground = flat(100, '#808080', 0);
    const glow = flat(100, '#ff0000', 5, { transparent: true, opacity: 0.5 });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(40), new THREE.MeshBasicMaterial({ color: '#ff0000', side: THREE.BackSide }));
    const shader = new THREE.Mesh(new THREE.PlaneGeometry(100, 100).rotateX(-Math.PI / 2), new THREE.ShaderMaterial());
    shader.position.y = 10;
    const high = flat(100, '#ff0000', 900); // above maxY (a sun disc, say)
    const r = run([ground, glow, dome, shader, high]);
    const [cr, cg, cb] = px(r, 10, 10);
    expect(cr).toBe(cg);
    expect(cg).toBe(cb);
  });

  it('shades slopes by the light and continues terrain into uncovered ground', () => {
    const geo = new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2);
    const tiltA = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: '#ffffff' }));
    tiltA.rotation.x = 0.6; // faces +z (away from the north-west light)
    tiltA.position.set(-25, 30, 0);
    const tiltB = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: '#ffffff' }));
    tiltB.rotation.x = -0.6; // faces -z (towards the light)
    tiltB.position.set(25, 30, 0);
    const r = run([tiltA, tiltB]);
    expect(px(r, 25, 0)[0]).toBeGreaterThan(px(r, -25, 0)[0]);
    // uncovered ground continues the neighbouring terrain (here: shades of white/grey, not black)
    const [ur, ug, ub] = px(r, 0, 45);
    expect(ur).toBeGreaterThan(60);
    expect(ur).toBe(ug);
    expect(ug).toBe(ub);
  });

  it('treats huge discs as a backdrop: land fills gaps, the sea stays sea', () => {
    const land = flat(40, '#c08040', 2); // a patch of land in the middle
    const sea = new THREE.Mesh(new THREE.CircleGeometry(12000, 64).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: '#2060a0' }));
    sea.userData.mapWater = true;
    const shelf = flat(20, '#806040', -5); // sea floor beside the land, under the water
    shelf.position.x = 35;
    const r = run([sea, land, shelf]);
    expect(px(r, 0, 0)[0]).toBeGreaterThan(150); // the land itself
    const [sr, , sb] = px(r, 35, 0); // over the shelf: real water on top
    expect(sb).toBeGreaterThan(sr);
  });

  it('draws instances as footprints with their own colours', () => {
    const tree = new THREE.InstancedMesh(new THREE.ConeGeometry(3, 8), new THREE.MeshLambertMaterial({ color: '#ffffff' }), 2);
    tree.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-20, 4, 0));
    tree.setMatrixAt(1, new THREE.Matrix4().makeTranslation(20, 4, 0));
    tree.setColorAt(0, new THREE.Color('#ff0000'));
    tree.setColorAt(1, new THREE.Color('#0000ff'));
    const r = run([flat(100, '#000000', 0), tree]);
    const a = px(r, -20, 0);
    const b = px(r, 20, 0);
    expect(a[0]).toBeGreaterThan(100);
    expect(a[2]).toBe(0);
    expect(b[2]).toBeGreaterThan(100);
    expect(b[0]).toBe(0);
  });

  it('flat style: real water and trees in plain map colours, no 3D shading', () => {
    const style: MapStyle = { ground: [100, 160, 60], light: [100, 160, 60], dark: [100, 160, 60], patch: [0, 0, 0], patchA: 0.5, water: [0, 0, 255], shore: [200, 200, 255], building: [255, 255, 255], seed: 1 };
    const hill = new THREE.Mesh(new THREE.PlaneGeometry(100, 100).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: '#ff0000' }));
    hill.rotation.x = 0.5; // a slope: would be shaded in 3D, flat here
    const lake = flat(20, '#123456', 30);
    lake.userData.mapWater = true;
    const tree = new THREE.InstancedMesh(new THREE.ConeGeometry(3, 8), new THREE.MeshLambertMaterial({ color: '#00ff00' }), 1);
    tree.setMatrixAt(0, new THREE.Matrix4().makeTranslation(30, 60, 30));
    const gen = rasterizeWorld([hill, lake, tree], bounds, style);
    let r = gen.next();
    while (!r.done) r = gen.next();
    const out = r.value;
    expect(px(out, -30, -30)).toEqual([100, 160, 60]); // slope: plain ground colour
    expect(px(out, 30, -30)).toEqual([100, 160, 60]);
    expect(px(out, 0, 0)).toEqual([0, 0, 255]); // lake: water colour
    expect(px(out, -10, 0)).toEqual([200, 200, 255]); // its edge: shoreline
    expect(px(out, 30, 30)).toEqual([50, 80, 30]); // tree: woods tint over the ground
  });
});
