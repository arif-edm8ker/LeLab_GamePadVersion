// Joint-space gamepad teleoperation for the browser: port of
// lelab/gamepad_teleop.py on top of the Gamepad API's "standard" layout
// (https://w3c.github.io/gamepad/#remapping). Same speeds, deadzones,
// limits and buttons as the backend version; only the input source differs.

export const GAMEPAD_FPS = 50;
const DEADZONE = 0.08;

// Standard layout. Sticks: up/left negative. Triggers are analog buttons
// (0 released .. 1 pressed) rather than the -1..1 axes pygame reports.
const AXIS_LEFT_X = 0;
const AXIS_LEFT_Y = 1;
const AXIS_RIGHT_X = 2;
const AXIS_RIGHT_Y = 3;
const BUTTON_START_PAUSE = 0; // Cross / A
const BUTTON_QUIT = 1; // Circle / B
const BUTTON_HOME = 3; // Triangle / Y
const BUTTON_L2 = 6;
const BUTTON_R2 = 7;
const BUTTON_DPAD_UP = 12;
const BUTTON_DPAD_DOWN = 13;

const HOME_MOVE_DURATION_S = 1.5;

interface JointAxisConfig {
  axis: number;
  sign: number;
  maxDegPerS: number;
  deadzone?: number;
}

// Insertion order matters: it is the order the Python applies updates in.
const JOINT_CONFIG: Record<string, JointAxisConfig> = {
  shoulder_pan: { axis: AXIS_LEFT_X, sign: 1, maxDegPerS: 40.0 },
  shoulder_lift: { axis: AXIS_LEFT_Y, sign: -1, maxDegPerS: 40.0 },
  elbow_flex: { axis: AXIS_RIGHT_Y, sign: -1, maxDegPerS: 40.0 },
  // Wider deadzone: this axis shows small phantom values at rest.
  wrist_roll: { axis: AXIS_RIGHT_X, sign: -1, maxDegPerS: 60.0, deadzone: 0.2 },
};
const WRIST_FLEX_SIGN = -1;
const WRIST_FLEX_MAX_DEG_PER_S = 40.0;
const GRIPPER_SIGN = -1; // R2 closes, L2 opens
const GRIPPER_MAX_PER_S = 60.0;
const JOINT_MIN_DEG = -100.0;
const JOINT_MAX_DEG = 100.0;

/** The parts of a Gamepad this module reads; lets tests pass plain objects. */
export interface PadSnapshot {
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
}

const axis = (pad: PadSnapshot, i: number) => pad.axes[i] ?? 0;
const pressed = (pad: PadSnapshot, i: number) => pad.buttons[i]?.pressed ?? false;
const buttonValue = (pad: PadSnapshot, i: number) => pad.buttons[i]?.value ?? 0;

export function applyDeadzone(value: number, deadzone = DEADZONE): number {
  return Math.abs(value) < deadzone ? 0.0 : value;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Advance `targets` by one control tick from live stick/trigger state. Mutates and returns it. */
export function stepTargets(pad: PadSnapshot, targets: Record<string, number>, dt: number) {
  for (const [joint, cfg] of Object.entries(JOINT_CONFIG)) {
    const raw = applyDeadzone(axis(pad, cfg.axis), cfg.deadzone ?? DEADZONE);
    const vel = cfg.sign * raw * cfg.maxDegPerS;
    targets[joint] = clamp(targets[joint] + vel * dt, JOINT_MIN_DEG, JOINT_MAX_DEG);
  }

  const dpad = (pressed(pad, BUTTON_DPAD_UP) ? 1.0 : 0.0) - (pressed(pad, BUTTON_DPAD_DOWN) ? 1.0 : 0.0);
  if (dpad !== 0.0) {
    const vel = WRIST_FLEX_SIGN * dpad * WRIST_FLEX_MAX_DEG_PER_S;
    targets.wrist_flex = clamp(targets.wrist_flex + vel * dt, JOINT_MIN_DEG, JOINT_MAX_DEG);
  }

  const l2 = buttonValue(pad, BUTTON_L2);
  const r2 = buttonValue(pad, BUTTON_R2);
  const gripperVel = GRIPPER_SIGN * (r2 - l2) * GRIPPER_MAX_PER_S;
  targets.gripper = clamp(targets.gripper + gripperVel * dt, 0.0, 100.0);

  return targets;
}

interface HomeMove {
  from: Record<string, number>;
  to: Record<string, number>;
  startedAt: number;
}

/**
 * Velocity-controlled teleoperator state (GamepadSO101Teleop). The gamepad
 * has no position of its own: targets start from the follower's position
 * (`seed`) and accumulate stick input while motion is on.
 *
 * Differences from the backend, both because the browser loop must not block:
 * Triangle's return-to-home is interpolated across ticks instead of a
 * blocking 1.5 s move, and a missing controller simply holds position until
 * the Gamepad API reports it again.
 */
export class GamepadTeleop {
  running = false;
  quitRequested = false;
  connected = false;
  private targets: Record<string, number> | null = null;
  private home: Record<string, number> = {};
  private startPauseHeld = false;
  private homeHeld = false;
  private lastTick: number | null = null;
  private homeMove: HomeMove | null = null;

  /** Start from the follower's current position, which is also where Triangle returns to. */
  seed(present: Record<string, number>): void {
    this.targets = { ...present };
    this.home = { ...present };
    this.running = false;
    this.homeMove = null;
  }

  /** Stop accumulating input (e.g. the tab was hidden); the arm holds where it is. */
  pause(): void {
    this.running = false;
    this.homeMove = null;
  }

  /**
   * One control tick. `now` is in milliseconds. `readPresent` is called when
   * Cross turns motion on, so targets restart from where the arm really is.
   * Returns the goal positions to send.
   */
  async tick(
    pad: PadSnapshot | null,
    now: number,
    readPresent: () => Promise<Record<string, number>>
  ): Promise<Record<string, number>> {
    if (!this.targets) throw new Error("GamepadTeleop.seed() must be called before tick().");

    if (!pad) {
      // Controller gone: freeze, and require Cross again once it is back.
      this.connected = false;
      this.running = false;
      this.startPauseHeld = false;
      this.homeHeld = false;
      this.homeMove = null;
      this.lastTick = null;
      return { ...this.targets };
    }
    this.connected = true;

    if (pressed(pad, BUTTON_QUIT)) this.quitRequested = true;

    if (pressed(pad, BUTTON_START_PAUSE)) {
      if (!this.startPauseHeld) {
        this.startPauseHeld = true;
        this.running = !this.running;
        this.homeMove = null;
        if (this.running) this.targets = await readPresent();
      }
    } else {
      this.startPauseHeld = false;
    }

    if (pressed(pad, BUTTON_HOME)) {
      if (!this.homeHeld) {
        this.homeHeld = true;
        if (this.running) this.homeMove = { from: { ...this.targets }, to: { ...this.home }, startedAt: now };
      }
    } else {
      this.homeHeld = false;
    }

    const dt = this.lastTick !== null ? (now - this.lastTick) / 1000 : 1.0 / GAMEPAD_FPS;
    this.lastTick = now;

    if (this.homeMove) {
      const alpha = Math.min(1, (now - this.homeMove.startedAt) / (HOME_MOVE_DURATION_S * 1000));
      const { from, to } = this.homeMove;
      for (const joint of Object.keys(from)) this.targets[joint] = from[joint] + (to[joint] - from[joint]) * alpha;
      if (alpha >= 1) this.homeMove = null;
    } else if (this.running) {
      stepTargets(pad, this.targets, dt);
    }

    return { ...this.targets };
  }
}

/** First connected controller, preferring ones the browser maps to the standard layout. */
export function pickGamepad(pads: readonly (Gamepad | null)[]): Gamepad | null {
  const connected = pads.filter((p): p is Gamepad => !!p && p.connected);
  return connected.find((p) => p.mapping === "standard") ?? connected[0] ?? null;
}
