import { parseText } from './parsers/text';
import type { Workout } from './model';

// Starter workouts (original, written in RideBox shorthand).
const SRC: { text: string; description: string }[] = [
  {
    description: 'Three 12-minute sweet spot intervals. Classic FTP builder.',
    text: `# Sweet Spot 3x12
10m 45-70%
3x(12m @90% "Sweet spot", 4m @50% "Recover")
8m 60-40%`,
  },
  {
    description: 'Five 3-minute VO2max efforts with equal recovery.',
    text: `# VO2 Max 5x3
10m 45-75%
3m @50%
5x(3m @120% 100rpm "VO2", 3m @45% "Easy spin")
10m 55-40%`,
  },
  {
    description: 'Steady aerobic endurance with a few cadence drills.',
    text: `# Endurance 60
5m 45-65%
15m @68%
4x(1m @68% 105rpm "High cadence", 2m @68%)
13m @70%
10m @68%
5m 60-45%`,
  },
  {
    description: 'Over-unders: alternate just above and below threshold.',
    text: `# Over-Unders 3x9
10m 45-70%
3x(2m @95% "Under", 1m @108% "Over", 2m @95%, 1m @108%, 2m @95%, 1m @108%, 5m @50% "Recover")
8m 60-40%`,
  },
  {
    description: 'Ramp test: +6% FTP every minute until you can’t. Set new FTP ≈ 75% of best minute.',
    text: `# Ramp Test
5m @45%
3m @55%
1m @60%
1m @66%
1m @72%
1m @78%
1m @84%
1m @90%
1m @96%
1m @102%
1m @108%
1m @114%
1m @120%
1m @126%
1m @132%
1m @138%
1m @144%
1m @150%
1m @156%
1m @162%
1m @168%
5m @40%`,
  },
  {
    description: 'Short and sharp: 30/30s for when time is tight.',
    text: `# 30/30s
10m 45-70%
2x(8x(30s @130%, 30s @50%), 5m @50%)
5m 55-40%`,
  },
];

export const BUILTIN_WORKOUTS: Workout[] = SRC.map(({ text, description }) => ({
  ...parseText(text),
  description,
  author: 'RideBox',
}));
