// Theme registry: per-route sky, light and scenery.
import type * as THREE from 'three';
import type { Route, ThemeId } from '../route';
import type { SkyParams } from '../sky';
import type { EffortState } from '../effort';
import { buildBigSur, bigSurRoad } from './bigsur';
import { buildRedwoods, redwoodsRoad } from './redwoods';
import { SYNTH, buildSynthwave, synthwaveRoad, synthwaveUpdate } from './synthwave';
import { buildZion, zionRoad } from './zion';
import { AURORA, auroraRoad, buildAurora } from './aurora';
import { ALIEN, alienRoad, alienUpdate, buildAlien } from './alien';
import { NEON_CITY, buildNeonCity, neonCityRoad, neonCityUpdate } from './neoncity';
import { ICELAND_SUN, buildIceland, icelandRoad } from './iceland';
import { CRYSTAL, buildCrystal, crystalRoad } from './crystal';
import { KYOTO_SUN, buildKyoto, kyotoRoad } from './kyoto';
import { PATAGONIA_SUN, buildPatagonia, patagoniaRoad } from './patagonia';

export interface ThemeBuildOptions {
  high: boolean;
  /** Unit vector towards the sun (or moon): the same direction the engine lights and draws it from. */
  sunDir: THREE.Vector3;
}

export interface Theme {
  id: ThemeId;
  skyTop: string;
  skyHorizon: string;
  haze: string; // fog colour
  fogNear: number;
  fogFar: number;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  sunColor: string;
  sunIntensity: number;
  exposure: number;
  /** Colour of the huge ground disc under everything (null = no disc, e.g. the ocean replaces it). */
  groundColor: string | null;
  clouds: boolean;
  /**
   * Builds the theme's terrain and scenery (heights derived from route.y so they follow
   * any elevation scaling). Undefined = the classic countryside builders in scene.ts.
   */
  build?: (route: Route, opts: ThemeBuildOptions) => THREE.Object3D[];
  roadTexture?: () => THREE.Texture;
  /** Bloom post-processing for this theme (high quality only). Omitted = the engine default. */
  bloom?: { strength: number; radius: number; threshold: number };
  /** false = keep the classic gradient sky dome instead of the physical (scattering) sky. Default true. */
  physicalSky?: boolean;
  /**
   * Per-frame animation hook for the theme's scenery (time in seconds). `effort` is the
   * rider's live effort (already scaled by the reactivity setting): `build` creeps up over
   * long hard efforts, `surge` spikes on sprints. Shaders can also bind `fxBuild` / `fxSurge`
   * from fx.ts directly.
   */
  update?: (time: number, effort: EffortState) => void;
  /** Sun position in degrees (azimuth from +x towards +z). Default ≈ 56° up, 32° round. */
  sun?: { elevation: number; azimuth: number };
  /** Scattering parameters for the physical sky. */
  sky?: Partial<SkyParams>;
  /** How much a passing cloud dims direct sunlight (0 = no cloud shadows). Default 0.45 when `clouds`. */
  cloudShadows?: number;
  /** Height of the shared cumulus layer above the route's highest point, in m (default 500). Raise it for tall scenery. */
  cloudHeight?: number;
  /** false = no white reflector posts along the road edge. Default true. */
  posts?: boolean;
  /** Night riding: a bike headlamp pool on the road ahead plus a soft fill light on the rider. */
  headlamp?: boolean;
}

/** The original look (rolling green countryside, farms, distant mountains). */
export const COUNTRYSIDE: Theme = {
  id: 'countryside',
  skyTop: '#3f86d6',
  skyHorizon: '#cfe5f5',
  haze: '#b9d3e6',
  fogNear: 180,
  fogFar: 1700,
  hemiSky: '#e3f1ff',
  hemiGround: '#4d6a35',
  hemiIntensity: 1.15,
  sunColor: '#fff1d6',
  sunIntensity: 2.2,
  exposure: 1.05,
  groundColor: '#5d8445',
  clouds: true,
};

const BIGSUR: Theme = {
  id: 'bigsur',
  skyTop: '#3a86d4',
  skyHorizon: '#dbe7ee',
  haze: '#cfdde5',
  fogNear: 260,
  fogFar: 2600,
  hemiSky: '#e8f1ff',
  hemiGround: '#8a7b4c',
  hemiIntensity: 1.1,
  sunColor: '#ffe4bf',
  sunIntensity: 2.5,
  exposure: 1.05,
  groundColor: null,
  clouds: true,
  build: buildBigSur,
  roadTexture: bigSurRoad,
  // late-afternoon sun low over the Pacific: it swings into view on parts of the lap
  sun: { elevation: 21, azimuth: 35 },
  sky: { turbidity: 3.2, rayleigh: 2.4, mieCoefficient: 0.006, mieDirectionalG: 0.86 },
};

const REDWOODS: Theme = {
  id: 'redwoods',
  skyTop: '#9db8c4',
  skyHorizon: '#c6d2c8',
  haze: '#b3c1b2',
  fogNear: 20,
  fogFar: 560,
  hemiSky: '#d5e4d2',
  hemiGround: '#3b3222',
  hemiIntensity: 1.2,
  sunColor: '#ffe7b8',
  sunIntensity: 2.1,
  exposure: 1.1,
  groundColor: '#3a3626',
  clouds: false,
  build: buildRedwoods,
  roadTexture: redwoodsRoad,
};

const ZION: Theme = {
  id: 'zion',
  skyTop: '#1c5cc4',
  skyHorizon: '#a8c7e6',
  haze: '#c3d2de',
  fogNear: 400,
  fogFar: 3200,
  hemiSky: '#dce8ff',
  hemiGround: '#b0603a',
  hemiIntensity: 1.05,
  sunColor: '#fff2dc',
  sunIntensity: 2.6,
  exposure: 1.0,
  groundColor: '#b27a50',
  clouds: true,
  build: buildZion,
  roadTexture: zionRoad,
};

const SYNTHWAVE: Theme = {
  id: 'synthwave',
  skyTop: SYNTH.skyTop,
  skyHorizon: SYNTH.skyHorizon,
  haze: SYNTH.haze,
  fogNear: 80,
  fogFar: 2400,
  hemiSky: '#8a6cff',
  hemiGround: '#ff3da0',
  hemiIntensity: 0.75,
  sunColor: '#ff86dc',
  sunIntensity: 1.1,
  exposure: 1.0,
  groundColor: null, // the theme brings its own endless grid
  clouds: false,
  build: buildSynthwave,
  roadTexture: synthwaveRoad,
  bloom: { strength: 0.6, radius: 0.5, threshold: 1.1 },
  physicalSky: false,
  update: synthwaveUpdate,
  posts: false, // the neon pylons replace them
};

const AURORA_NIGHT: Theme = {
  id: 'aurora',
  skyTop: AURORA.skyTop,
  skyHorizon: AURORA.skyHorizon,
  haze: AURORA.haze,
  fogNear: 150,
  fogFar: 6500,
  hemiSky: '#6d8fbf',
  hemiGround: '#1c2833',
  hemiIntensity: 0.95,
  sunColor: '#a9bfff', // moonlight
  sunIntensity: 1.3,
  exposure: 1.1,
  groundColor: null, // the fjord water covers everything
  clouds: false,
  build: buildAurora,
  roadTexture: auroraRoad,
  bloom: { strength: 0.8, radius: 0.6, threshold: 0.9 },
  physicalSky: false,
  sun: AURORA.moon,
  cloudShadows: 0,
  posts: false, // the theme brings its own reflector posts and snow poles
  headlamp: true,
};

const ALIEN_WORLD: Theme = {
  id: 'alien',
  skyTop: ALIEN.skyTop,
  skyHorizon: ALIEN.skyHorizon,
  haze: ALIEN.haze,
  fogNear: 220,
  fogFar: 5000,
  hemiSky: '#7fd8d4',
  hemiGround: '#5a2f7e',
  hemiIntensity: 1.0,
  sunColor: '#ffb27a',
  sunIntensity: 2.3,
  exposure: 1.05,
  groundColor: null, // the theme brings its own far plain
  clouds: false,
  build: buildAlien,
  roadTexture: alienRoad,
  bloom: { strength: 0.75, radius: 0.55, threshold: 1.0 },
  physicalSky: false, // custom dome: twin suns, ringed gas giant, moons
  sun: ALIEN.sun,
  cloudShadows: 0,
  update: alienUpdate,
  posts: false, // glowing alien beacons replace them
};

const NEONCITY: Theme = {
  id: 'neoncity',
  skyTop: NEON_CITY.skyTop,
  skyHorizon: NEON_CITY.skyHorizon,
  haze: NEON_CITY.haze,
  fogNear: NEON_CITY.fogNear,
  fogFar: NEON_CITY.fogFar,
  hemiSky: '#6f58b8',
  hemiGround: '#ff4f8a',
  hemiIntensity: 0.6,
  sunColor: '#6fd6ff', // no sun: a cool wash of city light from one side
  sunIntensity: 0.65,
  exposure: 1.1,
  groundColor: '#0a090e',
  clouds: false,
  cloudShadows: 0,
  build: buildNeonCity,
  roadTexture: neonCityRoad,
  bloom: { strength: 0.75, radius: 0.55, threshold: 1.0 },
  physicalSky: false,
  update: neonCityUpdate,
  sun: { elevation: 30, azimuth: 140 },
  posts: false, // street lamps and kerbs instead
  headlamp: true,
};

const ICELAND: Theme = {
  id: 'iceland',
  skyTop: '#7f9db6',
  skyHorizon: '#cdd5d9',
  haze: '#c4ccd0',
  fogNear: 300,
  fogFar: 4200,
  hemiSky: '#dde6ee',
  hemiGround: '#5b544c',
  hemiIntensity: 1.3,
  sunColor: '#f4efe6',
  sunIntensity: 2.0,
  exposure: 1.02,
  groundColor: '#4a4642',
  clouds: true,
  build: buildIceland,
  roadTexture: icelandRoad,
  // low, cool Nordic sun through a thin overcast
  sun: ICELAND_SUN,
  sky: { turbidity: 14, rayleigh: 0.4, mieCoefficient: 0.012, mieDirectionalG: 0.74, exposure: 0.42 },
  cloudShadows: 0.55,
};

const CRYSTAL_CANYON: Theme = {
  id: 'crystal',
  skyTop: CRYSTAL.skyTop,
  skyHorizon: CRYSTAL.skyHorizon,
  haze: CRYSTAL.haze,
  fogNear: 120,
  fogFar: 1700,
  hemiSky: '#c4b2ff',
  hemiGround: '#3b2c52',
  hemiIntensity: 2.6,
  sunColor: '#ffc9a3',
  sunIntensity: 2.2,
  exposure: 1.0,
  groundColor: '#3a2f4a',
  clouds: false, // the theme brings its own faceted clouds
  build: buildCrystal,
  roadTexture: crystalRoad,
  bloom: { strength: 0.55, radius: 0.55, threshold: 1.0 },
  physicalSky: false, // stylised dusk gradient dome
  sun: CRYSTAL.sun,
  cloudShadows: 0,
  posts: false, // glowing crystal markers replace them
};

const KYOTO: Theme = {
  id: 'kyoto',
  skyTop: '#8fb3dc',
  skyHorizon: '#f2d9cf',
  haze: '#efd3c6',
  fogNear: 140,
  fogFar: 1900,
  hemiSky: '#f4e6ee',
  hemiGround: '#6e7a48',
  hemiIntensity: 1.15,
  sunColor: '#ffc994',
  sunIntensity: 2.4,
  exposure: 1.05,
  groundColor: '#5f7c45',
  clouds: true,
  build: buildKyoto,
  roadTexture: kyotoRoad,
  // soft spring golden hour: low sun, light haze, pastel blue-peach sky
  sun: KYOTO_SUN,
  sky: { turbidity: 6, rayleigh: 1.3, mieCoefficient: 0.008, mieDirectionalG: 0.84, exposure: 0.34 },
  cloudShadows: 0.25,
  bloom: { strength: 0.5, radius: 0.55, threshold: 1.35 },
  posts: false, // stone lanterns line the path instead
};

const PATAGONIA: Theme = {
  id: 'patagonia',
  skyTop: '#1f5fc8',
  skyHorizon: '#b8d0e6',
  haze: '#b4cbe4',
  fogNear: 500,
  fogFar: 22000,
  hemiSky: '#d6e5ff',
  hemiGround: '#a58d5a',
  hemiIntensity: 0.85,
  sunColor: '#fff3e0',
  sunIntensity: 2.6,
  exposure: 1.0,
  groundColor: '#b39760',
  clouds: false, // the theme brings its own cumulus (above the towers) and lenticulars
  build: buildPatagonia,
  roadTexture: patagoniaRoad,
  // crisp, clear austral light: deep blue scattering sky, sun about 35 degrees up
  sun: PATAGONIA_SUN,
  sky: { turbidity: 1.0, rayleigh: 2.0, mieCoefficient: 0.001, mieDirectionalG: 0.75, exposure: 0.24 },
  cloudShadows: 0.55,
  posts: false,
};

const THEMES: Record<ThemeId, Theme> = { countryside: COUNTRYSIDE, bigsur: BIGSUR, redwoods: REDWOODS, zion: ZION, synthwave: SYNTHWAVE, aurora: AURORA_NIGHT, alien: ALIEN_WORLD, neoncity: NEONCITY, iceland: ICELAND, crystal: CRYSTAL_CANYON, kyoto: KYOTO, patagonia: PATAGONIA };

export function themeFor(route: Route): Theme {
  return THEMES[route.preset.theme ?? 'countryside'] ?? COUNTRYSIDE;
}
