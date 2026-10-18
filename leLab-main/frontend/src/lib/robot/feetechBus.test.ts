import { describe, expect, it } from "vitest";
import reference from "./__fixtures__/lerobot_reference.json";
import { FeetechBus } from "./feetechBus";
import { STS_REGISTERS, decodeSignMagnitude } from "./feetechProtocol";
import { CalibrationFile, normalize, unnormalize } from "./normalization";
import { FeetechTimeoutError, WebSerialTransport } from "./serialTransport";
import { SO101_MOTORS } from "./so101";
import { FakeSerialPort, ServoBusSim } from "./testing/fakeServos";

const calibration = reference.normalization.calibration as CalibrationFile;

async function openBus(sim = new ServoBusSim(), cal: CalibrationFile | null = calibration) {
  const port = new FakeSerialPort(sim);
  const transport = new WebSerialTransport(port);
  await transport.open();
  return { bus: new FeetechBus(transport, SO101_MOTORS, cal), sim, port };
}

describe("FeetechBus over a simulated SO-101", () => {
  it("opens the port at 1 Mbaud", async () => {
    const { port, bus } = await openBus();
    expect(port.openedWith?.baudRate).toBe(1_000_000);
    await bus.disconnect(false);
    expect(port.closed).toBe(true);
  });

  it("passes the handshake when all six STS3215s answer", async () => {
    const { bus } = await openBus();
    await expect(bus.connect()).resolves.toBeUndefined();
    await bus.disconnect(false);
  });

  it("names missing motors in the handshake error", async () => {
    const { bus } = await openBus(new ServoBusSim([1, 2, 3, 4, 6]));
    await expect(bus.connect()).rejects.toThrow(/wrist_roll \(id 5\)/);
    await bus.disconnect(false);
  });

  it("sync-reads positions and normalizes them with the calibration", async () => {
    const sim = new ServoBusSim();
    const raw = [758, 2047, 3080, 1000, 4000, 2600];
    raw.forEach((r, i) => (sim.servo(i + 1).actual = r));
    const { bus } = await openBus(sim);

    const positions = await bus.syncRead("Present_Position");
    Object.entries(SO101_MOTORS).forEach(([motor, { id, mode }]) => {
      expect(positions[motor]).toBe(normalize(motor, raw[id - 1], calibration[motor], mode));
    });

    const rawRead = await bus.syncRead("Present_Position", ["elbow_flex"], { normalize: false });
    expect(rawRead).toEqual({ elbow_flex: 3080 });
    await bus.disconnect(false);
  });

  it("sync-writes goals as unnormalized steps, in one broadcast packet", async () => {
    const { bus, sim } = await openBus();
    const goals = { shoulder_pan: 10, shoulder_lift: -20, elbow_flex: 30, wrist_flex: 0, wrist_roll: 45, gripper: 25 };
    await bus.syncWrite("Goal_Position", goals);

    const [address] = STS_REGISTERS.Goal_Position;
    for (const [motor, { id, mode }] of Object.entries(SO101_MOTORS)) {
      const written = decodeSignMagnitude(sim.servo(id).word(address), 15);
      expect(written).toBe(unnormalize(motor, goals[motor as keyof typeof goals], calibration[motor], mode));
    }
    expect(sim.received.at(-1)?.[2]).toBe(0xfe);
    await bus.disconnect(false);
  });

  it("writes negative homing offsets in sign-magnitude form", async () => {
    const { bus, sim } = await openBus();
    await bus.write("elbow_flex", "Homing_Offset", -100);
    expect(sim.servo(3).word(STS_REGISTERS.Homing_Offset[0])).toBe(2148);
    await bus.disconnect(false);
  });

  it("times out when a motor never answers", async () => {
    const { bus } = await openBus(new ServoBusSim([1, 2, 3]));
    await expect(bus.read("gripper", "Torque_Enable", { retries: 1 })).rejects.toBeInstanceOf(FeetechTimeoutError);
    await bus.disconnect(false);
  });

  it("releases torque on every motor when disconnecting", async () => {
    const { bus, sim } = await openBus();
    await bus.enableTorque();
    await bus.disconnect(true);
    for (const servo of sim.servos.values()) {
      expect(servo.memory[STS_REGISTERS.Torque_Enable[0]]).toBe(0);
      expect(servo.memory[STS_REGISTERS.Lock[0]]).toBe(0);
    }
  });

  it("serializes concurrent requests instead of interleaving them", async () => {
    const { bus } = await openBus();
    const [a, b] = await Promise.all([
      bus.read("shoulder_pan", "Model_Number", { normalize: false }),
      bus.syncRead("Present_Position", ["gripper"], { normalize: false }),
    ]);
    expect(a).toBe(777);
    expect(b).toEqual({ gripper: 2048 });
    await bus.disconnect(false);
  });
});
