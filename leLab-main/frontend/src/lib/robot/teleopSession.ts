// In-browser teleoperation of the SO-101 follower, from a gamepad or a leader
// arm: port of handle_start_teleoperation in lelab/teleoperate.py. The whole
// control loop runs in the page, so no network sits between input and arm.

import { FeetechBus } from "./feetechBus";
import { GAMEPAD_FPS, GamepadTeleop, pickGamepad } from "./gamepadTeleop";
import { CalibrationFile } from "./normalization";
import { configureFollower, configureLeader, openSo101Bus, toUrdfJoints } from "./so101";

export type TeleopInput = "gamepad" | "leader";
export type TeleopPhase = "idle" | "connecting" | "running" | "stopping" | "stopped" | "error";

export interface GamepadInfo {
  connected: boolean;
  name: string | null;
  /** Arm motion on (toggled with Cross). */
  running: boolean;
  /** The browser maps this controller to the standard layout the mapping assumes. */
  standardMapping: boolean;
}

export interface TeleopState {
  phase: TeleopPhase;
  message: string;
  error: string | null;
  gamepad: GamepadInfo | null;
  /** Measured control-loop rate over the last second. */
  loopHz: number | null;
}

export const INITIAL_TELEOP_STATE: TeleopState = {
  phase: "idle",
  message: "",
  error: null,
  gamepad: null,
  loopHz: null,
};

export interface TeleopOptions {
  input: TeleopInput;
  followerPort: SerialPort;
  followerCalibration: CalibrationFile;
  leaderPort?: SerialPort;
  leaderCalibration?: CalibrationFile;
  onState: (state: TeleopState) => void;
  /** URDF joint values (radians) for the 3D viewer, about 20 times a second. */
  onJoints: (joints: Record<string, number>) => void;
}

const LEADER_LOOP_HZ = 60;
const VIEWER_INTERVAL_MS = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function connectArm(port: SerialPort, calibration: CalibrationFile, label: string): Promise<FeetechBus> {
  const bus = await openSo101Bus(port, calibration);
  try {
    await bus.connect();
  } catch (e) {
    await bus.disconnect(false).catch(() => undefined);
    throw new Error(`Could not connect to the ${label}: ${errorMessage(e)}`);
  }
  return bus;
}

export class BrowserTeleop {
  private follower: FeetechBus | null = null;
  private leader: FeetechBus | null = null;
  private readonly gamepad = new GamepadTeleop();
  private state: TeleopState = INITIAL_TELEOP_STATE;
  private stopRequested = false;
  private run: Promise<void> | null = null;

  constructor(private readonly opts: TeleopOptions) {}

  private set(patch: Partial<TeleopState>): void {
    this.state = { ...this.state, ...patch };
    this.opts.onState(this.state);
  }

  start(): void {
    this.stopRequested = false;
    this.run = this.execute();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    await this.run;
  }

  private async execute(): Promise<void> {
    const { input } = this.opts;
    let endPhase: TeleopPhase = "stopped";
    let endMessage = "Teleoperation stopped. Torque released.";
    let error: string | null = null;

    try {
      this.set({ ...INITIAL_TELEOP_STATE, phase: "connecting", message: "Connecting to the arm..." });
      // Same order as the backend: buses, then calibration, then motor configuration.
      this.follower = await connectArm(this.opts.followerPort, this.opts.followerCalibration, "follower arm");
      if (input === "leader") {
        if (!this.opts.leaderPort || !this.opts.leaderCalibration) {
          throw new Error("Leader mode needs a leader port and calibration.");
        }
        this.leader = await connectArm(this.opts.leaderPort, this.opts.leaderCalibration, "leader arm");
      }
      await this.follower.writeCalibration(this.opts.followerCalibration);
      if (this.leader && this.opts.leaderCalibration) await this.leader.writeCalibration(this.opts.leaderCalibration);
      await configureFollower(this.follower);
      if (this.leader) await configureLeader(this.leader);
      if (input === "gamepad") this.gamepad.seed(await this.follower.syncRead("Present_Position"));
      if (this.stopRequested) return;

      this.set({
        phase: "running",
        message:
          input === "gamepad"
            ? "Press Cross (A) to start moving the arm, Triangle (Y) to return home, Circle (B) to stop."
            : "Move the leader arm; the follower mirrors it.",
      });
      const quit = await this.loop(this.follower);
      if (quit) endMessage = "Stopped from the gamepad (Circle). Torque released.";
    } catch (e) {
      endPhase = "error";
      error = errorMessage(e);
      endMessage = "Teleoperation stopped because of an error.";
    } finally {
      this.set({ phase: "stopping", message: "Releasing the arm..." });
      await this.release();
      this.set({ phase: endPhase, message: endMessage, error, loopHz: null });
    }
  }

  /** Returns true when the session ended from the gamepad's quit button. */
  private async loop(follower: FeetechBus): Promise<boolean> {
    const gamepadMode = this.opts.input === "gamepad";
    const period = 1000 / (gamepadMode ? GAMEPAD_FPS : LEADER_LOOP_HZ);
    let next = performance.now();
    let lastViewer = -Infinity;
    let ticks = 0;
    let windowStart = performance.now();

    while (!this.stopRequested) {
      const now = performance.now();

      // A hidden tab gets its timers throttled, so stop driving the arm and
      // let it hold its last goal until the tab is visible again.
      if (document.hidden) {
        if (gamepadMode) this.gamepad.pause();
      } else if (gamepadMode) {
        const pad = pickGamepad(navigator.getGamepads());
        const goals = await this.gamepad.tick(pad, now, () => follower.syncRead("Present_Position"));
        await follower.syncWrite("Goal_Position", goals);
        this.reportGamepad(pad);
        if (this.gamepad.quitRequested) return true;
      } else if (this.leader) {
        const goals = await this.leader.syncRead("Present_Position");
        await follower.syncWrite("Goal_Position", goals);
      }

      if (now - lastViewer >= VIEWER_INTERVAL_MS) {
        lastViewer = now;
        try {
          this.opts.onJoints(toUrdfJoints(await follower.syncRead("Present_Position")));
        } catch {
          /* visualization is best-effort, as in the backend */
        }
      }

      ticks++;
      if (now - windowStart >= 1000) {
        this.set({ loopHz: (ticks * 1000) / (now - windowStart) });
        ticks = 0;
        windowStart = now;
      }

      next += period;
      const wait = next - performance.now();
      // Fell far behind (slow bus, throttled tab): resync instead of bursting.
      if (wait < -period) next = performance.now();
      await sleep(Math.max(0, wait));
    }
    return false;
  }

  private reportGamepad(pad: Gamepad | null): void {
    const info: GamepadInfo = {
      connected: this.gamepad.connected,
      name: pad?.id ?? null,
      running: this.gamepad.running,
      standardMapping: pad?.mapping === "standard",
    };
    const prev = this.state.gamepad;
    if (
      !prev ||
      prev.connected !== info.connected ||
      prev.name !== info.name ||
      prev.running !== info.running ||
      prev.standardMapping !== info.standardMapping
    ) {
      this.set({ gamepad: info });
    }
  }

  private async release(): Promise<void> {
    for (const bus of [this.follower, this.leader]) {
      if (!bus) continue;
      try {
        // lerobot disables torque on disconnect for both arms.
        await bus.disconnect(true);
      } catch {
        /* port already gone */
      }
    }
    this.follower = null;
    this.leader = null;
  }
}
