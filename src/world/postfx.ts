// Post-processing chain for high quality: scene → ambient occlusion → bloom → output
// (tone mapping + sRGB). Low quality skips all of it and renders directly.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export interface BloomParams {
  strength: number;
  radius: number;
  threshold: number;
}

export const DEFAULT_BLOOM: BloomParams = { strength: 0.5, radius: 0.4, threshold: 1.8 };

/**
 * GTAO that ignores everything that shouldn't occlude: sprites (clouds, mist), any
 * transparent material (light shafts, foam, signs) and objects tagged `userData.noAO`.
 * Their quads would otherwise write into the normal/depth buffer and cast dark halos.
 */
class SceneAOPass extends GTAOPass {
  overrideVisibility() {
    const cache = (this as unknown as { _visibilityCache: Map<THREE.Object3D, boolean> })._visibilityCache;
    this.scene.traverse((o) => {
      cache.set(o, o.visible);
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      const transparent = Array.isArray(m) ? m.some((x) => x.transparent) : !!m?.transparent;
      if ((o as THREE.Points).isPoints || (o as THREE.Line).isLine || (o as THREE.Sprite).isSprite || transparent || o.userData.noAO) o.visible = false;
    });
  }
}

export class PostFX {
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  readonly ao: SceneAOPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, bloom: BloomParams) {
    const size = renderer.getSize(new THREE.Vector2());
    // HDR, multisampled target so edges stay antialiased (the canvas MSAA doesn't apply here)
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.setPixelRatio(renderer.getPixelRatio());
    this.composer.setSize(size.x, size.y);
    this.composer.addPass(new RenderPass(scene, camera));

    this.ao = new SceneAOPass(scene, camera, size.x, size.y);
    // Radius in metres: big enough to darken tree bases, creases in rock and the ground
    // under the bike, small enough that distant hills don't pick up halos.
    this.ao.updateGtaoMaterial({ radius: 1.6, distanceExponent: 1.4, thickness: 2.5, scale: 1.0, samples: 16, distanceFallOff: 1.0 });
    this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
    this.ao.blendIntensity = 0.85;
    this.composer.addPass(this.ao);

    this.bloom = new UnrealBloomPass(size, bloom.strength, bloom.radius, bloom.threshold);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  setSize(w: number, h: number) {
    this.composer.setSize(w, h);
  }

  render(dt: number) {
    this.composer.render(dt);
  }

  dispose() {
    this.ao.dispose();
    this.bloom.dispose();
    this.composer.dispose();
  }
}
