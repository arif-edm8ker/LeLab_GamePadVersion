// Run a trained policy on an arm plugged into this computer while the policy
// itself runs on the LeLab server (lelab/browser_inference.py), which may be
// remote. The page reads the arm and cameras, sends an observation, and plays
// the returned chunk of actions at the policy's control rate, asking for the
// next chunk early enough to hide the round trip.

import { CameraCapture, openBrowserCamera } from "./cameraCapture";
import { FeetechBus } from "./feetechBus";
import { CameraFrame, InferenceSpec, ServerMessage, StartMessage, encodeObservation } from "./inferenceProtocol";
import { CalibrationFile } from "./normalization";
import { configureFollower, connectSo101, toUrdfJoints } from "./so101";

export type InferencePhase = "idle" | "connecting" | "loading" | "running" | "returning" | "stopped" | "error";

export interface InferenceStats {
  /** Server time to produce the last chunk. */
  inferenceMs: number | null;
  /** Observation sent -> actions received, for the last chunk. */
  roundTripMs: number | null;
  /** Actions left to play from the current chunk. */
  queued: number;
  loopHz: number | null;
}

export interface InferenceState {
  phase: InferencePhase;
  message: string;
  error: string | null;
  spec: InferenceSpec | null;
  stats: InferenceStats;
  elapsedS: number;
}

export const INITIAL_INFERENCE_STATE: InferenceState = {
  phase: "idle",
  message: "",
  error: null,
  spec: null,
  stats: { inferenceMs: null, roundTripMs: null, queued: 0, loopHz: null },
  elapsedS: 0,
};

export interface InferenceOptions {
  followerPort: SerialPort;
  followerCalibration: CalibrationFile;
  /** ws(s)://<server>/ws/browser-inference */
  socketUrl: string;
  jobId: string;
  step: number;
  task: string;
  /** Stop after this many seconds; 0 runs until stopped. */
  durationS: number;
  /** Policy camera name -> browser camera deviceId. */
  cameraDevices: Record<string, string>;
  onState: (state: InferenceState) => void;
  /** URDF joint values (radians) for the 3D viewer, about 20 times a second. */
  onJoints: (joints: Record<string, number>) => void;
  /** Injection points for tests. */
  openCamera?: (deviceId: string, width: number, height: number) => Promise<CameraCapture>;
  openSocket?: (url: string) => WebSocket;
}

// lerobot-rollout returns the arm to where it started over 3 s at 50 Hz
// before releasing it (return_to_initial_position).
const RETURN_DURATION_S = 3;
const RETURN_FPS = 50;
const VIEWER_INTERVAL_MS = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Drop the actions meant for ticks that already passed while the chunk was
 * computed (the first action belongs to the tick the observation was taken).
 * The last action is always kept, so even one-action chunks get played.
 */
export function alignChunk(actions: number[][], elapsedTicks: number): number[][] {
  return actions.slice(Math.min(Math.max(0, elapsedTicks), actions.length - 1));
}

/** Server messages as a queue the control loop can drain, plus awaitable for setup. */
class ServerChannel {
  private queue: ServerMessage[] = [];
  private waiters: (() => void)[] = [];
  closed = false;
  private readonly opened: Promise<void>;

  constructor(private readonly socket: WebSocket) {
    socket.binaryType = "arraybuffer";
    this.opened = new Promise((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("Couldn't reach the LeLab server's inference endpoint."));
    });
    socket.onmessage = (event) => {
      this.queue.push(JSON.parse(String(event.data)) as ServerMessage);
      this.wake();
    };
    socket.onclose = () => {
      this.closed = true;
      this.wake();
    };
  }

  private wake(): void {
    for (const wake of this.waiters.splice(0)) wake();
  }

  async open(): Promise<void> {
    await this.opened;
  }

  /** The next message; rejects if the server closes the connection first. */
  async next(): Promise<ServerMessage> {
    while (this.queue.length === 0) {
      if (this.closed) throw new Error("The server closed the connection.");
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    return this.queue.shift() as ServerMessage;
  }

  drain(): ServerMessage[] {
    return this.queue.splice(0);
  }

  send(data: string | Uint8Array): void {
    this.socket.send(data);
  }

  close(): void {
    try {
      if (!this.closed) this.socket.send(JSON.stringify({ type: "stop" }));
    } catch {
      /* already closing */
    }
    this.socket.close();
  }
}

class StoppedError extends Error {}

export class BrowserInference {
  private state: InferenceState = INITIAL_INFERENCE_STATE;
  private stopRequested = false;
  private resolveStop: () => void = () => undefined;
  private readonly stopSignal = new Promise<void>((resolve) => (this.resolveStop = resolve));
  private run: Promise<void> | null = null;

  constructor(private readonly opts: InferenceOptions) {}

  private set(patch: Partial<InferenceState>): void {
    this.state = { ...this.state, ...patch };
    this.opts.onState(this.state);
  }

  start(): void {
    this.run = this.execute();
  }

  /** Stop the policy; the arm then returns to where it started and is released. */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.resolveStop();
    await this.run;
  }

  /** Wait for `promise` unless stop() is called first. */
  private async unlessStopped<T>(promise: Promise<T>): Promise<T> {
    const result = await Promise.race([promise, this.stopSignal.then(() => StoppedError)]);
    if (result === StoppedError) throw new StoppedError();
    return result as T;
  }

  private async execute(): Promise<void> {
    const opts = this.opts;
    let follower: FeetechBus | null = null;
    let initial: Record<string, number> | null = null;
    let channel: ServerChannel | null = null;
    const cameras: [string, CameraCapture][] = [];
    let endPhase: InferencePhase = "stopped";
    let endMessage = "Stopped. The arm returned to its starting pose and was released.";
    let error: string | null = null;

    try {
      this.set({ ...INITIAL_INFERENCE_STATE, phase: "connecting", message: "Connecting to the arm..." });
      follower = await connectSo101(opts.followerPort, opts.followerCalibration, "follower arm");
      await follower.writeCalibration(opts.followerCalibration);
      await configureFollower(follower);
      initial = await follower.syncRead("Present_Position");

      this.set({ phase: "loading", message: "Loading the policy on the server..." });
      channel = new ServerChannel((opts.openSocket ?? ((url) => new WebSocket(url)))(opts.socketUrl));
      await this.unlessStopped(channel.open());
      const start: StartMessage = { type: "start", job_id: opts.jobId, step: opts.step, task: opts.task };
      channel.send(JSON.stringify(start));
      let spec: InferenceSpec | null = null;
      while (!spec) {
        const message = await this.unlessStopped(channel.next());
        if (message.type === "error") throw new Error(message.message);
        if (message.type === "ready") spec = message;
      }

      const openCamera = opts.openCamera ?? openBrowserCamera;
      for (const [name, { width, height }] of Object.entries(spec.cameras)) {
        const deviceId = opts.cameraDevices[name];
        if (!deviceId) throw new Error(`Choose a camera for "${name}".`);
        cameras.push([name, await openCamera(deviceId, width, height)]);
      }

      this.set({ phase: "running", message: "The policy is driving the arm.", spec });
      const ended = await this.loop(follower, channel, spec, cameras);
      if (ended === "duration") endMessage = "Reached the time limit. The arm returned to its starting pose.";
    } catch (e) {
      if (!(e instanceof StoppedError)) {
        endPhase = "error";
        error = errorMessage(e);
        endMessage = "Inference stopped because of an error.";
      }
    } finally {
      channel?.close();
      for (const [, camera] of cameras) camera.close();
      if (follower) {
        if (initial) {
          this.set({ phase: "returning", message: "Returning the arm to its starting pose..." });
          await this.returnTo(follower, initial).catch(() => undefined);
        }
        await follower.disconnect(true).catch(() => undefined);
      }
      this.set({ phase: endPhase, message: endMessage, error });
    }
  }

  /** Returns why the loop ended. */
  private async loop(
    follower: FeetechBus,
    channel: ServerChannel,
    spec: InferenceSpec,
    cameras: [string, CameraCapture][]
  ): Promise<"stopped" | "duration"> {
    const period = 1000 / spec.fps;
    const motorOf = spec.action_names.map((name) => name.replace(/\.pos$/, ""));
    const startedAt = performance.now();
    let queue: number[][] = [];
    let pending: { seq: number; tick: number; sentAt: number } | null = null;
    let seq = 0;
    let tick = 0;
    let roundTripMs: number | null = null;
    let inferenceMs: number | null = null;
    let lastViewer = -Infinity;
    let ticks = 0;
    let windowStart = startedAt;
    let next = startedAt;

    while (!this.stopRequested) {
      const now = performance.now();
      if (this.opts.durationS > 0 && now - startedAt >= this.opts.durationS * 1000) return "duration";

      for (const message of channel.drain()) {
        if (message.type === "error") throw new Error(message.message);
        if (message.type === "actions" && pending && message.seq === pending.seq) {
          roundTripMs = now - pending.sentAt;
          inferenceMs = message.inference_ms;
          queue = alignChunk(message.actions, tick - pending.tick);
          pending = null;
        }
      }
      if (channel.closed) throw new Error("Lost the connection to the server.");

      if (document.hidden) {
        // Timers are throttled in a hidden tab: hold still, and start from a
        // fresh observation once visible again.
        queue = [];
      } else {
        const leadTicks = roundTripMs === null ? 0 : Math.ceil(roundTripMs / period);
        if (!pending && queue.length <= leadTicks) {
          pending = { seq: ++seq, tick, sentAt: performance.now() };
          channel.send(await this.observation(pending.seq, follower, cameras));
        }
        const action = queue.shift();
        if (action) {
          await follower.syncWrite(
            "Goal_Position",
            Object.fromEntries(motorOf.map((motor, i) => [motor, action[i]]))
          );
        }
      }

      if (now - lastViewer >= VIEWER_INTERVAL_MS) {
        lastViewer = now;
        try {
          this.opts.onJoints(toUrdfJoints(await follower.syncRead("Present_Position")));
        } catch {
          /* visualization is best-effort */
        }
      }

      ticks++;
      if (now - windowStart >= 1000) {
        this.set({
          stats: { inferenceMs, roundTripMs, queued: queue.length, loopHz: (ticks * 1000) / (now - windowStart) },
          elapsedS: (now - startedAt) / 1000,
        });
        ticks = 0;
        windowStart = now;
      }

      tick++;
      next += period;
      const wait = next - performance.now();
      if (wait < -period) next = performance.now();
      await sleep(Math.max(0, wait));
    }
    return "stopped";
  }

  private async observation(
    seq: number,
    follower: FeetechBus,
    cameras: [string, CameraCapture][]
  ): Promise<Uint8Array> {
    const state = await follower.syncRead("Present_Position");
    const frames: CameraFrame[] = await Promise.all(
      cameras.map(async ([name, camera]) => ({ name, jpeg: await camera.grab() }))
    );
    return encodeObservation(seq, state, frames);
  }

  /** Smoothly move back to `target`, as lerobot-rollout does before disconnecting. */
  private async returnTo(follower: FeetechBus, target: Record<string, number>): Promise<void> {
    const start = await follower.syncRead("Present_Position");
    const steps = Math.max(1, Math.trunc(RETURN_DURATION_S * RETURN_FPS));
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      await follower.syncWrite(
        "Goal_Position",
        Object.fromEntries(Object.keys(target).map((m) => [m, start[m] * (1 - t) + target[m] * t]))
      );
      await sleep(1000 / RETURN_FPS);
    }
  }
}
