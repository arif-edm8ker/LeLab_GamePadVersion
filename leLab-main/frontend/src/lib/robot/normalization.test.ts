import { describe, expect, it } from "vitest";
import reference from "./__fixtures__/lerobot_reference.json";
import { CalibrationFile, halfTurnHoming, normalize, unnormalize } from "./normalization";
import { SO101_MOTORS } from "./so101";

const { calibration, cases, half_turn_homings } = reference.normalization;
const cal = calibration as CalibrationFile;

describe("normalization matches lerobot MotorsBus exactly", () => {
  it.each(cases)("$op $motor $in", ({ motor, op, in: input, out }) => {
    const mode = SO101_MOTORS[motor].mode;
    const fn = op === "normalize" ? normalize : unnormalize;
    // Exact equality: datasets and policies depend on identical values.
    expect(fn(motor, input, cal[motor], mode)).toBe(out);
  });

  it("rejects a calibration whose min equals max", () => {
    const flat = { ...cal.elbow_flex, range_max: cal.elbow_flex.range_min };
    expect(() => normalize("elbow_flex", 2000, flat, "degrees")).toThrow(/min and max are equal/);
  });
});

describe("halfTurnHoming matches _get_half_turn_homings", () => {
  it.each(Object.entries(half_turn_homings.positions))("%s", (motor, pos) => {
    expect(halfTurnHoming(pos)).toBe(half_turn_homings.homings[motor as keyof typeof half_turn_homings.homings]);
  });
});
