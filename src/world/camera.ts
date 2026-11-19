import * as THREE from 'three';
import type { Route } from './route';

export type CameraMode = 'chase' | 'close' | 'first';

/**
 * Camera rigs modelled on Zwift's views: 1 = default medium chase cam,
 * 2 = close chase, 3 = first person. Distances in metres along the road behind
 * the rider; heights above the road surface at the camera position. The
 * camera sits in the road's frame, so on a climb it is below the rider looking
 * up the slope, and on a descent above looking down (by half the height
 * difference), which makes gradients read on screen.
 */
export interface CameraRig {
  back: number; // metres behind the rider
  height: number; // metres above the road at the camera
  lookAhead: number; // metres ahead of the rider
  lookHeight: number; // metres above the road at the look point
  fov: number; // vertical degrees (58° ≈ 89° horizontal on 16:9)
  showRider: boolean;
}

export const CAMERA_RIGS: Record<CameraMode, CameraRig> = {
  chase: { back: 4.4, height: 2.05, lookAhead: 9, lookHeight: 0.9, fov: 58, showRider: true },
  close: { back: 3.2, height: 1.75, lookAhead: 8, lookHeight: 1.0, fov: 60, showRider: true },
  first: { back: -0.25, height: 1.55, lookAhead: 22, lookHeight: 1.3, fov: 70, showRider: false },
};

export function cameraTargets(route: Route, d: number, lateral: number, rig: CameraRig, out = { pos: new THREE.Vector3(), look: new THREE.Vector3() }) {
  const at = (dist: number, up: number, v: THREE.Vector3) => {
    const p = route.at(dist);
    return v.set(p.x - Math.sin(p.heading) * lateral, p.y + up, p.z + Math.cos(p.heading) * lateral);
  };
  // Follow half of the road's height change between rider and camera/look points:
  // enough that climbs look like climbs and descents like descents, while the
  // rider stays framed in the same place on screen.
  const riderY = route.at(d).y;
  const pos = at(d - rig.back, rig.height, out.pos);
  pos.y = riderY + rig.height + (pos.y - rig.height - riderY) * 0.5;
  const look = at(d + rig.lookAhead, rig.lookHeight, out.look);
  look.y = riderY + rig.lookHeight + (look.y - rig.lookHeight - riderY) * 0.6;
  return out;
}
