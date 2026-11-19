// In-game screenshots of each route, shown on the route picker cards.
import type { RoutePresetId } from './route';
import rolling from '../assets/routes/rolling.jpg';
import bigsur from '../assets/routes/bigsur.jpg';
import redwoods from '../assets/routes/redwoods.jpg';
import zion from '../assets/routes/zion.jpg';
import synthwave from '../assets/routes/synthwave.jpg';
import aurora from '../assets/routes/aurora.jpg';
import patagonia from '../assets/routes/patagonia.jpg';

export const ROUTE_IMAGES: Record<RoutePresetId, string> = { rolling, bigsur, redwoods, zion, synthwave, aurora, patagonia };
