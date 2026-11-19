// Physical (Preetham scattering) sky whose horizon melts into the theme's fog colour,
// plus an image-based-lighting environment baked from it so PBR materials (rider,
// arches) pick up real sky colour. Everything is driven by one sun direction, so a
// time-of-day setting is just a different elevation/azimuth.
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

export interface SkyParams {
  turbidity: number; // haze in the air (2 = crisp, 10 = murky)
  rayleigh: number; // blue scattering (higher = deeper blue / redder sunsets)
  mieCoefficient: number; // size of the sun's glow
  mieDirectionalG: number; // how tight the glow is around the sun
  /** Brightness multiplier, keeps open sky under the bloom threshold (only the sun should glow). */
  exposure: number;
}

export const DEFAULT_SKY: SkyParams = { turbidity: 2.2, rayleigh: 3.0, mieCoefficient: 0.004, mieDirectionalG: 0.82, exposure: 0.3 };

/** Unit vector towards the sun from elevation / azimuth in degrees (azimuth from +x towards +z). */
export function sunDirection(elevationDeg: number, azimuthDeg: number, out = new THREE.Vector3()) {
  const el = THREE.MathUtils.degToRad(elevationDeg);
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  return out.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
}

export function buildPhysicalSky(params: SkyParams, sunDir: THREE.Vector3, haze: THREE.Color, size = 10000): Sky {
  const sky = new Sky();
  sky.scale.setScalar(size);
  const u = sky.material.uniforms;
  u.turbidity.value = params.turbidity;
  u.rayleigh.value = params.rayleigh;
  u.mieCoefficient.value = params.mieCoefficient;
  u.mieDirectionalG.value = params.mieDirectionalG;
  u.sunPosition.value.copy(sunDir);
  u.hazeColor = { value: haze.clone() };
  u.skyExposure = { value: params.exposure };
  // Blend the lowest few degrees into the fog colour so distant terrain fades seamlessly
  // into the sky (the scattering model alone doesn't know about the scene's fog).
  sky.material.fragmentShader = sky.material.fragmentShader
    .replace('uniform vec3 up;', 'uniform vec3 up;\nuniform vec3 hazeColor;\nuniform float skyExposure;')
    .replace(
      'gl_FragColor = vec4( retColor, 1.0 );',
      `retColor *= skyExposure;
       float hz = 1.0 - smoothstep(-0.01, 0.075, direction.y);
       retColor = mix(retColor, hazeColor, hz * hz * (3.0 - 2.0 * hz));
       gl_FragColor = vec4( retColor, 1.0 );`,
    );
  sky.material.depthWrite = false;
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  return sky;
}

/** Bake a prefiltered environment map from a sky (for scene.environment). */
export function bakeEnvironment(renderer: THREE.WebGLRenderer, sky: Sky): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const copy = new Sky();
  copy.material.uniforms = sky.material.uniforms;
  copy.material.fragmentShader = sky.material.fragmentShader;
  copy.scale.setScalar(100);
  envScene.add(copy);
  const rt = pmrem.fromScene(envScene, 0, 0.1, 1000);
  pmrem.dispose();
  copy.geometry.dispose();
  copy.material.dispose();
  return rt.texture;
}
