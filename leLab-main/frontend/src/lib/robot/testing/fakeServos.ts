// Test double: a bus of simulated STS3215 servos behind a fake Web Serial
// port, so tests drive the real WebSerialTransport and FeetechBus.

import {
  BROADCAST_ID,
  INST,
  STS_REGISTERS,
  decodeSignMagnitude,
  encodeSignMagnitude,
  fromBytes,
  toBytes,
} from "../feetechProtocol";

export function statusPacket(id: number, error: number, params: readonly number[]): number[] {
  const body = [id, params.length + 2, error, ...params];
  const sum = body.reduce((a, b) => a + b, 0);
  return [0xff, 0xff, ...body, ~sum & 0xff];
}

const [HOMING_ADDR] = STS_REGISTERS.Homing_Offset;
const [PRESENT_ADDR] = STS_REGISTERS.Present_Position;

class SimServo {
  memory = new Array<number>(100).fill(0);
  /** Encoder position before the homing offset is applied. */
  actual = 2048;

  constructor(readonly id: number) {
    this.setWord(STS_REGISTERS.Model_Number[0], 777);
    this.memory[STS_REGISTERS.Firmware_Major_Version[0]] = 3;
    this.memory[STS_REGISTERS.Firmware_Minor_Version[0]] = 10;
    this.setWord(STS_REGISTERS.Max_Position_Limit[0], 4095);
  }

  word(address: number): number {
    return fromBytes(this.memory.slice(address, address + 2));
  }

  setWord(address: number, value: number): void {
    [this.memory[address], this.memory[address + 1]] = toBytes(value, 2);
  }

  read(address: number, length: number): number[] {
    // Present_Position = Actual_Position - Homing_Offset (Feetech semantics).
    const homing = decodeSignMagnitude(this.word(HOMING_ADDR), 11);
    this.setWord(PRESENT_ADDR, encodeSignMagnitude(this.actual - homing, 15));
    return this.memory.slice(address, address + length);
  }

  write(address: number, data: readonly number[]): void {
    data.forEach((b, i) => (this.memory[address + i] = b));
  }
}

export class ServoBusSim {
  readonly servos = new Map<number, SimServo>();
  /** Every instruction packet received, for assertions. */
  readonly received: number[][] = [];

  constructor(ids: readonly number[] = [1, 2, 3, 4, 5, 6]) {
    for (const id of ids) this.servos.set(id, new SimServo(id));
  }

  servo(id: number): SimServo {
    const s = this.servos.get(id);
    if (!s) throw new Error(`no simulated servo ${id}`);
    return s;
  }

  /** Handle one instruction packet; returns the reply bytes (possibly several status packets). */
  handle(packet: readonly number[]): number[] {
    this.received.push([...packet]);
    const id = packet[2];
    const inst = packet[4];
    const params = packet.slice(5, packet.length - 1);
    const servo = this.servos.get(id);

    switch (inst) {
      case INST.PING:
        return servo ? statusPacket(id, 0, []) : [];
      case INST.READ:
        return servo ? statusPacket(id, 0, servo.read(params[0], params[1])) : [];
      case INST.WRITE:
        if (!servo) return [];
        servo.write(params[0], params.slice(1));
        return statusPacket(id, 0, []);
      case INST.SYNC_READ: {
        const [address, length, ...ids] = params;
        return ids.flatMap((i) => {
          const s = this.servos.get(i);
          return s ? statusPacket(i, 0, s.read(address, length)) : [];
        });
      }
      case INST.SYNC_WRITE: {
        const [address, length, ...rest] = params;
        for (let i = 0; i < rest.length; i += length + 1) {
          this.servos.get(rest[i])?.write(address, rest.slice(i + 1, i + 1 + length));
        }
        return [];
      }
      default:
        return id === BROADCAST_ID ? [] : servo ? statusPacket(id, 0, []) : [];
    }
  }
}

/**
 * Minimal SerialPort backed by a ServoBusSim. Replies are delivered
 * asynchronously and split into two chunks to exercise packet reassembly.
 */
export class FakeSerialPort extends EventTarget implements SerialPort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  openedWith: SerialOptions | null = null;
  closed = false;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  constructor(readonly sim: ServoBusSim) {
    super();
  }

  async open(options: SerialOptions): Promise<void> {
    this.openedWith = options;
    this.closed = false;
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        const reply = this.sim.handle([...chunk]);
        if (!reply.length) return;
        const cut = Math.ceil(reply.length / 2);
        setTimeout(() => {
          this.controller?.enqueue(Uint8Array.from(reply.slice(0, cut)));
          setTimeout(() => this.controller?.enqueue(Uint8Array.from(reply.slice(cut))), 0);
        }, 0);
      },
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.readable = null;
    this.writable = null;
  }

  getInfo(): SerialPortInfo {
    return {};
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
