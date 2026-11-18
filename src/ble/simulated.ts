import type { ConnState, HeartRateMonitor, Trainer, TrainerSample } from './types';

/**
 * Fake trainer + HRM for trying the app without hardware.
 * ERG: follows the target with a little noise and lag.
 * SIM / free ride: rides at `manualPower` (change with [ and ] keys).
 */
export class SimulatedTrainer implements Trainer {
  kind = 'simulated' as const;
  name = 'Simulated trainer';
  canControl = true;
  onData?: (s: TrainerSample) => void;
  onState?: (s: ConnState) => void;
  manualPower = 180;
  private target: number | null = null;
  private power = 0;
  private timer: number;
  hr = 70;

  constructor(private speedFactor = 1) {
    this.timer = window.setInterval(() => this.tick(0.25 * this.speedFactor), 250);
    queueMicrotask(() => this.onState?.('connected'));
  }

  private tick(dt: number) {
    const goal = this.target ?? this.manualPower;
    this.power += (goal - this.power) * Math.min(1, dt * 1.5);
    const noisy = Math.max(0, Math.round(this.power + (Math.random() - 0.5) * 8));
    const hrGoal = 62 + noisy * 0.42;
    this.hr += (hrGoal - this.hr) * Math.min(1, dt / 25);
    this.onData?.({ power: noisy, cadence: noisy > 5 ? Math.round(88 + (Math.random() - 0.5) * 4) : 0 });
  }

  async setTargetPower(watts: number) {
    this.target = watts;
  }
  async setGrade(_grade: number) {
    this.target = null;
  }
  disconnect() {
    window.clearInterval(this.timer);
    this.onState?.('disconnected');
  }
}

export class SimulatedHrm implements HeartRateMonitor {
  name = 'Simulated HRM';
  onHeartRate?: (bpm: number) => void;
  onState?: (s: ConnState) => void;
  private timer: number;
  constructor(trainer: SimulatedTrainer) {
    this.timer = window.setInterval(() => this.onHeartRate?.(Math.round(trainer.hr)), 1000);
    queueMicrotask(() => this.onState?.('connected'));
  }
  disconnect() {
    window.clearInterval(this.timer);
    this.onState?.('disconnected');
  }
}
