import { describe, expect, it } from "vitest";
import {
  BrowserCalibration,
  CalibrationDiscontinuityError,
  CalibrationState,
  DISCONTINUITY_ERROR_PREFIX,
  MotorRange,
  buildCalibration,
  insufficientRanges,
  updateRanges,
} from "./calibrationSession";
import { STS_REGISTERS, decodeSignMagnitude } from "./feetechProtocol";
import { SO101_MOTORS } from "./so101";
import { FakeSerialPort, ServoBusSim, waitFor } from "./testing/fakeServos";

describe("updateRanges", () => {
  it("widens min/max and ignores bad frames", () => {
    const ranges: Record<string, MotorRange> = { gripper: { min: 2000, max: 2000, current: 2000 } };
    updateRanges(ranges, { gripper: 2300 });
    updateRanges(ranges, { gripper: 0 });
    updateRanges(ranges, { gripper: 1900 });
    expect(ranges.gripper).toEqual({ min: 1900, max: 2300, current: 1900 });
  });

  it("aborts on an encoder wrap-around jump", () => {
    const ranges: Record<string, MotorRange> = { wrist_roll: { min: 100, max: 100, current: 100 } };
    expect(() => updateRanges(ranges, { wrist_roll: 4050 })).toThrow(CalibrationDiscontinuityError);
  });
});

describe("buildCalibration", () => {
  const motors = { motors: { a: { id: 1, mode: "degrees" as const } } };

  it("produces lerobot's calibration entries", () => {
    expect(buildCalibration(motors, { a: -5 }, { a: { min: 10, max: 20, current: 15 } })).toEqual({
      a: { id: 1, drive_mode: 0, homing_offset: -5, range_min: 10, range_max: 20 },
    });
  });

  it("refuses a joint that never moved", () => {
    expect(() => buildCalibration(motors, { a: 0 }, { a: { min: 10, max: 10, current: 10 } })).toThrow(
      /same min and max/
    );
  });

  it("warns about small ranges", () => {
    expect(insufficientRanges({ a: { min: 10, max: 60, current: 10 } })).toEqual(["a: 50"]);
  });
});

function track(session: (onChange: (s: CalibrationState) => void) => BrowserCalibration) {
  const states: CalibrationState[] = [];
  const cal = session((s) => states.push(s));
  return { cal, states, latest: () => states[states.length - 1] };
}

describe("BrowserCalibration end to end", () => {
  it("homes, records ranges, writes and returns the calibration", async () => {
    const sim = new ServoBusSim();
    const start = [2300, 1800, 2100, 1950, 2047, 2600];
    start.forEach((p, i) => (sim.servo(i + 1).actual = p));
    const { cal, latest } = track((onChange) => new BrowserCalibration("robot", onChange));

    cal.start(new FakeSerialPort(sim));
    await waitFor(() => latest()?.phase === "recording");
    // After homing every joint reads mid-range.
    expect(Object.values(latest().ranges!).map((r) => r.current)).toEqual([2047, 2047, 2047, 2047, 2047, 2047]);

    // "Move" each joint 500 steps down, then 700 up, from its start.
    start.forEach((p, i) => (sim.servo(i + 1).actual = p - 500));
    await waitFor(() => Object.values(latest().ranges!).every((r) => r.min === 1547));
    start.forEach((p, i) => (sim.servo(i + 1).actual = p + 700));
    await waitFor(() => Object.values(latest().ranges!).every((r) => r.max === 2747));

    cal.complete();
    await waitFor(() => latest().phase === "completed");

    const result = latest().result!;
    for (const [motor, { id }] of Object.entries(SO101_MOTORS)) {
      expect(result[motor]).toEqual({
        id,
        drive_mode: 0,
        homing_offset: start[id - 1] - 2047,
        range_min: 1547,
        range_max: 2747,
      });
      const servo = sim.servo(id);
      expect(decodeSignMagnitude(servo.word(STS_REGISTERS.Homing_Offset[0]), 11)).toBe(start[id - 1] - 2047);
      expect(servo.word(STS_REGISTERS.Min_Position_Limit[0])).toBe(1547);
      expect(servo.word(STS_REGISTERS.Max_Position_Limit[0])).toBe(2747);
      // Torque released when the session ends, as the backend does.
      expect(servo.memory[STS_REGISTERS.Torque_Enable[0]]).toBe(0);
    }
  });

  it("reports a discontinuity with the backend's message", async () => {
    const sim = new ServoBusSim();
    const { cal, latest } = track((onChange) => new BrowserCalibration("teleop", onChange));
    cal.start(new FakeSerialPort(sim));
    await waitFor(() => latest()?.phase === "recording");
    sim.servo(5).actual += 2500;
    await waitFor(() => latest().phase === "error");
    expect(latest().error?.startsWith(DISCONTINUITY_ERROR_PREFIX)).toBe(true);
  });

  it("stops cleanly and closes the port", async () => {
    const sim = new ServoBusSim();
    const port = new FakeSerialPort(sim);
    const { cal, latest } = track((onChange) => new BrowserCalibration("robot", onChange));
    cal.start(port);
    await waitFor(() => latest()?.phase === "recording");
    await cal.stop();
    expect(latest()).toMatchObject({ phase: "idle", message: "Calibration stopped" });
    expect(port.closed).toBe(true);
  });

  it("fails with a readable error when the arm doesn't answer", async () => {
    const { cal, latest } = track((onChange) => new BrowserCalibration("robot", onChange));
    cal.start(new FakeSerialPort(new ServoBusSim([])));
    await waitFor(() => latest()?.phase === "error");
    expect(latest().error).toMatch(/Motor check failed/);
  });
});
