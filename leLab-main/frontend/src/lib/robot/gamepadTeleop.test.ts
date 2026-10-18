import { describe, expect, it, vi } from "vitest";
import reference from "./__fixtures__/lerobot_reference.json";
import { GamepadTeleop, PadSnapshot, pickGamepad, stepTargets } from "./gamepadTeleop";

const BUTTONS = 17;

/** Build a standard-layout snapshot. Triggers given in pygame's -1..1 convention. */
function pad({
  axes = [0, 0, 0, 0],
  l2 = -1,
  r2 = -1,
  pressed = [] as number[],
}: { axes?: number[]; l2?: number; r2?: number; pressed?: number[] } = {}): PadSnapshot {
  const buttons = Array.from({ length: BUTTONS }, (_, i) => ({ pressed: pressed.includes(i), value: 0 }));
  buttons[6] = { pressed: l2 > -1, value: (l2 + 1) / 2 };
  buttons[7] = { pressed: r2 > -1, value: (r2 + 1) / 2 };
  return { axes, buttons };
}

describe("stepTargets matches lelab.gamepad_teleop.step_targets", () => {
  it.each(reference.gamepad.scenarios.map((s, i) => ({ ...s, i })))("scenario $i", (s) => {
    const [lx, ly, rx, ry, l2, r2] = s.axes;
    const dpad = s.dpad === 1 ? [12] : s.dpad === -1 ? [13] : [];
    const out = stepTargets(pad({ axes: [lx, ly, rx, ry], l2, r2, pressed: dpad }), { ...s.start }, s.dt);
    expect(out).toEqual(s.out);
  });
});

const START = { shoulder_pan: 0, shoulder_lift: 0, elbow_flex: 0, wrist_flex: 0, wrist_roll: 0, gripper: 50 };

describe("GamepadTeleop", () => {
  it("holds position until Cross turns motion on, re-reading the arm then", async () => {
    const t = new GamepadTeleop();
    t.seed(START);
    const readPresent = vi.fn(async () => ({ ...START, shoulder_pan: 5 }));

    const held = await t.tick(pad({ axes: [1, 0, 0, 0] }), 0, readPresent);
    expect(held).toEqual(START);
    expect(t.running).toBe(false);

    await t.tick(pad({ pressed: [0] }), 20, readPresent);
    expect(t.running).toBe(true);
    expect(readPresent).toHaveBeenCalledOnce();

    // Holding Cross doesn't toggle again; release, then push the stick.
    await t.tick(pad({ pressed: [0] }), 40, readPresent);
    expect(t.running).toBe(true);
    const moved = await t.tick(pad({ axes: [1, 0, 0, 0] }), 60, readPresent);
    expect(moved.shoulder_pan).toBeCloseTo(5 + 40 * 0.02);
  });

  it("latches Circle as a quit request", async () => {
    const t = new GamepadTeleop();
    t.seed(START);
    await t.tick(pad({ pressed: [1] }), 0, async () => START);
    expect(t.quitRequested).toBe(true);
  });

  it("freezes and drops out of motion when the controller disappears", async () => {
    const t = new GamepadTeleop();
    t.seed(START);
    await t.tick(pad({ pressed: [0] }), 0, async () => START);
    const held = await t.tick(null, 20, async () => START);
    expect(held).toEqual(START);
    expect(t.connected).toBe(false);
    expect(t.running).toBe(false);
  });

  it("returns to the seeded home position smoothly over 1.5 s on Triangle", async () => {
    const t = new GamepadTeleop();
    t.seed(START);
    const away = { ...START, elbow_flex: 60 };
    await t.tick(pad({ pressed: [0] }), 0, async () => away);
    await t.tick(pad({ pressed: [3] }), 100, async () => away);
    const halfway = await t.tick(pad(), 850, async () => away);
    expect(halfway.elbow_flex).toBeCloseTo(30);
    const done = await t.tick(pad(), 1700, async () => away);
    expect(done).toEqual(START);
  });
});

describe("pickGamepad", () => {
  const gp = (id: string, mapping: string, connected = true) => ({ id, mapping, connected }) as unknown as Gamepad;

  it("prefers a standard-mapped controller", () => {
    expect(pickGamepad([gp("raw", ""), null, gp("std", "standard")])?.id).toBe("std");
  });

  it("falls back to any connected controller", () => {
    expect(pickGamepad([null, gp("raw", ""), gp("gone", "standard", false)])?.id).toBe("raw");
  });

  it("returns null when nothing is connected", () => {
    expect(pickGamepad([null, null])).toBeNull();
  });
});
