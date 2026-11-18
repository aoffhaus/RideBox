export type ConnState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface TrainerSample {
  power: number;
  cadence: number;
  speedKmh?: number;
  heartRate?: number;
}

export interface Trainer {
  readonly kind: 'ftms' | 'wahoo' | 'power-only' | 'simulated';
  readonly name: string;
  readonly canControl: boolean;
  onData?: (s: TrainerSample) => void;
  onState?: (s: ConnState) => void;
  /** ERG: hold this many watts. */
  setTargetPower(watts: number): Promise<void>;
  /** SIM: road grade (0.05 = 5%) — trainer adjusts resistance. */
  setGrade(grade: number): Promise<void>;
  disconnect(): void;
}

export interface HeartRateMonitor {
  readonly name: string;
  onHeartRate?: (bpm: number) => void;
  onState?: (s: ConnState) => void;
  disconnect(): void;
}
