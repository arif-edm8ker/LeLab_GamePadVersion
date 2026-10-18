// Raw encoder steps <-> lerobot units, ported from lerobot's
// MotorsBus._normalize / _unnormalize (lerobot/motors/motors_bus.py).
// Operation order is kept identical so results match the Python bit for bit;
// recorded data and trained policies depend on these exact values.

import { STS3215_RESOLUTION } from "./feetechProtocol";

/** SO-101 joints use degrees (use_degrees=True); the gripper uses 0-100. */
export type NormMode = "degrees" | "range_0_100";

export interface MotorCalibration {
  id: number;
  drive_mode: number;
  homing_offset: number;
  range_min: number;
  range_max: number;
}

/** The calibration JSON lerobot writes under calibration/{robots,teleoperators}/. */
export type CalibrationFile = Record<string, MotorCalibration>;

const MAX_RES = STS3215_RESOLUTION - 1;

function checkRange(motor: string, cal: MotorCalibration): void {
  if (cal.range_max === cal.range_min) {
    throw new Error(`Invalid calibration for motor '${motor}': min and max are equal.`);
  }
}

export function normalize(motor: string, raw: number, cal: MotorCalibration, mode: NormMode): number {
  checkRange(motor, cal);
  const min = cal.range_min;
  const max = cal.range_max;
  if (mode === "degrees") {
    const mid = (min + max) / 2;
    return ((raw - mid) * 360) / MAX_RES;
  }
  const bounded = Math.min(max, Math.max(min, raw));
  const norm = ((bounded - min) / (max - min)) * 100;
  return cal.drive_mode ? 100 - norm : norm;
}

export function unnormalize(motor: string, value: number, cal: MotorCalibration, mode: NormMode): number {
  checkRange(motor, cal);
  const min = cal.range_min;
  const max = cal.range_max;
  if (mode === "degrees") {
    const mid = (min + max) / 2;
    return Math.trunc((value * MAX_RES) / 360 + mid);
  }
  const v = cal.drive_mode ? 100 - value : value;
  const bounded = Math.min(100.0, Math.max(0.0, v));
  return Math.trunc((bounded / 100) * (max - min) + min);
}

/**
 * Homing offset that puts the current position at the middle of the encoder
 * range (FeetechMotorsBus._get_half_turn_homings). On Feetech motors
 * Present_Position = Actual_Position - Homing_Offset.
 */
export function halfTurnHoming(rawPosition: number): number {
  return rawPosition - Math.trunc(MAX_RES / 2);
}
