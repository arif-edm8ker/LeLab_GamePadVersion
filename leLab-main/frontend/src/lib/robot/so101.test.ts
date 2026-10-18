import { describe, expect, it } from "vitest";
import reference from "./__fixtures__/lerobot_reference.json";
import { CalibrationFile } from "./normalization";
import { parseCalibrationFile, serializeCalibration, toUrdfJoints } from "./so101";

const calibration = reference.normalization.calibration as CalibrationFile;

describe("calibration files", () => {
  it("serializes exactly like lerobot's draccus dump", () => {
    expect(serializeCalibration(calibration)).toBe(reference.calibration_json);
  });

  it("parses a lerobot calibration file", () => {
    expect(parseCalibrationFile(JSON.parse(reference.calibration_json))).toEqual(calibration);
  });

  it("rejects a file missing a motor", () => {
    const { gripper: _gripper, ...rest } = calibration;
    expect(() => parseCalibrationFile(rest)).toThrow(/gripper/);
  });

  it("rejects a motor id that doesn't match the SO-101 layout", () => {
    expect(() => parseCalibrationFile({ ...calibration, elbow_flex: { ...calibration.elbow_flex, id: 9 } })).toThrow(
      /expected 3/
    );
  });

  it("rejects non-integer fields", () => {
    const bad = { ...calibration, wrist_roll: { ...calibration.wrist_roll, range_max: "4000" } };
    expect(() => parseCalibrationFile(bad)).toThrow(/wrist_roll.range_max/);
  });
});

describe("toUrdfJoints", () => {
  it("maps motor names to URDF joints in radians, like the backend", () => {
    expect(toUrdfJoints({ shoulder_pan: 90, gripper: 50 })).toEqual({ Rotation: Math.PI / 2, Jaw: (50 * Math.PI) / 180 });
  });
});
