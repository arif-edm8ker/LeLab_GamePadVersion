# Copyright 2025 The HuggingFace Inc. team. All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Tests for lelab.browser_inference.

The parity test runs a small real ACT policy through PolicyRunner and through
lerobot's own SyncInferenceEngine (what `lerobot-rollout` uses for LeLab's
inference) and requires identical actions.
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np
import pytest
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient

from lelab import browser_inference as bi
from lelab.utils.config import SO101_MOTOR_IDS

MOTORS = list(SO101_MOTOR_IDS)


def _save_tiny_act(path: Path, height: int = 48, width: int = 64) -> None:
    """A small, randomly initialised ACT checkpoint saved like a training run's pretrained_model."""
    import torch

    from lerobot.configs import FeatureType, PolicyFeature
    from lerobot.policies import make_pre_post_processors
    from lerobot.policies.act.configuration_act import ACTConfig
    from lerobot.policies.act.modeling_act import ACTPolicy

    config = ACTConfig(
        input_features={
            "observation.state": PolicyFeature(type=FeatureType.STATE, shape=(6,)),
            "observation.images.front": PolicyFeature(type=FeatureType.VISUAL, shape=(3, height, width)),
        },
        output_features={"action": PolicyFeature(type=FeatureType.ACTION, shape=(6,))},
        chunk_size=6,
        n_action_steps=4,
        pretrained_backbone_weights=None,  # no download
        dim_model=32,
        n_heads=2,
        dim_feedforward=64,
        n_encoder_layers=1,
        n_decoder_layers=1,
        latent_dim=8,
        n_vae_encoder_layers=1,
        device="cpu",
    )
    torch.manual_seed(0)
    ACTPolicy(config).save_pretrained(path)
    stats = {
        "observation.state": {"mean": torch.full((6,), 5.0), "std": torch.full((6,), 20.0)},
        "action": {"mean": torch.full((6,), -3.0), "std": torch.full((6,), 15.0)},
        "observation.images.front": {"mean": torch.full((3, 1, 1), 0.4), "std": torch.full((3, 1, 1), 0.25)},
    }
    preprocessor, postprocessor = make_pre_post_processors(config, dataset_stats=stats)
    preprocessor.save_pretrained(path)
    postprocessor.save_pretrained(path)


def test_chunks_match_lerobot_sync_rollout(tmp_path: Path) -> None:
    pytest.importorskip("torch")
    from lerobot.configs.policies import PreTrainedConfig
    from lerobot.policies import make_pre_post_processors
    from lerobot.policies.act.modeling_act import ACTPolicy
    from lerobot.rollout.inference.sync import SyncInferenceEngine
    from lerobot.utils.constants import OBS_STR
    from lerobot.utils.feature_utils import build_dataset_frame

    path = tmp_path / "pretrained_model"
    _save_tiny_act(path)
    runner = bi.PolicyRunner(str(path), task="", device="cpu")
    assert runner.chunk_size == 4
    assert runner.cameras == {"front": (48, 64)}
    assert runner.action_names == [f"{m}.pos" for m in MOTORS]

    # An independently loaded copy driven exactly like lerobot-rollout's sync engine.
    config = PreTrainedConfig.from_pretrained(path)
    reference = ACTPolicy.from_pretrained(path, config=config)
    pre, post = make_pre_post_processors(
        policy_cfg=config,
        pretrained_path=str(path),
        preprocessor_overrides={"device_processor": {"device": "cpu"}},
    )
    engine = SyncInferenceEngine(
        reference,
        pre,
        post,
        dataset_features=runner.dataset_features,
        ordered_action_keys=runner.action_names,
        task="",
        device="cpu",
        robot_type=bi.ROBOT_TYPE,
    )
    engine.reset()

    rng = np.random.default_rng(0)
    for _ in range(2):  # the second chunk must come from the new observation
        state = dict(zip(MOTORS, rng.uniform(-90, 90, 6).tolist(), strict=True))
        image = rng.integers(0, 256, (48, 64, 3), dtype=np.uint8)
        chunk = runner.predict_chunk(state, {"front": image})

        obs_raw = {f"{m}.pos": v for m, v in state.items()} | {"front": image}
        frame = build_dataset_frame(runner.dataset_features, obs_raw, prefix=OBS_STR)
        expected = [engine.get_action(frame).tolist() for _ in range(runner.chunk_size)]
        np.testing.assert_array_equal(np.float32(chunk), np.float32(expected))


@pytest.mark.parametrize(
    ("cfg", "fragment"),
    [
        ({"type": "diffusion", "n_obs_steps": 2}, "last 2 observations"),
        ({"type": "vqbet", "n_obs_steps": 5}, "last 5 observations"),
        ({"type": "groot"}, "relative to the arm's state"),
        ({"type": "pi0", "use_relative_actions": True}, "relative to the arm's state"),
        ({"type": "act", "use_peft": True}, "PEFT"),
    ],
)
def test_blocker_explains_unsupported_policies(cfg: dict, fragment: str) -> None:
    assert fragment in bi.browser_inference_blocker(cfg)


@pytest.mark.parametrize("cfg", [{"type": "act", "n_obs_steps": 1}, {"type": "smolvla"}, {"type": "pi05"}])
def test_blocker_allows_single_observation_policies(cfg: dict) -> None:
    assert bi.browser_inference_blocker(cfg) is None


def _jpeg(rgb: np.ndarray) -> bytes:
    import cv2

    ok, buf = cv2.imencode(".jpg", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 95])
    assert ok
    return buf.tobytes()


def _observation(seq: int, state: dict, images: list[tuple[str, bytes]]) -> bytes:
    header = json.dumps(
        {"seq": seq, "state": state, "images": [{"name": n, "size": len(b)} for n, b in images]}
    ).encode()
    return struct.pack("<I", len(header)) + header + b"".join(b for _, b in images)


STATE = dict.fromkeys(MOTORS, 1.5)


def test_decode_observation_returns_rgb_frames() -> None:
    red = np.zeros((48, 64, 3), dtype=np.uint8)
    red[..., 0] = 220
    seq, state, images = bi.decode_observation(
        _observation(7, STATE, [("front", _jpeg(red))]), {"front": (48, 64)}
    )

    assert seq == 7
    assert state == STATE
    assert images["front"].shape == (48, 64, 3)
    r, g, b = images["front"].reshape(-1, 3).mean(axis=0)
    assert r > 200 and g < 20 and b < 20  # channel order is RGB, as the policy was trained on


@pytest.mark.parametrize(
    ("payload_kwargs", "message"),
    [
        ({"size": (32, 32)}, "the policy expects 64x48"),
        ({"cameras": []}, "missing camera"),
        ({"state": {"shoulder_pan": 1.0}}, "a number for each of"),
    ],
)
def test_decode_observation_rejects_bad_frames(payload_kwargs: dict, message: str) -> None:
    h, w = payload_kwargs.get("size", (48, 64))
    images = payload_kwargs.get("cameras", [("front", _jpeg(np.zeros((h, w, 3), dtype=np.uint8)))])
    payload = _observation(1, payload_kwargs.get("state", STATE), images)
    with pytest.raises(bi.BrowserInferenceError, match=message):
        bi.decode_observation(payload, {"front": (48, 64)})


def test_decode_observation_rejects_truncated_payload() -> None:
    with pytest.raises(bi.BrowserInferenceError, match="truncated"):
        bi.decode_observation(struct.pack("<I", 500) + b"{}", {"front": (48, 64)})


class FakeRunner:
    """Stands in for PolicyRunner so the WebSocket protocol can be tested without a model."""

    instances: list[FakeRunner] = []

    def __init__(self, policy_path: str, task: str = "") -> None:
        self.policy_path, self.task = policy_path, task
        self.cameras = {"front": (48, 64)}
        self.chunk_size = 3
        self.device = "cpu"
        self.closed = False
        self.seen_states: list[dict] = []
        FakeRunner.instances.append(self)

    @property
    def spec(self) -> dict:
        return {
            "policy_type": "act",
            "chunk_size": self.chunk_size,
            "cameras": {"front": {"height": 48, "width": 64}},
        }

    def predict_chunk(self, state: dict, images: dict) -> list[list[float]]:
        self.seen_states.append(state)
        return [[float(i)] * 6 for i in range(self.chunk_size)]

    def close(self) -> None:
        self.closed = True


@pytest.fixture
def ws_client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    FakeRunner.instances = []
    monkeypatch.setattr(bi, "PolicyRunner", FakeRunner)
    monkeypatch.setattr(bi, "_resolve_policy_path", lambda ref: str(tmp_path / ref))
    config = {"type": "act"}
    monkeypatch.setattr(bi, "_read_policy_config", lambda _path: config)

    def resolve(job_id: str, step: int) -> str:
        if job_id != "job1":
            raise LookupError(f"Job {job_id!r} not found")
        return f"ckpt-{step}"

    app = FastAPI()

    @app.websocket("/ws")
    async def endpoint(websocket: WebSocket):
        await bi.handle_browser_inference(websocket, resolve)

    with TestClient(app) as client:
        yield client, config


def test_websocket_session_runs_chunks_for_observations(ws_client) -> None:
    client, _config = ws_client
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "start", "job_id": "job1", "step": 2000, "task": "pick"})
        assert ws.receive_json() == {"type": "loading"}
        ready = ws.receive_json()
        assert ready["type"] == "ready" and ready["chunk_size"] == 3

        red = np.zeros((48, 64, 3), dtype=np.uint8)
        ws.send_bytes(_observation(5, STATE, [("front", _jpeg(red))]))
        reply = ws.receive_json()
        assert reply["type"] == "actions" and reply["seq"] == 5
        assert reply["actions"] == [[0.0] * 6, [1.0] * 6, [2.0] * 6]
        ws.send_json({"type": "stop"})

    runner = FakeRunner.instances[0]
    assert runner.policy_path.endswith("ckpt-2000") and runner.task == "pick"
    assert runner.seen_states == [STATE]
    assert runner.closed


def test_websocket_reports_why_a_policy_cannot_run(ws_client) -> None:
    client, config = ws_client
    config.update({"type": "diffusion", "n_obs_steps": 2})
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "start", "job_id": "job1", "step": 1, "task": ""})
        assert ws.receive_json() == {"type": "loading"}
        error = ws.receive_json()
    assert error["type"] == "error" and "last 2 observations" in error["message"]
    assert FakeRunner.instances == []


def test_websocket_only_runs_checkpoints_the_server_lists(ws_client) -> None:
    client, _config = ws_client
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "start", "job_id": "someone-elses", "step": 1, "task": ""})
        ws.receive_json()  # loading
        assert ws.receive_json() == {"type": "error", "message": "Job 'someone-elses' not found"}


def test_websocket_refuses_a_second_session(ws_client) -> None:
    client, _config = ws_client
    assert bi._session_lock.acquire(blocking=False)
    try:
        with client.websocket_connect("/ws") as ws:
            error = ws.receive_json()
        assert "already running a policy" in error["message"]
    finally:
        bi._session_lock.release()


def test_websocket_rejects_a_bad_first_message(ws_client) -> None:
    client, _config = ws_client
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "observation"})
        assert "first message must be" in ws.receive_json()["message"]


def test_server_exposes_browser_inference_route() -> None:
    from lelab.server import app

    assert "/ws/browser-inference" in {route.path for route in app.routes}
