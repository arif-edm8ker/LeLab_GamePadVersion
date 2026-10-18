// Byte transport for the Feetech bus over the Web Serial API. A background
// read loop collects incoming bytes; transactions wait for complete status
// packets with a deadline. FeetechBus serializes transactions, so one
// transport only ever has a single request in flight.

import { parseStatusPacket, StatusPacket } from "./feetechProtocol";

export class FeetechError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeetechError";
  }
}

export class FeetechTimeoutError extends FeetechError {
  constructor(message = "No response from the motors (timed out).") {
    super(message);
    this.name = "FeetechTimeoutError";
  }
}

/** What FeetechBus needs from a transport; tests provide a simulated one. */
export interface Transport {
  /** Drop any unread input (stale replies from an earlier, failed transaction). */
  clearInput(): void;
  write(bytes: Uint8Array): Promise<void>;
  /** Resolve with the next status packet, or reject at `deadline` (a performance.now() time). */
  readStatusPacket(deadline: number): Promise<StatusPacket>;
  close(): Promise<void>;
}

/** SO-101 bus baud rate (lerobot FeetechMotorsBus DEFAULT_BAUDRATE). */
export const FEETECH_BAUDRATE = 1_000_000;

export class WebSerialTransport implements Transport {
  private buffer: number[] = [];
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readLoop: Promise<void> | null = null;
  private waiters = new Set<() => void>();
  private lost: Error | null = null;

  constructor(readonly port: SerialPort) {}

  async open(baudRate = FEETECH_BAUDRATE): Promise<void> {
    await this.port.open({ baudRate });
    if (!this.port.readable || !this.port.writable) {
      throw new FeetechError("The serial port opened without readable/writable streams.");
    }
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this.readLoop = this.runReadLoop(this.reader);
  }

  private async runReadLoop(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          for (const b of value) this.buffer.push(b);
          this.notify();
        }
      }
    } catch (e) {
      // Unplugged mid-session: the stream errors with a NetworkError.
      this.lost = e instanceof Error ? e : new Error(String(e));
    } finally {
      reader.releaseLock();
      this.notify();
    }
  }

  private notify(): void {
    for (const wake of [...this.waiters]) wake();
  }

  private waitForData(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.waiters.add(wake);
    });
  }

  clearInput(): void {
    this.buffer = [];
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.writer) throw new FeetechError("Serial port is not open.");
    await this.writer.write(bytes);
  }

  async readStatusPacket(deadline: number): Promise<StatusPacket> {
    for (;;) {
      const { packet, consumed, corrupt } = parseStatusPacket(this.buffer);
      if (consumed > 0) this.buffer.splice(0, consumed);
      if (corrupt) throw new FeetechError("Received a corrupted reply from the motors.");
      if (packet) return packet;
      if (this.lost) throw new FeetechError(`Lost connection to the serial device: ${this.lost.message}`);
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new FeetechTimeoutError();
      await this.waitForData(remaining);
    }
  }

  async close(): Promise<void> {
    try {
      await this.reader?.cancel();
    } catch {
      /* already errored or released */
    }
    await this.readLoop;
    try {
      this.writer?.releaseLock();
    } catch {
      /* already released */
    }
    this.reader = null;
    this.writer = null;
    try {
      await this.port.close();
    } catch {
      /* already closed, or the device is gone */
    }
  }
}
