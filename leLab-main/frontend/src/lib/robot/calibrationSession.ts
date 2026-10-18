// In-browser SO-101 calibration: port of CalibrationManager in
// lelab/calibrate.py. Connect, set half-turn homing offsets, record each
// joint's range while the user moves it, then write the calibration to the
// motors. The result is the same JSON lerobot saves.

import { FeetechBus } from "./feetechBus";
import { CalibrationFile, halfTurnHoming } from "./normalization";
import { DeviceType, configureFollower, configureLeader, openSo101Bus } from "./so101";

export type CalibrationPhase = "idle" | "connecting" | "recording" | "saving" | "completed" | "error";

export interface MotorRange {
  min: number;
  max: number;
  current: number;
}

export interface CalibrationState {
  phase: CalibrationPhase;
  message: string;
  error: string | null;
  ranges: Record<string, MotorRange> | null;
  result: CalibrationFile | null;
  /** Motors whose recorded range looks too small (saved anyway, as the backend does). */
  warnings: string[];
}

export const INITIAL_CALIBRATION_STATE: CalibrationState = {
  phase: "idle",
  message: "",
  error: null,
  ranges: null,
  result: null,
  warnings: [],
};

// Same thresholds as lelab/calibrate.py.
const MIN_VALID_POSITION = 0;
const MAX_VALID_POSITION = 5000;
const MAX_POSITION_JUMP = 2000;
const MIN_CALIBRATION_RANGE = 100;
const RECORD_INTERVAL_MS = 50; // 20 Hz
const READ_ERROR_BACKOFF_MS = 200;

export const DISCONTINUITY_ERROR_PREFIX = "Motor discontinuity detected";

export class CalibrationDiscontinuityError extends Error {
  constructor() {
    super(
      `${DISCONTINUITY_ERROR_PREFIX}. Make sure to start the calibration with the robot in a ` +
        "middle position - all joints in the middle of their ranges."
    );
    this.name = "CalibrationDiscontinuityError";
  }
}

/** A reading at/below 0 or absurdly high is a bad frame, not a joint position. */
export function isValidPosition(pos: number): boolean {
  return MIN_VALID_POSITION < pos && pos < MAX_VALID_POSITION;
}

/**
 * Fold one set of raw readings into `ranges`, skipping bad frames. A jump of
 * more than MAX_POSITION_JUMP between readings is the encoder wrapping past
 * 0/4095, which would corrupt the range, so it aborts the calibration.
 */
export function updateRanges(ranges: Record<string, MotorRange>, positions: Record<string, number>): void {
  for (const [motor, pos] of Object.entries(positions)) {
    if (!isValidPosition(pos)) continue;
    const range = ranges[motor];
    if (!range) {
      ranges[motor] = { min: pos, max: pos, current: pos };
      continue;
    }
    if (Math.abs(pos - range.current) > MAX_POSITION_JUMP) throw new CalibrationDiscontinuityError();
    range.current = pos;
    range.min = Math.min(range.min, pos);
    range.max = Math.max(range.max, pos);
  }
}

export function buildCalibration(
  bus: Pick<FeetechBus, "motors">,
  homings: Record<string, number>,
  ranges: Record<string, MotorRange>
): CalibrationFile {
  const flat = Object.keys(bus.motors).filter((m) => ranges[m] && ranges[m].min === ranges[m].max);
  if (flat.length) throw new Error(`Some motors have the same min and max values: ${flat.join(", ")}`);
  return Object.fromEntries(
    Object.entries(bus.motors).map(([motor, { id }]) => [
      motor,
      {
        id,
        drive_mode: 0,
        homing_offset: homings[motor],
        range_min: ranges[motor].min,
        range_max: ranges[motor].max,
      },
    ])
  );
}

export function insufficientRanges(ranges: Record<string, MotorRange>): string[] {
  return Object.entries(ranges)
    .filter(([, r]) => r.max - r.min < MIN_CALIBRATION_RANGE)
    .map(([motor, r]) => `${motor}: ${r.max - r.min}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class BrowserCalibration {
  private bus: FeetechBus | null = null;
  private state: CalibrationState = INITIAL_CALIBRATION_STATE;
  private stopRequested = false;
  private completeRequested = false;
  private run: Promise<void> | null = null;

  constructor(
    private readonly deviceType: DeviceType,
    private readonly onChange: (state: CalibrationState) => void
  ) {}

  private set(patch: Partial<CalibrationState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  start(port: SerialPort): void {
    this.stopRequested = false;
    this.completeRequested = false;
    this.run = this.execute(port);
  }

  /** Finish range recording and save (the backend's "complete step"). */
  complete(): void {
    if (this.state.phase === "recording") this.completeRequested = true;
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    await this.run;
  }

  private async execute(port: SerialPort): Promise<void> {
    this.set({ ...INITIAL_CALIBRATION_STATE, phase: "connecting", message: "Connecting to the arm..." });
    try {
      this.bus = await openSo101Bus(port, null);
      await this.bus.connect();
      if (this.deviceType === "robot") await configureFollower(this.bus);
      else await configureLeader(this.bus);
      if (this.stopRequested) return await this.finishStopped();

      const homings = await this.setHomings(this.bus);
      if (this.stopRequested) return await this.finishStopped();

      const ranges = await this.recordRanges(this.bus);
      if (this.stopRequested) return await this.finishStopped();

      this.set({ phase: "saving", message: "Saving calibration to the motors..." });
      const calibration = buildCalibration(this.bus, homings, ranges);
      await this.bus.writeCalibration(calibration);
      await this.release();
      this.set({
        phase: "completed",
        message: "Calibration completed successfully",
        result: calibration,
        warnings: insufficientRanges(ranges),
      });
    } catch (e) {
      await this.release();
      this.set({ phase: "error", message: "Calibration failed", error: errorMessage(e) });
    }
  }

  private async finishStopped(): Promise<void> {
    await this.release();
    this.set({ ...INITIAL_CALIBRATION_STATE, message: "Calibration stopped" });
  }

  private async release(): Promise<void> {
    const bus = this.bus;
    this.bus = null;
    if (!bus) return;
    try {
      await bus.disconnect(true);
    } catch {
      /* port already gone; nothing left to release */
    }
  }

  /** Step 1: put every joint's current position at mid-range via the homing offset. */
  private async setHomings(bus: FeetechBus): Promise<Record<string, number>> {
    await bus.disableTorque();
    for (const motor of bus.motorNames) await bus.write(motor, "Operating_Mode", 0);
    await bus.resetCalibration();
    const positions = await bus.syncRead("Present_Position", bus.motorNames, { normalize: false });
    const homings = Object.fromEntries(Object.entries(positions).map(([m, pos]) => [m, halfTurnHoming(pos)]));
    for (const [motor, offset] of Object.entries(homings)) {
      await bus.write(motor, "Homing_Offset", offset, { normalize: false });
    }
    return homings;
  }

  /** Step 2: track min/max while the user moves every joint, until complete() or stop(). */
  private async recordRanges(bus: FeetechBus): Promise<Record<string, MotorRange>> {
    let start: Record<string, number> | null = null;
    for (let attempt = 0; attempt < 5 && !start; attempt++) {
      try {
        const positions = await bus.syncRead("Present_Position", bus.motorNames, { normalize: false });
        if (Object.values(positions).every(isValidPosition)) start = positions;
      } catch {
        /* retried below */
      }
      if (!start) await sleep(100);
    }
    if (!start) throw new Error("Could not get valid initial positions after multiple attempts");

    const ranges: Record<string, MotorRange> = Object.fromEntries(
      Object.entries(start).map(([m, pos]) => [m, { min: pos, max: pos, current: pos }])
    );
    this.set({
      phase: "recording",
      message:
        "Move ALL joints through their FULL ranges of motion - from minimum to maximum positions. " +
        "Ensure each joint moves significantly from its starting position.",
      ranges: structuredClone(ranges),
    });

    while (!this.stopRequested && !this.completeRequested) {
      try {
        const positions = await bus.syncRead("Present_Position", bus.motorNames, {
          normalize: false,
          retries: 2,
        });
        updateRanges(ranges, positions);
        this.set({ ranges: structuredClone(ranges) });
        await sleep(RECORD_INTERVAL_MS);
      } catch (e) {
        if (e instanceof CalibrationDiscontinuityError) throw e;
        await sleep(READ_ERROR_BACKOFF_MS);
      }
    }
    return ranges;
  }
}
