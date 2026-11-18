// Pure packet parsers / encoders for the BLE services (unit tested).

export interface BikeData {
  power?: number; // W
  cadence?: number; // rpm
  speed?: number; // km/h (trainer-reported wheel speed)
  heartRate?: number;
}

/** FTMS Indoor Bike Data (0x2AD2). */
export function parseIndoorBikeData(dv: DataView): BikeData {
  const flags = dv.getUint16(0, true);
  let o = 2;
  const out: BikeData = {};
  // bit 0 "More Data": when 0, Instantaneous Speed IS present
  if (!(flags & 0x0001)) {
    out.speed = dv.getUint16(o, true) / 100;
    o += 2;
  }
  if (flags & 0x0002) o += 2; // average speed
  if (flags & 0x0004) {
    out.cadence = dv.getUint16(o, true) / 2;
    o += 2;
  }
  if (flags & 0x0008) o += 2; // average cadence
  if (flags & 0x0010) o += 3; // total distance (uint24)
  if (flags & 0x0020) o += 2; // resistance level
  if (flags & 0x0040) {
    out.power = dv.getInt16(o, true);
    o += 2;
  }
  if (flags & 0x0080) o += 2; // average power
  if (flags & 0x0100) o += 5; // expended energy (total u16, per hour u16, per minute u8)
  if (flags & 0x0200) {
    out.heartRate = dv.getUint8(o);
    o += 1;
  }
  return out;
}

/** Heart Rate Measurement (0x2A37). */
export function parseHeartRate(dv: DataView): number {
  const flags = dv.getUint8(0);
  return flags & 0x01 ? dv.getUint16(1, true) : dv.getUint8(1);
}

export interface CrankState {
  revs: number;
  time: number; // 1/1024 s
  lastCadence: number;
  lastChange: number; // ms timestamp of last crank event
}

/** Cycling Power Measurement (0x2A63) → power and (from crank revs) cadence. */
export function parseCyclingPower(dv: DataView, crank: CrankState | null, nowMs: number): { power: number; cadence?: number; crank: CrankState | null } {
  const flags = dv.getUint16(0, true);
  const power = dv.getInt16(2, true);
  let o = 4;
  if (flags & 0x0001) o += 1; // pedal power balance
  if (flags & 0x0004) o += 2; // accumulated torque
  if (flags & 0x0010) o += 6; // wheel revolution data
  let cadence: number | undefined;
  let next = crank;
  if (flags & 0x0020) {
    const revs = dv.getUint16(o, true);
    const time = dv.getUint16(o + 2, true);
    if (crank) {
      const dRevs = (revs - crank.revs + 65536) % 65536;
      const dTime = (time - crank.time + 65536) % 65536;
      if (dRevs > 0 && dTime > 0) {
        cadence = Math.round((dRevs * 1024 * 60) / dTime);
        next = { revs, time, lastCadence: cadence, lastChange: nowMs };
      } else {
        // no new crank event: hold cadence briefly, then fall to 0
        cadence = nowMs - crank.lastChange > 2500 ? 0 : crank.lastCadence;
        next = { ...crank, revs, time };
      }
    } else {
      next = { revs, time, lastCadence: 0, lastChange: nowMs };
    }
  }
  return { power, cadence, crank: next };
}

// ---- FTMS control point (0x2AD9) ----

export const FTMS_OP = {
  REQUEST_CONTROL: 0x00,
  RESET: 0x01,
  SET_TARGET_POWER: 0x05,
  START_RESUME: 0x07,
  STOP_PAUSE: 0x08,
  SET_SIMULATION: 0x11,
  RESPONSE: 0x80,
} as const;

export function ftmsTargetPower(watts: number): Uint8Array {
  const b = new DataView(new ArrayBuffer(3));
  b.setUint8(0, FTMS_OP.SET_TARGET_POWER);
  b.setInt16(1, Math.round(Math.max(0, Math.min(2000, watts))), true);
  return new Uint8Array(b.buffer);
}

/**
 * Indoor bike simulation parameters.
 * grade: rise/run (0.05 = 5%), windSpeed m/s, crr, cw = wind resistance coefficient (kg/m)
 */
export function ftmsSimulation(grade: number, crr = 0.004, cw = 0.51, windSpeed = 0): Uint8Array {
  const b = new DataView(new ArrayBuffer(7));
  b.setUint8(0, FTMS_OP.SET_SIMULATION);
  b.setInt16(1, Math.round(windSpeed * 1000), true);
  b.setInt16(3, Math.round(Math.max(-0.4, Math.min(0.4, grade)) * 10000), true); // 0.01 %
  b.setUint8(5, Math.round(crr * 10000));
  b.setUint8(6, Math.round(cw * 100));
  return new Uint8Array(b.buffer);
}

// ---- Wahoo proprietary trainer characteristic (fallback when FTMS is absent) ----

export const WAHOO = {
  SERVICE: 'a026ee0b-0a7d-4ab3-97fa-f1500f9feb8b',
  TRAINER_CHAR: 'a026e005-0a7d-4ab3-97fa-f1500f9feb8b',
  UNLOCK: new Uint8Array([0x20, 0xee, 0xfc]),
};

export function wahooErg(watts: number): Uint8Array {
  const b = new DataView(new ArrayBuffer(3));
  b.setUint8(0, 0x42);
  b.setUint16(1, Math.round(Math.max(0, Math.min(2000, watts))), true);
  return new Uint8Array(b.buffer);
}

export function wahooSimMode(totalKg: number, crr: number, windCoeff: number): Uint8Array {
  const b = new DataView(new ArrayBuffer(7));
  b.setUint8(0, 0x43);
  b.setUint16(1, Math.round(totalKg * 100), true);
  b.setUint16(3, Math.round(crr * 10000), true);
  b.setUint16(5, Math.round(windCoeff * 1000), true);
  return new Uint8Array(b.buffer);
}

export function wahooSimGrade(grade: number): Uint8Array {
  const g = Math.max(-1, Math.min(1, grade));
  const b = new DataView(new ArrayBuffer(3));
  b.setUint8(0, 0x46);
  b.setUint16(1, Math.min(65535, Math.round(((g + 1) * 65536) / 2)), true);
  return new Uint8Array(b.buffer);
}
