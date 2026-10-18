import { describe, expect, it } from "vitest";
import reference from "./__fixtures__/lerobot_reference.json";
import {
  decodeSignMagnitude,
  encodeSignMagnitude,
  parseStatusPacket,
  pingPacket,
  readPacket,
  syncReadPacket,
  syncWritePacket,
  toBytes,
  writePacket,
} from "./feetechProtocol";
import { statusPacket } from "./testing/fakeServos";

const bytes = (p: Uint8Array) => Array.from(p);

describe("instruction packets match scservo_sdk", () => {
  const ref = reference.packets;

  it("ping", () => expect(bytes(pingPacket(1))).toEqual(ref.ping_id1));

  it("read", () => expect(bytes(readPacket(1, 56, 2))).toEqual(ref.read_id1_present_position));

  it("write", () => {
    expect(bytes(writePacket(3, 31, toBytes(2148, 2)))).toEqual(ref.write_id3_homing_offset_neg100);
    expect(bytes(writePacket(6, 40, [1]))).toEqual(ref.write_id6_torque_enable_1);
  });

  it("sync read", () => {
    expect(bytes(syncReadPacket(56, 2, [1, 2, 3, 4, 5, 6]))).toEqual(ref.sync_read_present_position_ids1to6);
  });

  it("sync write", () => {
    const entries = Object.entries(ref.sync_write_goal_position_values).map(
      ([id, v]) => [Number(id), toBytes(v, 2)] as const
    );
    expect(bytes(syncWritePacket(42, 2, entries))).toEqual(ref.sync_write_goal_position_ids1to6);
  });
});

describe("sign-magnitude matches lerobot encoding_utils", () => {
  it.each(reference.sign_magnitude.cases)("bit $bit, value $value", ({ bit, value, encoded, decoded }) => {
    expect(encodeSignMagnitude(value, bit)).toBe(encoded);
    expect(decodeSignMagnitude(encoded, bit)).toBe(decoded);
  });

  it("rejects magnitudes that don't fit", () => {
    expect(() => encodeSignMagnitude(2048, 11)).toThrow(RangeError);
  });
});

describe("parseStatusPacket", () => {
  const reply = statusPacket(3, 0, [0x34, 0x12]);

  it("parses a complete packet", () => {
    expect(parseStatusPacket(reply)).toEqual({
      packet: { id: 3, error: 0, params: [0x34, 0x12] },
      consumed: reply.length,
    });
  });

  it("waits for the rest of a partial packet without dropping it", () => {
    expect(parseStatusPacket(reply.slice(0, 5))).toEqual({ packet: null, consumed: 0 });
  });

  it("skips leading garbage and impossible headers", () => {
    // 0xFF 0xFF 0xFE ... looks like a header but 0xFE is not a valid reply ID.
    const buf = [0x00, 0x12, 0xff, 0xff, 0xfe, 0x02, 0x00, ...reply];
    const result = parseStatusPacket(buf);
    expect(result.packet).toEqual({ id: 3, error: 0, params: [0x34, 0x12] });
    expect(result.consumed).toBe(buf.length);
  });

  it("flags a bad checksum", () => {
    const bad = [...reply];
    bad[bad.length - 1] ^= 0xff;
    expect(parseStatusPacket(bad)).toEqual({ packet: null, consumed: bad.length, corrupt: true });
  });

  it("drops garbage but keeps a trailing 0xFF", () => {
    expect(parseStatusPacket([0x01, 0x02, 0xff])).toEqual({ packet: null, consumed: 2 });
  });
});
