// SO-101 arm definitions for the browser robot layer: motor table and the
// configure steps from lerobot's SOFollower / SOLeader
// (lerobot/robots/so_follower/so_follower.py, teleoperators/so_leader/so_leader.py).

import { BusMotor, FeetechBus } from "./feetechBus";
import { CalibrationFile, MotorCalibration } from "./normalization";
import { WebSerialTransport } from "./serialTransport";

export const SO101_MOTOR_NAMES = [
  "shoulder_pan",
  "shoulder_lift",
  "elbow_flex",
  "wrist_flex",
  "wrist_roll",
  "gripper",
] as const;

export const SO101_MOTORS: Record<string, BusMotor> = {
  shoulder_pan: { id: 1, mode: "degrees" },
  shoulder_lift: { id: 2, mode: "degrees" },
  elbow_flex: { id: 3, mode: "degrees" },
  wrist_flex: { id: 4, mode: "degrees" },
  wrist_roll: { id: 5, mode: "degrees" },
  gripper: { id: 6, mode: "range_0_100" },
};

/** Motor -> URDF joint names of the bundled SO-101 model (as in lelab/teleoperate.py). */
export const MOTOR_TO_URDF: Record<string, string> = {
  shoulder_pan: "Rotation",
  shoulder_lift: "Pitch",
  elbow_flex: "Elbow",
  wrist_flex: "Wrist_Pitch",
  wrist_roll: "Wrist_Roll",
  gripper: "Jaw",
};

/** "robot" is the follower arm, "teleop" the leader (the backend's device_type vocabulary). */
export type DeviceType = "robot" | "teleop";

/** Open a port and wrap it in an SO-101 bus. The caller owns `bus.disconnect()`. */
export async function openSo101Bus(port: SerialPort, calibration: CalibrationFile | null): Promise<FeetechBus> {
  const transport = new WebSerialTransport(port);
  await transport.open();
  return new FeetechBus(transport, SO101_MOTORS, calibration);
}

/** SOFollower.configure: position mode, softer PID, gripper torque limits; torque on at the end. */
export async function configureFollower(bus: FeetechBus): Promise<void> {
  await bus.disableTorque();
  try {
    await bus.configureMotors();
    for (const motor of bus.motorNames) {
      await bus.write(motor, "Operating_Mode", 0);
      // P lowered from the default 32 to avoid shakiness.
      await bus.write(motor, "P_Coefficient", 16);
      await bus.write(motor, "I_Coefficient", 0);
      await bus.write(motor, "D_Coefficient", 32);
      if (motor === "gripper") {
        await bus.write(motor, "Max_Torque_Limit", 500);
        await bus.write(motor, "Protection_Current", 250);
        await bus.write(motor, "Overload_Torque", 25);
      }
    }
  } finally {
    await bus.enableTorque();
  }
}

/** SOLeader.configure: torque off so the leader can be moved by hand. */
export async function configureLeader(bus: FeetechBus): Promise<void> {
  await bus.disableTorque();
  await bus.configureMotors();
  for (const motor of bus.motorNames) {
    await bus.write(motor, "Operating_Mode", 0);
  }
}

/** Joint positions for the URDF viewer. Every value goes through deg->rad, as the backend does. */
export function toUrdfJoints(positions: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(positions).map(([motor, deg]) => [MOTOR_TO_URDF[motor] ?? motor, (deg * Math.PI) / 180])
  );
}

const CALIBRATION_FIELDS = ["id", "drive_mode", "homing_offset", "range_min", "range_max"] as const;

/**
 * Validate a calibration JSON (as written by lerobot or by the browser
 * calibration) for the SO-101. Throws with a readable message otherwise.
 */
export function parseCalibrationFile(data: unknown): CalibrationFile {
  if (typeof data !== "object" || data === null) throw new Error("Calibration file is not a JSON object.");
  const record = data as Record<string, unknown>;
  const result: CalibrationFile = {};
  for (const motor of SO101_MOTOR_NAMES) {
    const entry = record[motor];
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Calibration file has no entry for '${motor}'.`);
    }
    const fields = entry as Record<string, unknown>;
    for (const field of CALIBRATION_FIELDS) {
      if (!Number.isInteger(fields[field])) {
        throw new Error(`Calibration entry '${motor}.${field}' is missing or not an integer.`);
      }
    }
    const cal = fields as unknown as MotorCalibration;
    if (cal.id !== SO101_MOTORS[motor].id) {
      throw new Error(`Calibration entry '${motor}' has id ${cal.id}, expected ${SO101_MOTORS[motor].id}.`);
    }
    if (cal.range_min >= cal.range_max) {
      throw new Error(`Calibration entry '${motor}' has range_min >= range_max.`);
    }
    result[motor] = {
      id: cal.id,
      drive_mode: cal.drive_mode,
      homing_offset: cal.homing_offset,
      range_min: cal.range_min,
      range_max: cal.range_max,
    };
  }
  return result;
}

/** Same layout as lerobot's draccus dump, so files are interchangeable. */
export function serializeCalibration(calibration: CalibrationFile): string {
  return JSON.stringify(calibration, null, 4);
}
