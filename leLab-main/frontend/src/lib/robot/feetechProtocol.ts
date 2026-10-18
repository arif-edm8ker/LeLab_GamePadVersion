// Feetech STS/SMS servo protocol (protocol 0), as spoken by the SO-101's
// STS3215 motors. Byte-for-byte port of the packet framing in scservo_sdk
// (protocol_packet_handler.py) and the register tables lerobot uses
// (lerobot/motors/feetech/tables.py). Pure functions only; the serial I/O
// lives in serialTransport.ts.

export const BROADCAST_ID = 0xfe;

export const INST = {
  PING: 0x01,
  READ: 0x02,
  WRITE: 0x03,
  SYNC_READ: 0x82,
  SYNC_WRITE: 0x83,
} as const;

/** STS3215 control table subset: [address, byte length]. */
export const STS_REGISTERS = {
  Firmware_Major_Version: [0, 1],
  Firmware_Minor_Version: [1, 1],
  Model_Number: [3, 2],
  Return_Delay_Time: [7, 1],
  Min_Position_Limit: [9, 2],
  Max_Position_Limit: [11, 2],
  Max_Torque_Limit: [16, 2],
  Phase: [18, 1],
  P_Coefficient: [21, 1],
  D_Coefficient: [22, 1],
  I_Coefficient: [23, 1],
  Protection_Current: [28, 2],
  Homing_Offset: [31, 2],
  Operating_Mode: [33, 1],
  Overload_Torque: [36, 1],
  Torque_Enable: [40, 1],
  Acceleration: [41, 1],
  Goal_Position: [42, 2],
  Lock: [55, 1],
  Present_Position: [56, 2],
  Maximum_Acceleration: [85, 1],
} as const satisfies Record<string, readonly [number, 1 | 2]>;

export type Register = keyof typeof STS_REGISTERS;

/** Registers stored as sign-magnitude, with their sign bit (STS_SMS_SERIES_ENCODINGS_TABLE). */
export const SIGN_BITS: Partial<Record<Register, number>> = {
  Homing_Offset: 11,
  Goal_Position: 15,
  Present_Position: 15,
};

/** Registers that lerobot converts to degrees / 0-100 (NORMALIZED_DATA). */
export const NORMALIZED_REGISTERS: ReadonlySet<Register> = new Set<Register>([
  "Goal_Position",
  "Present_Position",
]);

export const STS3215_MODEL_NUMBER = 777;
export const STS3215_RESOLUTION = 4096;

const MAX_PACKET_LENGTH = 250;

/** Frame an instruction packet: FF FF ID LEN INST PARAMS... CHECKSUM. */
export function buildPacket(id: number, instruction: number, params: readonly number[] = []): Uint8Array {
  const body = [id, params.length + 2, instruction, ...params];
  const sum = body.reduce((acc, b) => acc + b, 0);
  return Uint8Array.from([0xff, 0xff, ...body, ~sum & 0xff]);
}

export const pingPacket = (id: number) => buildPacket(id, INST.PING);

export const readPacket = (id: number, address: number, length: number) =>
  buildPacket(id, INST.READ, [address, length]);

export const writePacket = (id: number, address: number, data: readonly number[]) =>
  buildPacket(id, INST.WRITE, [address, ...data]);

export const syncReadPacket = (address: number, length: number, ids: readonly number[]) =>
  buildPacket(BROADCAST_ID, INST.SYNC_READ, [address, length, ...ids]);

export const syncWritePacket = (
  address: number,
  length: number,
  entries: readonly (readonly [id: number, data: readonly number[]])[]
) =>
  buildPacket(BROADCAST_ID, INST.SYNC_WRITE, [
    address,
    length,
    ...entries.flatMap(([id, data]) => [id, ...data]),
  ]);

/** Little-endian bytes, as scservo_sdk's SCS_LOBYTE/SCS_HIBYTE (SCS_END = 0). */
export function toBytes(value: number, length: 1 | 2): number[] {
  return length === 1 ? [value & 0xff] : [value & 0xff, (value >> 8) & 0xff];
}

export function fromBytes(bytes: readonly number[]): number {
  return bytes.reduce((acc, b, i) => acc | (b << (8 * i)), 0);
}

export function encodeSignMagnitude(value: number, signBit: number): number {
  const maxMagnitude = (1 << signBit) - 1;
  const magnitude = Math.abs(value);
  if (magnitude > maxMagnitude) {
    throw new RangeError(`Magnitude ${magnitude} exceeds ${maxMagnitude} (max for sign bit ${signBit})`);
  }
  return ((value < 0 ? 1 : 0) << signBit) | magnitude;
}

export function decodeSignMagnitude(encoded: number, signBit: number): number {
  const magnitude = encoded & ((1 << signBit) - 1);
  return (encoded >> signBit) & 1 ? -magnitude : magnitude;
}

export interface StatusPacket {
  id: number;
  error: number;
  params: number[];
}

export interface ParseResult {
  packet: StatusPacket | null;
  /** Leading bytes the caller should drop (garbage, or the parsed packet). */
  consumed: number;
  /** A complete packet arrived but its checksum didn't match. */
  corrupt?: boolean;
}

/**
 * Find the first complete status packet in `buf`, resyncing past garbage the
 * same way scservo_sdk's rxPacket does: a header with an impossible ID,
 * length or error byte is skipped one byte at a time.
 */
export function parseStatusPacket(buf: readonly number[]): ParseResult {
  let from = 0;
  for (;;) {
    let header = -1;
    for (let i = from; i + 1 < buf.length; i++) {
      if (buf[i] === 0xff && buf[i + 1] === 0xff) {
        header = i;
        break;
      }
    }
    if (header < 0) {
      // Keep a trailing 0xFF: it may be the first byte of the next header.
      const keep = buf.length > 0 && buf[buf.length - 1] === 0xff ? 1 : 0;
      return { packet: null, consumed: buf.length - keep };
    }
    if (buf.length - header < 6) return { packet: null, consumed: header };

    const id = buf[header + 2];
    const length = buf[header + 3];
    const error = buf[header + 4];
    if (id > 0xfd || length < 2 || length > MAX_PACKET_LENGTH || error > 0x7f) {
      from = header + 1;
      continue;
    }

    const total = length + 4;
    if (buf.length - header < total) return { packet: null, consumed: header };

    let sum = 0;
    for (let i = header + 2; i < header + total - 1; i++) sum += buf[i];
    if ((~sum & 0xff) !== buf[header + total - 1]) {
      return { packet: null, consumed: header + total, corrupt: true };
    }
    return {
      packet: { id, error, params: buf.slice(header + 5, header + total - 1) },
      consumed: header + total,
    };
  }
}
