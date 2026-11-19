import type { ConnState, HeartRateMonitor, Trainer, TrainerSample } from './types';
import {
  FTMS_OP,
  WAHOO,
  ftmsSimulation,
  ftmsTargetPower,
  parseCyclingPower,
  parseHeartRate,
  parseIndoorBikeData,
  wahooErg,
  wahooSimGrade,
  wahooSimMode,
  type CrankState,
} from './parse';

const FTMS = 0x1826;
const INDOOR_BIKE_DATA = 0x2ad2;
const FTMS_CONTROL_POINT = 0x2ad9;
const CYCLING_POWER = 0x1818;
const CP_MEASUREMENT = 0x2a63;
const HEART_RATE = 0x180d;
const HR_MEASUREMENT = 0x2a37;

export const bluetoothAvailable = () => typeof navigator !== 'undefined' && !!navigator.bluetooth;

/** Serialises GATT writes (Chrome rejects concurrent operations). */
class WriteQueue {
  private chain: Promise<unknown> = Promise.resolve();
  push(fn: () => Promise<unknown>): Promise<void> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p.then(() => undefined);
  }
}

/** Keeps a device connected: re-runs `setup` after unexpected disconnects. */
async function keepConnected(
  device: BluetoothDevice,
  setup: (server: BluetoothRemoteGATTServer) => Promise<void>,
  onState: (s: ConnState) => void,
  isClosed: () => boolean,
) {
  const connect = async () => {
    const server = await device.gatt!.connect();
    await setup(server);
    onState('connected');
  };
  device.addEventListener('gattserverdisconnected', async () => {
    if (isClosed()) return onState('disconnected');
    onState('reconnecting');
    for (let attempt = 1; attempt <= 20 && !isClosed(); attempt++) {
      try {
        await new Promise((r) => setTimeout(r, Math.min(5000, 500 * attempt)));
        await connect();
        return;
      } catch {
        /* retry */
      }
    }
    onState('disconnected');
  });
  onState('connecting');
  await connect();
}

class BleTrainer implements Trainer {
  kind: Trainer['kind'] = 'power-only';
  canControl = false;
  onData?: (s: TrainerSample) => void;
  onState?: (s: ConnState) => void;
  private closed = false;
  private q = new WriteQueue();
  private cp?: BluetoothRemoteGATTCharacteristic; // FTMS control point or Wahoo trainer char
  private lastCmd: { mode: 'erg'; watts: number } | { mode: 'sim'; grade: number } | null = null;
  private wahooSimReady = false;
  private crank: CrankState | null = null;
  private last: TrainerSample = { power: 0, cadence: 0 };
  private lastDataAt = 0;
  private watchdog?: number;

  constructor(private device: BluetoothDevice, private riderKg: () => number) {}

  get name() {
    return this.device.name ?? 'Trainer';
  }

  async start() {
    await keepConnected(this.device, (s) => this.setup(s), (s) => this.onState?.(s), () => this.closed);
    // If the trainer stops sending (e.g. you stop pedalling), report zeros.
    this.watchdog = window.setInterval(() => {
      if (performance.now() - this.lastDataAt > 3000 && this.last.power !== 0) {
        this.last = { ...this.last, power: 0, cadence: 0 };
        this.onData?.(this.last);
      }
    }, 1000);
  }

  private emit(s: Partial<TrainerSample>) {
    this.last = { ...this.last, ...s };
    this.lastDataAt = performance.now();
    this.onData?.(this.last);
  }

  private async setup(server: BluetoothRemoteGATTServer) {
    this.cp = undefined;
    this.wahooSimReady = false;
    const services = await server.getPrimaryServices().catch(() => [] as BluetoothRemoteGATTService[]);
    const has = (uuid: number | string) =>
      services.find((s) => s.uuid === (typeof uuid === 'number' ? BluetoothUUID.getService(uuid) : uuid));

    const ftms = has(FTMS);
    if (ftms) {
      const data = await ftms.getCharacteristic(INDOOR_BIKE_DATA);
      data.addEventListener('characteristicvaluechanged', (e) => {
        const d = parseIndoorBikeData((e.target as BluetoothRemoteGATTCharacteristic).value!);
        this.emit({
          ...(d.power !== undefined ? { power: d.power } : {}),
          ...(d.cadence !== undefined ? { cadence: d.cadence } : {}),
          ...(d.speed !== undefined ? { speedKmh: d.speed } : {}),
        });
      });
      await data.startNotifications();
      try {
        const cp = await ftms.getCharacteristic(FTMS_CONTROL_POINT);
        cp.addEventListener('characteristicvaluechanged', (e) => {
          const v = (e.target as BluetoothRemoteGATTCharacteristic).value!;
          if (v.getUint8(0) === FTMS_OP.RESPONSE && v.getUint8(2) !== 0x01) {
            console.warn('FTMS command 0x' + v.getUint8(1).toString(16) + ' failed, result', v.getUint8(2));
          }
        });
        await cp.startNotifications();
        await cp.writeValueWithResponse(new Uint8Array([FTMS_OP.REQUEST_CONTROL]));
        await cp.writeValueWithResponse(new Uint8Array([FTMS_OP.START_RESUME]));
        this.cp = cp;
        this.kind = 'ftms';
        this.canControl = true;
      } catch (err) {
        console.warn('FTMS control unavailable', err);
        this.kind = 'power-only';
      }
      await this.reapply();
      return;
    }

    const power = has(CYCLING_POWER);
    if (power) {
      const m = await power.getCharacteristic(CP_MEASUREMENT);
      m.addEventListener('characteristicvaluechanged', (e) => {
        const r = parseCyclingPower((e.target as BluetoothRemoteGATTCharacteristic).value!, this.crank, performance.now());
        this.crank = r.crank;
        this.emit({ power: r.power, ...(r.cadence !== undefined ? { cadence: r.cadence } : {}) });
      });
      await m.startNotifications();
      // Wahoo's own control characteristic (older KICKR firmware without FTMS)
      const wahooChar =
        (await power.getCharacteristic(WAHOO.TRAINER_CHAR).catch(() => undefined)) ??
        (await has(WAHOO.SERVICE)?.getCharacteristic(WAHOO.TRAINER_CHAR).catch(() => undefined));
      if (wahooChar) {
        try {
          await wahooChar.startNotifications().catch(() => undefined);
          await wahooChar.writeValueWithResponse(WAHOO.UNLOCK);
          this.cp = wahooChar;
          this.kind = 'wahoo';
          this.canControl = true;
        } catch (err) {
          console.warn('Wahoo control unavailable', err);
        }
      }
      await this.reapply();
      return;
    }
    throw new Error('This device has no FTMS or Cycling Power service');
  }

  private async reapply() {
    const c = this.lastCmd;
    this.lastCmd = null;
    if (c?.mode === 'erg') await this.setTargetPower(c.watts);
    else if (c?.mode === 'sim') await this.setGrade(c.grade);
  }

  async setTargetPower(watts: number) {
    const w = Math.round(watts);
    if (this.lastCmd?.mode === 'erg' && this.lastCmd.watts === w) return;
    this.lastCmd = { mode: 'erg', watts: w };
    this.wahooSimReady = false;
    const cp = this.cp;
    if (!cp) return;
    const payload = this.kind === 'ftms' ? ftmsTargetPower(w) : wahooErg(w);
    await this.q.push(() => cp.writeValueWithResponse(payload)).catch((e) => console.warn('ERG write failed', e));
  }

  async setGrade(grade: number) {
    const g = Math.round(grade * 1000) / 1000; // 0.1 % resolution
    if (this.lastCmd?.mode === 'sim' && Math.abs(this.lastCmd.grade - g) < 0.001) return;
    this.lastCmd = { mode: 'sim', grade: g };
    const cp = this.cp;
    if (!cp) return;
    if (this.kind === 'ftms') {
      await this.q.push(() => cp.writeValueWithResponse(ftmsSimulation(g))).catch((e) => console.warn('SIM write failed', e));
    } else {
      if (!this.wahooSimReady) {
        this.wahooSimReady = true;
        await this.q.push(() => cp.writeValueWithResponse(wahooSimMode(this.riderKg() + 9, 0.004, 0.51))).catch(() => undefined);
      }
      await this.q.push(() => cp.writeValueWithResponse(wahooSimGrade(g))).catch((e) => console.warn('SIM write failed', e));
    }
  }

  disconnect() {
    this.closed = true;
    window.clearInterval(this.watchdog);
    this.device.gatt?.disconnect();
  }
}

class BleHrm implements HeartRateMonitor {
  onHeartRate?: (bpm: number) => void;
  onState?: (s: ConnState) => void;
  private closed = false;
  constructor(private device: BluetoothDevice) {}
  get name() {
    return this.device.name ?? 'Heart rate';
  }
  async start() {
    await keepConnected(
      this.device,
      async (server) => {
        const svc = await server.getPrimaryService(HEART_RATE);
        const ch = await svc.getCharacteristic(HR_MEASUREMENT);
        ch.addEventListener('characteristicvaluechanged', (e) =>
          this.onHeartRate?.(parseHeartRate((e.target as BluetoothRemoteGATTCharacteristic).value!)),
        );
        await ch.startNotifications();
      },
      (s) => this.onState?.(s),
      () => this.closed,
    );
  }
  disconnect() {
    this.closed = true;
    this.device.gatt?.disconnect();
  }
}

/** Thrown when the Mac's Bluetooth is off or Chrome isn't allowed to use it. */
export class BluetoothOffError extends Error {
  name = 'BluetoothOffError';
}

async function assertBluetoothOn() {
  const ok = await navigator.bluetooth.getAvailability?.().catch(() => true);
  if (ok === false) {
    throw new BluetoothOffError(
      'Bluetooth is off or Chrome is not allowed to use it. Turn Bluetooth on, then check System Settings → Privacy & Security → Bluetooth → Google Chrome.',
    );
  }
}

/** Opens Chrome's device picker for a smart trainer. Must be called from a click. */
/**
 * `showAll` lists every nearby Bluetooth device instead of only ones advertising
 * the expected service, for devices whose advertisement Chrome doesn't match.
 */
export async function pairTrainer(
  riderKg: () => number,
  onState?: (s: ConnState) => void,
  showAll = false,
): Promise<Trainer> {
  await assertBluetoothOn();
  const optionalServices = [FTMS, CYCLING_POWER, WAHOO.SERVICE];
  const device = await navigator.bluetooth.requestDevice(
    showAll
      ? { acceptAllDevices: true, optionalServices }
      : {
          filters: [{ services: [FTMS] }, { services: [CYCLING_POWER] }, { namePrefix: 'KICKR' }, { namePrefix: 'Wahoo' }],
          optionalServices,
        },
  );
  const t = new BleTrainer(device, riderKg);
  t.onState = onState;
  await t.start();
  return t;
}

export async function pairHeartRate(onState?: (s: ConnState) => void, showAll = false): Promise<HeartRateMonitor> {
  await assertBluetoothOn();
  const device = await navigator.bluetooth.requestDevice(
    showAll
      ? { acceptAllDevices: true, optionalServices: [HEART_RATE] }
      : { filters: [{ services: [HEART_RATE] }], optionalServices: [HEART_RATE] },
  );
  const h = new BleHrm(device);
  h.onState = onState;
  await h.start();
  return h;
}
