import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import reference from "./__fixtures__/lerobot_reference.json";
import { STS_REGISTERS, decodeSignMagnitude } from "./feetechProtocol";
import { CalibrationFile, normalize, unnormalize } from "./normalization";
import { SO101_MOTORS } from "./so101";
import { BrowserTeleop, TeleopState } from "./teleopSession";
import { FakeSerialPort, ServoBusSim, waitFor } from "./testing/fakeServos";

const calibration = reference.normalization.calibration as CalibrationFile;
const goalOf = (sim: ServoBusSim, id: number) => decodeSignMagnitude(sim.servo(id).word(STS_REGISTERS.Goal_Position[0]), 15);

let gamepads: (Gamepad | null)[] = [];

beforeEach(() => {
  gamepads = [];
  vi.stubGlobal("document", { hidden: false });
  vi.stubGlobal("navigator", { getGamepads: () => gamepads });
});

afterEach(() => vi.unstubAllGlobals());

function fakePad(pressed: number[] = [], axes = [0, 0, 0, 0]): Gamepad {
  const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), touched: false, value: 0 }));
  return { id: "Test Pad", mapping: "standard", connected: true, axes, buttons } as unknown as Gamepad;
}

function session(opts: Partial<ConstructorParameters<typeof BrowserTeleop>[0]> & { followerSim: ServoBusSim }) {
  const states: TeleopState[] = [];
  const joints: Record<string, number>[] = [];
  const followerPort = new FakeSerialPort(opts.followerSim);
  const teleop = new BrowserTeleop({
    input: "gamepad",
    followerPort,
    followerCalibration: calibration,
    onState: (s) => states.push(s),
    onJoints: (j) => joints.push(j),
    ...opts,
  });
  return { teleop, states, joints, followerPort, latest: () => states[states.length - 1] };
}

describe("BrowserTeleop", () => {
  it("mirrors a leader arm onto the follower", async () => {
    const followerSim = new ServoBusSim();
    const leaderSim = new ServoBusSim();
    // Present_Position the leader should report once its homing offsets are written.
    const leaderRaw = [1200, 2047, 2900, 1500, 3000, 2600];
    Object.values(calibration).forEach(({ id, homing_offset }) => {
      leaderSim.servo(id).actual = leaderRaw[id - 1] + homing_offset;
    });
    const { teleop, latest, joints } = session({
      input: "leader",
      followerSim,
      leaderPort: new FakeSerialPort(leaderSim),
      leaderCalibration: calibration,
    });

    teleop.start();
    await waitFor(() => latest()?.phase === "running");
    await waitFor(() => goalOf(followerSim, 1) !== 0);

    for (const [motor, { id, mode }] of Object.entries(SO101_MOTORS)) {
      const leaderValue = normalize(motor, leaderRaw[id - 1], calibration[motor], mode);
      expect(goalOf(followerSim, id)).toBe(unnormalize(motor, leaderValue, calibration[motor], mode));
    }
    await waitFor(() => joints.length > 0);
    expect(Object.keys(joints[0])).toContain("Rotation");

    await teleop.stop();
    expect(latest().phase).toBe("stopped");
    expect(followerSim.servo(1).memory[STS_REGISTERS.Torque_Enable[0]]).toBe(0);
  });

  it("drives the follower from the gamepad and stops on Circle", async () => {
    const followerSim = new ServoBusSim();
    const { teleop, latest } = session({ input: "gamepad", followerSim });
    teleop.start();
    await waitFor(() => latest()?.phase === "running");

    await waitFor(() => goalOf(followerSim, 1) !== 0);
    const before = goalOf(followerSim, 1);
    gamepads = [fakePad([0])]; // Cross: motion on
    await waitFor(() => latest().gamepad?.running === true);
    gamepads = [fakePad([], [1, 0, 0, 0])]; // left stick right: shoulder_pan
    await waitFor(() => goalOf(followerSim, 1) > before + 10);
    expect(latest().gamepad).toMatchObject({ connected: true, name: "Test Pad", standardMapping: true });

    gamepads = [fakePad([1])]; // Circle: quit
    await waitFor(() => latest().phase === "stopped");
    expect(latest().message).toMatch(/Circle/);
  });

  it("reports which arm failed to connect", async () => {
    const { teleop, latest } = session({ input: "gamepad", followerSim: new ServoBusSim([1, 2]) });
    teleop.start();
    await waitFor(() => latest()?.phase === "error");
    expect(latest().error).toMatch(/follower arm/);
  });
});
