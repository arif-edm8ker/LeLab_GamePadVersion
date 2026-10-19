import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import reference from "./__fixtures__/lerobot_reference.json";
import { STS_REGISTERS, decodeSignMagnitude } from "./feetechProtocol";
import { InferenceSpec, encodeObservation } from "./inferenceProtocol";
import { BrowserInference, InferenceState, alignChunk } from "./inferenceSession";
import { CalibrationFile, normalize, unnormalize } from "./normalization";
import { SO101_MOTORS, SO101_MOTOR_NAMES } from "./so101";
import { FakeSerialPort, ServoBusSim, waitFor } from "./testing/fakeServos";

const calibration = reference.normalization.calibration as CalibrationFile;
const goalOf = (sim: ServoBusSim, id: number) =>
  decodeSignMagnitude(sim.servo(id).word(STS_REGISTERS.Goal_Position[0]), 15);
const torqueOf = (sim: ServoBusSim, id: number) => sim.servo(id).memory[STS_REGISTERS.Torque_Enable[0]];

const SPEC: InferenceSpec = {
  policy_type: "act",
  device: "cpu",
  fps: 30,
  chunk_size: 5,
  cameras: { front: { height: 4, width: 4 } },
  state_names: SO101_MOTOR_NAMES.map((m) => `${m}.pos`),
  action_names: SO101_MOTOR_NAMES.map((m) => `${m}.pos`),
};
const ACTION = [10, -20, 30, 5, 0, 40];

/** Parse an observation the way lelab/browser_inference.py's decode_observation does. */
function decode(message: Uint8Array) {
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const headerLength = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(message.subarray(4, 4 + headerLength)));
  let offset = 4 + headerLength;
  const images: Record<string, number[]> = {};
  for (const { name, size } of header.images) {
    images[name] = [...message.subarray(offset, offset + size)];
    offset += size;
  }
  return { seq: header.seq as number, state: header.state as Record<string, number>, images, total: offset };
}

type Script = (data: string | Uint8Array, socket: FakeSocket) => void;

class FakeSocket {
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: (string | Uint8Array)[] = [];
  closed = false;

  constructor(private readonly script: Script) {
    setTimeout(() => this.onopen?.(), 0);
  }

  send(data: string | Uint8Array) {
    if (this.closed) throw new Error("closed");
    this.sent.push(data);
    this.script(data, this);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    setTimeout(() => this.onclose?.(), 0);
  }

  reply(message: object, delayMs = 0) {
    setTimeout(() => !this.closed && this.onmessage?.({ data: JSON.stringify(message) }), delayMs);
  }
}

/** A server that loads instantly and answers every observation with ACTION repeated. */
const policyServer =
  (onObservation?: (obs: ReturnType<typeof decode>, socket: FakeSocket) => boolean): Script =>
  (data, socket) => {
    if (typeof data === "string") {
      if (JSON.parse(data).type === "start") {
        socket.reply({ type: "loading" });
        socket.reply({ type: "ready", ...SPEC });
      }
      return;
    }
    const obs = decode(data);
    if (onObservation?.(obs, socket)) return;
    socket.reply({ type: "actions", seq: obs.seq, actions: Array(SPEC.chunk_size).fill(ACTION), inference_ms: 3 }, 20);
  };

function session(script: Script, overrides: Partial<ConstructorParameters<typeof BrowserInference>[0]> = {}) {
  const sim = new ServoBusSim();
  const states: InferenceState[] = [];
  const sockets: FakeSocket[] = [];
  const cameraCalls: [string, number, number][] = [];
  const inference = new BrowserInference({
    followerPort: new FakeSerialPort(sim),
    followerCalibration: calibration,
    socketUrl: "ws://server/ws/browser-inference",
    jobId: "job1",
    step: 2000,
    task: "pick",
    durationS: 0,
    cameraDevices: { front: "cam-1" },
    onState: (s) => states.push(s),
    onJoints: () => undefined,
    openCamera: async (deviceId, width, height) => {
      cameraCalls.push([deviceId, width, height]);
      return { grab: async () => Uint8Array.from([0xff, 0xd8, 7]), close: () => undefined };
    },
    openSocket: () => {
      const socket = new FakeSocket(script);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    ...overrides,
  });
  return { inference, sim, states, sockets, cameraCalls, latest: () => states[states.length - 1] };
}

beforeEach(() => vi.stubGlobal("document", { hidden: false }));
afterEach(() => vi.unstubAllGlobals());

describe("BrowserInference", () => {
  it(
    "plays the policy's chunks on the arm, then returns to the start pose and releases it",
    async () => {
      const { inference, sim, sockets, cameraCalls, latest } = session(policyServer());
      inference.start();
      await waitFor(() => latest()?.phase === "running");
      expect(cameraCalls).toEqual([["cam-1", 4, 4]]);

      const start = JSON.parse(sockets[0].sent[0] as string);
      expect(start).toEqual({ type: "start", job_id: "job1", step: 2000, task: "pick" });

      // Observations carry the arm's normalized joint positions and each camera's JPEG.
      await waitFor(() => sockets[0].sent.length > 1);
      const obs = decode(sockets[0].sent[1] as Uint8Array);
      expect(obs.images).toEqual({ front: [0xff, 0xd8, 7] });
      expect(obs.total).toBe((sockets[0].sent[1] as Uint8Array).length);
      for (const [motor, { id, mode }] of Object.entries(SO101_MOTORS)) {
        const present = sim.servo(id).actual - calibration[motor].homing_offset;
        expect(obs.state[motor]).toBe(normalize(motor, present, calibration[motor], mode));
      }

      // The returned actions reach the motors as goal positions.
      await waitFor(() =>
        Object.entries(SO101_MOTORS).every(
          ([motor, { id, mode }], i) => goalOf(sim, id) === unnormalize(motor, ACTION[i], calibration[motor], mode)
        )
      );

      await inference.stop();
      expect(latest().phase).toBe("stopped");
      for (const [motor, { id, mode }] of Object.entries(SO101_MOTORS)) {
        // Back where it started, as normalized then unnormalized (the 0-100
        // gripper range clamps a reading outside its calibration).
        const present = sim.servo(id).actual - calibration[motor].homing_offset;
        const start = unnormalize(motor, normalize(motor, present, calibration[motor], mode), calibration[motor], mode);
        expect(Math.abs(goalOf(sim, id) - start)).toBeLessThanOrEqual(1);
        expect(torqueOf(sim, id)).toBe(0);
      }
      expect(sockets[0].sent.at(-1)).toBe(JSON.stringify({ type: "stop" }));
    },
    15000
  );

  it(
    "reports a server error and still releases the arm",
    async () => {
      const { inference, sim, latest } = session(
        policyServer((_obs, socket) => {
          socket.reply({ type: "error", message: "Inference failed on the server: boom" });
          return true;
        })
      );
      inference.start();
      await waitFor(() => latest()?.phase === "error", 8000);
      expect(latest().error).toBe("Inference failed on the server: boom");
      expect(torqueOf(sim, 1)).toBe(0);
      await inference.stop();
    },
    15000
  );

  it(
    "stops by itself at the time limit",
    async () => {
      const { inference, latest } = session(policyServer(), { durationS: 0.3 });
      inference.start();
      await waitFor(() => latest()?.phase === "stopped", 8000);
      expect(latest().message).toMatch(/time limit/);
    },
    15000
  );

  it("needs a camera for every camera the policy uses", async () => {
    const { inference, latest } = session(policyServer(), { cameraDevices: {} });
    inference.start();
    await waitFor(() => latest()?.phase === "error", 8000);
    expect(latest().error).toBe('Choose a camera for "front".');
    await inference.stop();
  }, 15000);

  it("can be stopped while the server is still loading the policy", async () => {
    const { inference, latest, sim } = session((data, socket) => {
      if (typeof data === "string" && JSON.parse(data).type === "start") socket.reply({ type: "loading" });
    });
    inference.start();
    await waitFor(() => latest()?.phase === "loading");
    await inference.stop();
    expect(latest().phase).toBe("stopped");
    expect(latest().error).toBeNull();
    expect(torqueOf(sim, 1)).toBe(0);
  }, 15000);
});

describe("alignChunk", () => {
  const chunk = [[0], [1], [2], [3]];

  it("drops the actions for ticks that passed during the round trip", () => {
    expect(alignChunk(chunk, 0)).toEqual(chunk);
    expect(alignChunk(chunk, 2)).toEqual([[2], [3]]);
  });

  it("always keeps the last action", () => {
    expect(alignChunk(chunk, 9)).toEqual([[3]]);
    expect(alignChunk([[5]], 3)).toEqual([[5]]);
  });
});

describe("encodeObservation", () => {
  it("frames the header and images as the server expects", () => {
    const message = encodeObservation(3, { shoulder_pan: 1.5 }, [
      { name: "front", jpeg: Uint8Array.from([1, 2]) },
      { name: "wrist", jpeg: Uint8Array.from([3]) },
    ]);
    const decoded = decode(message);
    expect(decoded.seq).toBe(3);
    expect(decoded.state).toEqual({ shoulder_pan: 1.5 });
    expect(decoded.images).toEqual({ front: [1, 2], wrist: [3] });
    expect(decoded.total).toBe(message.length);
  });
});
