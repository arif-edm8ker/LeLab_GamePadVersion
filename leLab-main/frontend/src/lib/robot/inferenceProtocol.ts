// Messages for the server's /ws/browser-inference endpoint
// (lelab/browser_inference.py): the page sends observations of an arm it
// drives, the server answers with chunks of actions from a trained policy.

/** What the server reports once the policy is loaded. */
export interface InferenceSpec {
  policy_type: string;
  device: string;
  /** Control rate the actions are meant to be played at. */
  fps: number;
  chunk_size: number;
  /** Policy camera name -> the frame size it expects. */
  cameras: Record<string, { height: number; width: number }>;
  state_names: string[];
  /** Order of the values in each action, e.g. "shoulder_pan.pos". */
  action_names: string[];
}

export type ServerMessage =
  | { type: "loading" }
  | ({ type: "ready" } & InferenceSpec)
  | { type: "actions"; seq: number; actions: number[][]; inference_ms: number }
  | { type: "error"; message: string };

export interface StartMessage {
  type: "start";
  job_id: string;
  step: number;
  task: string;
}

export interface CameraFrame {
  name: string;
  jpeg: Uint8Array;
}

/**
 * One observation as a binary message: a little-endian uint32 header
 * length, the JSON header {seq, state, images: [{name, size}]}, then each
 * camera's JPEG bytes in header order.
 */
export function encodeObservation(seq: number, state: Record<string, number>, frames: CameraFrame[]): Uint8Array {
  const header = new TextEncoder().encode(
    JSON.stringify({ seq, state, images: frames.map((f) => ({ name: f.name, size: f.jpeg.length })) })
  );
  const message = new Uint8Array(4 + header.length + frames.reduce((n, f) => n + f.jpeg.length, 0));
  new DataView(message.buffer).setUint32(0, header.length, true);
  message.set(header, 4);
  let offset = 4 + header.length;
  for (const frame of frames) {
    message.set(frame.jpeg, offset);
    offset += frame.jpeg.length;
  }
  return message;
}
