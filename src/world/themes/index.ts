// Theme registry: per-route sky, light and scenery.
import type * as THREE from 'three';
import type { Route, ThemeId } from '../route';
import type { SkyParams } from '../sky';
import { buildBigSur, bigSurRoad } from './bigsur';
import { buildRedwoods, redwoodsRoad } from './redwoods';
import { SYNTH, buildSynthwave, synthwaveRoad, synthwaveUpdate } from './synthwave';
import { buildZion, zionRoad } from './zion';
import { NEON_CITY, buildNeonCity, neonCityRoad, neonCityUpdate } from './neoncity';

export interface ThemeBuildOptions {
  high: boolean;
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
  /** Per-frame animation hook for the theme's scenery (time in seconds). */
  update?: (time: number) => void;
  /** Sun position in degrees (azimuth from +x towards +z). Default ≈ 56° up, 32° round. */
  sun?: { elevation: number; azimuth: number };
  /** Scattering parameters for the physical sky. */
  sky?: Partial<SkyParams>;
  /** How much a passing cloud dims direct sunlight (0 = no cloud shadows). Default 0.45 when `clouds`. */
  cloudShadows?: number;
  /** false = no white reflector posts along the road edge. Default true. */
  posts?: boolean;
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
};

const THEMES: Record<ThemeId, Theme> = { countryside: COUNTRYSIDE, bigsur: BIGSUR, redwoods: REDWOODS, zion: ZION, synthwave: SYNTHWAVE, neoncity: NEONCITY };

export function themeFor(route: Route): Theme {
  return THEMES[route.preset.theme ?? 'countryside'] ?? COUNTRYSIDE;
}
