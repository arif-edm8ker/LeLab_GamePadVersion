"""Generate reference values for the browser robot layer's unit tests.

Runs the real Python implementations (scservo_sdk packet builder, lerobot's
FeetechMotorsBus normalization/sign encoding, lelab's gamepad mapping) and
writes their outputs to src/lib/robot/__fixtures__/lerobot_reference.json, so
the TypeScript port is tested against what the backend actually does.

Run from leLab-main/ with the same Python that runs LeLab:

    python frontend/scripts/gen_lerobot_fixtures.py
"""

import io
import json
import sys
from pathlib import Path

import draccus
import scservo_sdk as scs
from lerobot.motors import Motor, MotorCalibration, MotorNormMode
from lerobot.motors.encoding_utils import decode_sign_magnitude, encode_sign_magnitude
from lerobot.motors.feetech import FeetechMotorsBus

LELAB_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(LELAB_ROOT))
from lelab.gamepad_teleop import step_targets  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "src" / "lib" / "robot" / "__fixtures__" / "lerobot_reference.json"


class CapturePort:
    """Stand-in for scservo_sdk.PortHandler that records written bytes."""

    def __init__(self):
        self.is_using = False
        self.written: list[list[int]] = []

    def clearPort(self):  # noqa: N802
        pass

    def writePort(self, packet):  # noqa: N802
        self.written.append(list(packet))
        return len(packet)

    def setPacketTimeout(self, _length):  # noqa: N802
        pass

    def readPort(self, _length):  # noqa: N802
        return []

    def isPacketTimeout(self):  # noqa: N802
        return True


def packets() -> dict:
    ph = scs.PacketHandler(0)
    out = {}

    def capture(name, fn):
        port = CapturePort()
        fn(port)
        out[name] = port.written[0]

    capture("ping_id1", lambda p: ph.txPacket(p, [0, 0, 1, 2, scs.INST_PING, 0]))
    capture("read_id1_present_position", lambda p: ph.readTx(p, 1, 56, 2))
    capture(
        "write_id3_homing_offset_neg100",
        lambda p: ph.writeTxOnly(p, 3, 31, 2, [scs.SCS_LOBYTE(2148), scs.SCS_HIBYTE(2148)]),
    )
    capture("write_id6_torque_enable_1", lambda p: ph.writeTxOnly(p, 6, 40, 1, [1]))
    capture("sync_read_present_position_ids1to6", lambda p: ph.syncReadTx(p, 56, 2, [1, 2, 3, 4, 5, 6], 6))
    goal = {1: 2047, 2: 1000, 3: 3000, 4: 0, 5: 4095, 6: 2500}
    params = []
    for id_, v in goal.items():
        params += [id_, scs.SCS_LOBYTE(v), scs.SCS_HIBYTE(v)]
    capture(
        "sync_write_goal_position_ids1to6",
        lambda p: ph.syncWriteTxOnly(p, 42, 2, params, len(params)),
    )
    out["sync_write_goal_position_values"] = {str(k): v for k, v in goal.items()}
    return out


SO101_NAMES = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]
CALIBRATION = {
    "shoulder_pan": MotorCalibration(id=1, drive_mode=0, homing_offset=-1024, range_min=758, range_max=3292),
    "shoulder_lift": MotorCalibration(id=2, drive_mode=0, homing_offset=1215, range_min=816, range_max=3205),
    "elbow_flex": MotorCalibration(id=3, drive_mode=0, homing_offset=-1530, range_min=885, range_max=3080),
    "wrist_flex": MotorCalibration(id=4, drive_mode=0, homing_offset=128, range_min=841, range_max=3157),
    "wrist_roll": MotorCalibration(id=5, drive_mode=0, homing_offset=-7, range_min=168, range_max=3994),
    "gripper": MotorCalibration(id=6, drive_mode=0, homing_offset=1987, range_min=2025, range_max=3478),
}


def make_bus() -> FeetechMotorsBus:
    motors = {
        name: Motor(i + 1, "sts3215", MotorNormMode.RANGE_0_100 if name == "gripper" else MotorNormMode.DEGREES)
        for i, name in enumerate(SO101_NAMES)
    }
    return FeetechMotorsBus(port="/dev/null", motors=motors, calibration=CALIBRATION)


def normalization() -> dict:
    bus = make_bus()
    raw_samples = [0, 500, 758, 2047, 2048, 3292, 3500, 4095]
    norm_samples = [-180.0, -95.5, -12.34, 0.0, 0.4, 33.333, 99.9, 150.0]
    gripper_norm_samples = [-5.0, 0.0, 12.5, 50.0, 99.99, 100.0, 120.0]
    cases = []
    for name in SO101_NAMES:
        id_ = bus.motors[name].id
        for raw in raw_samples:
            cases.append({"motor": name, "op": "normalize", "in": raw, "out": bus._normalize({id_: raw})[id_]})
        for val in gripper_norm_samples if name == "gripper" else norm_samples:
            cases.append(
                {"motor": name, "op": "unnormalize", "in": val, "out": bus._unnormalize({id_: val})[id_]}
            )
    homings = bus._get_half_turn_homings({name: 1000 + 300 * i for i, name in enumerate(SO101_NAMES)})
    return {
        "calibration": {name: vars(cal) for name, cal in CALIBRATION.items()},
        "cases": cases,
        "half_turn_homings": {
            "positions": {name: 1000 + 300 * i for i, name in enumerate(SO101_NAMES)},
            "homings": homings,
        },
    }


def sign_magnitude() -> dict:
    cases = []
    for bit, values in ((11, [0, 1, -1, 2047, -2047, -1024, 300]), (15, [0, 5, -5, 32767, -32767, 4095])):
        for v in values:
            enc = encode_sign_magnitude(v, bit)
            cases.append({"bit": bit, "value": v, "encoded": enc, "decoded": decode_sign_magnitude(enc, bit)})
    return {"cases": cases}


def calibration_json() -> str:
    buf = io.StringIO()
    with draccus.config_type("json"):
        draccus.dump(CALIBRATION, buf, indent=4)
    return buf.getvalue()


class FakeJoystick:
    """pygame-style joystick with the reference controllers' layout."""

    def __init__(self, axes, buttons, hat=None):
        self._axes = axes
        self._buttons = buttons
        self._hat = hat

    def get_axis(self, i):
        return self._axes[i]

    def get_button(self, i):
        return 1 if i in self._buttons else 0

    def get_numhats(self):
        return 0 if self._hat is None else 1

    def get_hat(self, _i):
        return (0, self._hat)


def gamepad() -> dict:
    # Each scenario: pygame axes (LX, LY, RX, RY, L2, R2 with triggers -1..1),
    # D-pad direction (+1 up / -1 down / 0), dt.
    scenarios = [
        {"axes": [0.0, 0.0, 0.0, 0.0, -1.0, -1.0], "dpad": 0, "dt": 0.02},
        {"axes": [0.07, -0.079, 0.19, 0.08, -1.0, -1.0], "dpad": 0, "dt": 0.02},
        {"axes": [1.0, -1.0, 0.5, -0.5, -1.0, 1.0], "dpad": 1, "dt": 0.02},
        {"axes": [-0.6, 0.3, -0.25, 0.9, 1.0, -1.0], "dpad": -1, "dt": 0.033},
        {"axes": [0.5, 0.5, 0.5, 0.5, 0.0, 0.0], "dpad": 0, "dt": 5.0},
    ]
    start = {
        "shoulder_pan": 0.0,
        "shoulder_lift": 95.0,
        "elbow_flex": -98.0,
        "wrist_flex": 10.0,
        "wrist_roll": -20.0,
        "gripper": 3.0,
    }
    for s in scenarios:
        hat_js = FakeJoystick(s["axes"], set(), hat=s["dpad"])
        buttons = {11} if s["dpad"] == 1 else {12} if s["dpad"] == -1 else set()
        button_js = FakeJoystick(s["axes"], buttons)
        via_hat = step_targets(hat_js, dict(start), s["dt"])
        via_buttons = step_targets(button_js, dict(start), s["dt"])
        assert via_hat == via_buttons
        s["start"] = start
        s["out"] = via_hat
    return {"scenarios": scenarios}


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "packets": packets(),
        "normalization": normalization(),
        "sign_magnitude": sign_magnitude(),
        "calibration_json": calibration_json(),
        "gamepad": gamepad(),
    }
    OUT.write_text(json.dumps(data, indent=2) + "\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
