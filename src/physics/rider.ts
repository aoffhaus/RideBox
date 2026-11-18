// Power → speed model for moving along the virtual road.

export interface RiderParams {
  riderKg: number;
  bikeKg: number;
  cda: number; // m² (hoods ≈ 0.32, drops ≈ 0.28)
  crr: number; // rolling resistance (≈0.004 road tyres)
  rho: number; // air density kg/m³
  drivetrainLoss: number; // fraction
}

export const DEFAULT_RIDER: RiderParams = {
  riderKg: 75,
  bikeKg: 9,
  cda: 0.32,
  crr: 0.004,
  rho: 1.225,
  drivetrainLoss: 0.025,
};

const G = 9.80665;

/** Net resistive force (N) at speed v (m/s) and grade (rise/run, 0.05 = 5%). */
export function resistiveForce(v: number, grade: number, p: RiderParams): number {
  const m = p.riderKg + p.bikeKg;
  const th = Math.atan(grade);
  return m * G * Math.sin(th) + m * G * p.crr * Math.cos(th) + 0.5 * p.rho * p.cda * v * Math.abs(v);
}

/**
 * Advance speed by dt seconds given rider power. Includes inertia, so you
 * coast, accelerate and slow on climbs like on a real road.
 */
export function stepSpeed(v: number, power: number, grade: number, dt: number, p: RiderParams): number {
  const m = p.riderKg + p.bikeKg + 1.5; // + wheel rotational inertia equivalent
  const pEff = Math.max(0, power) * (1 - p.drivetrainLoss);
  // Integrate in small sub-steps for stability at low frame rates.
  const steps = Math.max(1, Math.ceil(dt / 0.05));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    const drive = pEff / Math.max(v, 1.0); // cap force at very low speed
    const a = (drive - resistiveForce(v, grade, p)) / m;
    v = Math.max(0, v + a * h);
  }
  return v;
}

/** Steady-state speed (m/s) for a constant power on a constant grade. */
export function steadySpeed(power: number, grade: number, p: RiderParams): number {
  const pEff = Math.max(0, power) * (1 - p.drivetrainLoss);
  let lo = 0;
  let hi = 40;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (mid * resistiveForce(mid, grade, p) > pEff) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}
