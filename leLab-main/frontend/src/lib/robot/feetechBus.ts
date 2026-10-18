// Feetech motor bus for the browser: the subset of lerobot's
// FeetechMotorsBus / MotorsBus (lerobot/motors/) that calibration and
// teleoperation use, with the same register semantics, sign encoding,
// normalization and retry behaviour.

import {
  NORMALIZED_REGISTERS,
  Register,
  SIGN_BITS,
  STS3215_MODEL_NUMBER,
  STS3215_RESOLUTION,
  STS_REGISTERS,
  StatusPacket,
  decodeSignMagnitude,
  encodeSignMagnitude,
  fromBytes,
  pingPacket,
  readPacket,
  syncReadPacket,
  syncWritePacket,
  toBytes,
  writePacket,
} from "./feetechProtocol";
import { CalibrationFile, NormMode, normalize, unnormalize } from "./normalization";
import { FeetechError, FeetechTimeoutError, Transport } from "./serialTransport";

export interface BusMotor {
  id: number;
  mode: NormMode;
}

/**
 * Reply timeout. lerobot patches the SDK's per-packet timeout to about 50 ms;
 * this allows extra headroom for browser timer jitter.
 */
const RESPONSE_TIMEOUT_MS = 100;

interface IoOptions {
  normalize?: boolean;
  retries?: number;
}

export class FeetechBus {
  calibration: CalibrationFile | null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly transport: Transport,
    readonly motors: Record<string, BusMotor>,
    calibration: CalibrationFile | null = null
  ) {
    this.calibration = calibration;
  }

  get motorNames(): string[] {
    return Object.keys(this.motors);
  }

  /** Run `fn` with the bus to itself, so request/reply pairs never interleave. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async request(packet: Uint8Array, replyId: number): Promise<StatusPacket> {
    this.transport.clearInput();
    await this.transport.write(packet);
    const deadline = performance.now() + RESPONSE_TIMEOUT_MS;
    for (;;) {
      const reply = await this.transport.readStatusPacket(deadline);
      if (reply.id === replyId) return reply;
    }
  }

  private motorId(motor: string): number {
    const m = this.motors[motor];
    if (!m) throw new FeetechError(`Unknown motor '${motor}'.`);
    return m.id;
  }

  private toUnits(motor: string, register: Register, raw: number, norm: boolean): number {
    const signBit = SIGN_BITS[register];
    const decoded = signBit === undefined ? raw : decodeSignMagnitude(raw, signBit);
    if (!norm || !NORMALIZED_REGISTERS.has(register)) return decoded;
    return normalize(motor, decoded, this.requireCalibration(motor), this.motors[motor].mode);
  }

  private toRaw(motor: string, register: Register, value: number, norm: boolean): number {
    const raw =
      norm && NORMALIZED_REGISTERS.has(register)
        ? unnormalize(motor, value, this.requireCalibration(motor), this.motors[motor].mode)
        : Math.trunc(value);
    const signBit = SIGN_BITS[register];
    return signBit === undefined ? raw : encodeSignMagnitude(raw, signBit);
  }

  private requireCalibration(motor: string) {
    const cal = this.calibration?.[motor];
    if (!cal) throw new FeetechError(`No calibration registered for motor '${motor}'.`);
    return cal;
  }

  /** Ping one motor; resolves to its model number, or null if it doesn't answer. */
  ping(id: number): Promise<number | null> {
    return this.exclusive(async () => {
      try {
        await this.request(pingPacket(id), id);
        const [address, length] = STS_REGISTERS.Model_Number;
        const reply = await this.request(readPacket(id, address, length), id);
        return fromBytes(reply.params.slice(0, length));
      } catch (e) {
        if (e instanceof FeetechTimeoutError) return null;
        throw e;
      }
    });
  }

  read(motor: string, register: Register, { normalize: norm = true, retries = 0 }: IoOptions = {}) {
    const id = this.motorId(motor);
    const [address, length] = STS_REGISTERS[register];
    return this.exclusive(async () => {
      const reply = await withRetries(retries, `read '${register}' from '${motor}'`, () =>
        this.request(readPacket(id, address, length), id)
      );
      if (reply.error) throw servoError(motor, reply.error);
      return this.toUnits(motor, register, fromBytes(reply.params.slice(0, length)), norm);
    });
  }

  write(
    motor: string,
    register: Register,
    value: number,
    { normalize: norm = true, retries = 0 }: IoOptions = {}
  ) {
    const id = this.motorId(motor);
    const [address, length] = STS_REGISTERS[register];
    const data = toBytes(this.toRaw(motor, register, value, norm), length);
    return this.exclusive(async () => {
      const reply = await withRetries(retries, `write '${register}' on '${motor}'`, () =>
        this.request(writePacket(id, address, data), id)
      );
      if (reply.error) throw servoError(motor, reply.error);
    });
  }

  /** Read one register from several motors in a single round trip. */
  syncRead(
    register: Register,
    motors: string[] = this.motorNames,
    { normalize: norm = true, retries = 0 }: IoOptions = {}
  ): Promise<Record<string, number>> {
    const ids = motors.map((m) => this.motorId(m));
    const [address, length] = STS_REGISTERS[register];
    return this.exclusive(async () => {
      const raw = await withRetries(retries, `sync read '${register}'`, async () => {
        this.transport.clearInput();
        await this.transport.write(syncReadPacket(address, length, ids));
        const deadline = performance.now() + RESPONSE_TIMEOUT_MS;
        const values: number[] = [];
        // Replies arrive one per motor, in request order (GroupSyncRead.rxPacket).
        for (const id of ids) {
          let reply: StatusPacket;
          do {
            reply = await this.transport.readStatusPacket(deadline);
          } while (reply.id !== id);
          values.push(fromBytes(reply.params.slice(0, length)));
        }
        return values;
      });
      return Object.fromEntries(motors.map((m, i) => [m, this.toUnits(m, register, raw[i], norm)]));
    });
  }

  /** Write one register on several motors; broadcast, so there is no reply. */
  syncWrite(register: Register, values: Record<string, number>, { normalize: norm = true }: IoOptions = {}) {
    const [address, length] = STS_REGISTERS[register];
    const entries = Object.entries(values).map(
      ([motor, value]) => [this.motorId(motor), toBytes(this.toRaw(motor, register, value, norm), length)] as const
    );
    return this.exclusive(() => this.transport.write(syncWritePacket(address, length, entries)));
  }

  /**
   * lerobot's handshake: every motor answers with the STS3215 model number
   * and all run the same firmware.
   */
  async connect(): Promise<void> {
    const missing: string[] = [];
    const wrongModel: string[] = [];
    for (const [motor, { id }] of Object.entries(this.motors)) {
      const model = await this.ping(id);
      if (model === null) missing.push(`${motor} (id ${id})`);
      else if (model !== STS3215_MODEL_NUMBER) wrongModel.push(`${motor} (id ${id}): model ${model}`);
    }
    if (missing.length || wrongModel.length) {
      const parts: string[] = [];
      if (missing.length) parts.push(`no answer from ${missing.join(", ")}`);
      if (wrongModel.length) parts.push(`unexpected motor model on ${wrongModel.join(", ")}`);
      throw new FeetechError(
        `Motor check failed: ${parts.join("; ")}. Make sure the arm is powered on and this is the right port.`
      );
    }

    const firmware = new Set<string>();
    for (const motor of this.motorNames) {
      const major = await this.read(motor, "Firmware_Major_Version", { normalize: false });
      const minor = await this.read(motor, "Firmware_Minor_Version", { normalize: false });
      firmware.add(`${major}.${minor}`);
    }
    if (firmware.size !== 1) {
      throw new FeetechError(
        `Motors use different firmware versions (${[...firmware].join(", ")}). ` +
          "Update their firmware with Feetech's software first."
      );
    }
  }

  async disableTorque(motors: string[] = this.motorNames, retries = 0): Promise<void> {
    for (const motor of motors) {
      await this.write(motor, "Torque_Enable", 0, { retries });
      await this.write(motor, "Lock", 0, { retries });
    }
  }

  async enableTorque(motors: string[] = this.motorNames, retries = 0): Promise<void> {
    for (const motor of motors) {
      await this.write(motor, "Torque_Enable", 1, { retries });
      await this.write(motor, "Lock", 1, { retries });
    }
  }

  /** FeetechMotorsBus.configure_motors (protocol 0, STS3215). */
  async configureMotors(): Promise<void> {
    for (const motor of this.motorNames) {
      // Minimum response delay (2 µs) instead of the 500 µs default.
      await this.write(motor, "Return_Delay_Time", 0);
      await this.write(motor, "Maximum_Acceleration", 254);
      await this.write(motor, "Acceleration", 254);
      // Angle feedback mode 0 keeps readings in [0, resolution - 1].
      const phase = await this.read(motor, "Phase", { normalize: false });
      if (phase & 0x10) await this.write(motor, "Phase", phase & ~0x10);
    }
  }

  /** Factory calibration: no homing offset, full position range. */
  async resetCalibration(): Promise<void> {
    for (const motor of this.motorNames) {
      await this.write(motor, "Homing_Offset", 0, { normalize: false });
      await this.write(motor, "Min_Position_Limit", 0, { normalize: false });
      await this.write(motor, "Max_Position_Limit", STS3215_RESOLUTION - 1, { normalize: false });
    }
    this.calibration = null;
  }

  async writeCalibration(calibration: CalibrationFile): Promise<void> {
    for (const [motor, cal] of Object.entries(calibration)) {
      await this.write(motor, "Homing_Offset", cal.homing_offset);
      await this.write(motor, "Min_Position_Limit", cal.range_min);
      await this.write(motor, "Max_Position_Limit", cal.range_max);
    }
    this.calibration = calibration;
  }

  /** Optionally release torque (as lerobot does on disconnect), then close the port. */
  async disconnect(releaseTorque = true): Promise<void> {
    try {
      if (releaseTorque) await this.disableTorque(this.motorNames, 5);
    } finally {
      await this.transport.close();
    }
  }
}

async function withRetries<T>(retries: number, what: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
    }
  }
  if (lastError instanceof FeetechTimeoutError) {
    throw new FeetechTimeoutError(`Failed to ${what}: no response from the motors.`);
  }
  throw lastError;
}

const SERVO_ERROR_BITS: [number, string][] = [
  [1, "input voltage"],
  [2, "angle sensor"],
  [4, "overheat"],
  [8, "overcurrent"],
  [32, "overload"],
];

function servoError(motor: string, error: number): FeetechError {
  const reasons = SERVO_ERROR_BITS.filter(([bit]) => error & bit).map(([, name]) => name);
  return new FeetechError(`Motor '${motor}' reported an error: ${reasons.join(", ") || `code ${error}`}.`);
}
