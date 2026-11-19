// Post-processing chain for high quality: scene → ambient occlusion → bloom → output
// (tone mapping + sRGB). Low quality skips all of it and renders directly.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { fxBuild, fxSurge } from './fx';

/**
 * Effort grading, in HDR before tone mapping. As a sustained effort builds the picture
 * gets richer, warmer and more focused (saturation, contrast, a closing vignette); a
 * sprint adds a radial speed blur and colour fringing toward the edges. At rest it is
 * an exact pass-through.
 */
const EffortShader = {
  uniforms: {
    tDiffuse: { value: null },
    fxBuild,
    fxSurge,
    aspect: { value: 1 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float fxBuild; uniform float fxSurge; uniform float aspect;
    varying vec2 vUv;
    void main(){
      vec2 fromC = vUv - 0.5;
      float r = length(fromC * vec2(aspect, 1.0));
      vec3 c;
      if (fxSurge > 0.002) {
        // radial zoom blur + chromatic split, both growing toward the edges
        float k = fxSurge * smoothstep(0.15, 0.75, r);
        vec2 dir = fromC * 0.06 * k;
        vec3 acc = vec3(0.0);
        for (int i = 0; i < 8; i++) {
          float t = float(i) / 7.0;
          vec2 uv = vUv - dir * t;
          vec2 ca = fromC * 0.006 * k;
          acc += vec3(texture2D(tDiffuse, uv + ca).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - ca).b);
        }
        c = acc / 8.0;
      } else {
        c = texture2D(tDiffuse, vUv).rgb;
      }
      float e = clamp(fxBuild + 0.6 * fxSurge, 0.0, 1.0);
      // saturation and a little contrast
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, 1.0 + 0.35 * e);
      c = mix(c, c * c / (c + 0.18) * 1.18, 0.35 * e);
      // warm the highlights, deepen the shadows toward crimson as it really hurts
      c *= mix(vec3(1.0), vec3(1.06, 0.98, 0.9), e);
      // vignette closes in: tunnel focus
      float vig = smoothstep(0.35, 0.95, r) * (0.18 * fxBuild + 0.35 * fxSurge);
      c *= 1.0 - vig;
      c = mix(c, c * vec3(1.0, 0.55, 0.5), vig * 0.6 * fxBuild);
      gl_FragColor = vec4(c, 1.0);
    }`,
};

export interface BloomParams {
  strength: number;
  radius: number;
  threshold: number;
}

export const DEFAULT_BLOOM: BloomParams = { strength: 0.5, radius: 0.4, threshold: 1.8 };

/**
 * GTAO tuned for this scene:
 *  - ignores everything that shouldn't occlude: sprites (clouds, mist), points, lines, any
 *    transparent material (light shafts, foam, signs) and objects tagged `userData.noAO`.
 *    Their quads would otherwise write into the normal/depth buffer and cast dark halos.
 *    Which objects those are is worked out once (and again after `invalidate()`), not by
 *    walking the whole scene twice every frame.
 *  - runs at half resolution (the occlusion is soft, so a bilinear upsample hides it), which
 *    makes the normal/depth render, the AO and the denoise roughly 4x cheaper.
 *  - multiplies straight onto the frame instead of copying it to the other buffer first.
 */
class SceneAOPass extends GTAOPass {
  /** objects hidden while rendering normals/depth (null = rebuild on next frame) */
  private hidden: THREE.Object3D[] | null = null;
  private wasVisible: boolean[] = [];
  /** 1 = full resolution, 0.5 = half */
  scale = 0.5;

  constructor(scene: THREE.Scene, camera: THREE.Camera, width: number, height: number) {
    super(scene, camera, width, height);
    this.needsSwap = false;
  }

  /** Call when objects are added to or removed from the scene. */
  invalidate() {
    this.hidden = null;
  }

  setSize(width: number, height: number) {
    super.setSize(Math.max(1, Math.round(width * this.scale)), Math.max(1, Math.round(height * this.scale)));
  }

  overrideVisibility() {
    if (!this.hidden) {
      const list: THREE.Object3D[] = [];
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        const transparent = Array.isArray(m) ? m.some((x) => x.transparent) : !!m?.transparent;
        if ((o as THREE.Points).isPoints || (o as THREE.Line).isLine || (o as THREE.Sprite).isSprite || transparent || o.userData.noAO) list.push(o);
      });
      this.hidden = list;
    }
    const h = this.hidden;
    this.wasVisible.length = h.length;
    for (let k = 0; k < h.length; k++) {
      this.wasVisible[k] = h[k].visible;
      h[k].visible = false;
    }
  }

  restoreVisibility() {
    const h = this.hidden!;
    for (let k = 0; k < h.length; k++) h[k].visible = this.wasVisible[k];
  }

  render(renderer: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    // same as GTAOPass's default output, except the AO is multiplied onto readBuffer in place
    const self = this as unknown as { _renderGBuffer: boolean; normalMaterial: THREE.MeshNormalMaterial; normalRenderTarget: THREE.WebGLRenderTarget };
    if (self._renderGBuffer) {
      this.overrideVisibility();
      this.renderOverride(renderer, self.normalMaterial, self.normalRenderTarget, 0x7777ff, 1.0);
      this.restoreVisibility();
    }
    const cam = this.camera as THREE.PerspectiveCamera;
    const u = this.gtaoMaterial.uniforms;
    u.cameraNear.value = cam.near;
    u.cameraFar.value = cam.far;
    u.cameraProjectionMatrix.value.copy(cam.projectionMatrix);
    u.cameraProjectionMatrixInverse.value.copy(cam.projectionMatrixInverse);
    u.cameraWorldMatrix.value.copy(cam.matrixWorld);
    this.renderPass(renderer, this.gtaoMaterial, this.gtaoRenderTarget, 0xffffff, 1.0);
    this.pdMaterial.uniforms.cameraProjectionMatrixInverse.value.copy(cam.projectionMatrixInverse);
    this.renderPass(renderer, this.pdMaterial, this.pdRenderTarget, 0xffffff, 1.0);
    this.blendMaterial.uniforms.intensity.value = this.blendIntensity;
    this.blendMaterial.uniforms.tDiffuse.value = this.pdRenderTarget.texture;
    this.renderPass(renderer, this.blendMaterial, this.renderToScreen ? null : readBuffer);
  }
}

export class PostFX {
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  readonly ao: SceneAOPass;
  readonly effort: ShaderPass;
  private baseBloom: number;

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
    this.ao.updateGtaoMaterial({ radius: 1.6, distanceExponent: 1.4, thickness: 2.5, scale: 1.0, samples: 12, distanceFallOff: 1.0 });
    // denoise radius is in AO-buffer pixels: 3 at half resolution covers what 6 did at full
    this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 3, rings: 2, samples: 8 });
    this.ao.blendIntensity = 0.85;
    this.composer.addPass(this.ao);

    this.bloom = new UnrealBloomPass(size, bloom.strength, bloom.radius, bloom.threshold);
    this.composer.addPass(this.bloom);
    this.baseBloom = bloom.strength;
    this.effort = new ShaderPass(EffortShader);
    this.effort.uniforms.fxBuild = fxBuild; // ShaderPass clones uniforms: re-share the globals
    this.effort.uniforms.fxSurge = fxSurge;
    this.composer.addPass(this.effort);
    this.composer.addPass(new OutputPass());
  }

  /** Objects were added to or removed from the scene (refreshes what the AO pass ignores). */
  invalidateScene() {
    this.ao.invalidate();
  }

  setSize(w: number, h: number) {
    this.composer.setSize(w, h);
    this.effort.uniforms.aspect.value = w / Math.max(1, h);
  }

  render(dt: number) {
    // glow swells with sustained effort and flares on a sprint
    this.bloom.strength = this.baseBloom * (1 + 0.6 * fxBuild.value + 0.7 * fxSurge.value);
    this.composer.render(dt);
  }

  dispose() {
    this.ao.dispose();
    this.bloom.dispose();
    this.composer.dispose();
  }
}
