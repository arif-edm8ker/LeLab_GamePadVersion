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
"""Run a trained policy for an arm that the browser drives (browser mode).

The page reads the arm and its cameras, sends one observation over
/ws/browser-inference, and plays back the chunk of actions it gets in reply,
so the arm can be plugged into a different computer than the one running
this server.

The policy, its pre/post-processors and the observation/action features are
set up the way `lerobot-rollout` sets them up for LeLab's own inference
(lelab/rollout.py, sync inference, base strategy). Each chunk is produced by
calling `select_action` `n_action_steps` times on the observation: exactly
the actions the sync rollout would play from it, without a network round
trip per control tick.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import struct
import threading
import time
from collections.abc import Callable
from copy import copy
from typing import Any

import numpy as np
from fastapi import WebSocket, WebSocketDisconnect

from .rollout import _detect_device, _read_policy_config, _resolve_policy_path
from .utils.config import SO101_MOTOR_IDS

logger = logging.getLogger(__name__)

# lerobot-rollout's default control rate, which LeLab's inference runs at.
FPS = 30
# SOFollower.name: what lerobot-rollout passes to policies as robot_type.
ROBOT_TYPE = "so_follower"
STATE_NAMES = [f"{motor}.pos" for motor in SO101_MOTOR_IDS]

_HEADER_LENGTH = struct.Struct("<I")


def browser_inference_blocker(cfg: dict[str, Any]) -> str | None:
    """Why a policy (its config.json) can't run for a browser-driven arm, or None."""
    policy_type = cfg.get("type") or "This"
    if cfg.get("use_relative_actions") or policy_type == "groot":
        return (
            f"{policy_type} policies predict actions relative to the arm's state, which needs the "
            "installed app's chunked (RTC) inference. Run this policy with the installed app for now."
        )
    n_obs_steps = cfg.get("n_obs_steps") or 1
    if n_obs_steps > 1:
        return (
            f"This {policy_type} policy looks at the last {n_obs_steps} observations, which the browser "
            "doesn't stream yet. Run it with the installed app for now."
        )
    if cfg.get("use_peft"):
        return "Adapter (PEFT) policies can't run in the browser yet. Run it with the installed app for now."
    return None


class BrowserInferenceError(ValueError):
    """A problem to report to the page as-is."""


class PolicyRunner:
    """A loaded policy and everything needed to turn one observation into a
    chunk of actions. Construction loads the weights, so run it off the event loop."""

    def __init__(self, policy_path: str, task: str = "", device: str | None = None) -> None:
        import torch

        from lerobot.configs import FeatureType
        from lerobot.configs.policies import PreTrainedConfig
        from lerobot.datasets import aggregate_pipeline_dataset_features, create_initial_features
        from lerobot.policies import get_policy_class, make_pre_post_processors
        from lerobot.processor import make_default_processors
        from lerobot.processor.relative_action_processor import RelativeActionsProcessorStep

        # Private, but it is the exact rule lerobot-rollout uses for action order.
        from lerobot.rollout.context import _resolve_action_key_order
        from lerobot.utils.feature_utils import combine_feature_dicts

        self.device = device or _detect_device()
        self.task = task

        config = PreTrainedConfig.from_pretrained(policy_path)
        config.pretrained_path = policy_path
        config.device = self.device
        self.policy_type = config.type

        policy = get_policy_class(config.type).from_pretrained(policy_path, config=config)
        self.policy = policy.to(self.device)
        self.policy.eval()

        self.cameras: dict[str, tuple[int, int]] = {}
        for key, feature in config.input_features.items():
            if feature.type is FeatureType.VISUAL:
                _channels, height, width = feature.shape
                self.cameras[key.removeprefix("observation.images.")] = (int(height), int(width))

        # The features SOFollower would report with these cameras attached.
        observation_features_hw: dict[str, Any] = dict.fromkeys(STATE_NAMES, float)
        observation_features_hw.update({name: (h, w, 3) for name, (h, w) in self.cameras.items()})
        action_features_hw = dict.fromkeys(STATE_NAMES, float)

        teleop_action_processor, self.robot_action_processor, self.robot_observation_processor = (
            make_default_processors()
        )
        self.dataset_features = combine_feature_dicts(
            aggregate_pipeline_dataset_features(
                pipeline=teleop_action_processor,
                initial_features=create_initial_features(action=action_features_hw),
                use_videos=True,
            ),
            aggregate_pipeline_dataset_features(
                pipeline=self.robot_observation_processor,
                initial_features=create_initial_features(observation=observation_features_hw),
                use_videos=True,
            ),
        )
        policy_action_names = getattr(config, "action_feature_names", None)
        self.action_names = _resolve_action_key_order(
            list(policy_action_names) if policy_action_names else None, list(action_features_hw)
        )

        self.preprocessor, self.postprocessor = make_pre_post_processors(
            policy_cfg=config,
            pretrained_path=policy_path,
            dataset_stats=None,
            preprocessor_overrides={
                "device_processor": {"device": self.device},
                "rename_observations_processor": {"rename_map": {}},
            },
        )
        if any(
            isinstance(step, RelativeActionsProcessorStep) and step.enabled
            for step in getattr(self.preprocessor, "steps", ())
        ):
            raise BrowserInferenceError(
                "This policy uses relative actions, which needs the installed app's chunked (RTC) "
                "inference. Run it with the installed app for now."
            )

        self.chunk_size = max(1, int(getattr(config, "n_action_steps", 1) or 1))
        self._use_amp = self.device.startswith("cuda") and bool(getattr(config, "use_amp", False))
        self._torch = torch

        # As at the start of a rollout: empty action queues and processor state.
        self.policy.reset()
        self.preprocessor.reset()
        self.postprocessor.reset()

    @property
    def spec(self) -> dict[str, Any]:
        return {
            "policy_type": self.policy_type,
            "device": self.device,
            "fps": FPS,
            "chunk_size": self.chunk_size,
            "cameras": {name: {"height": h, "width": w} for name, (h, w) in self.cameras.items()},
            "state_names": STATE_NAMES,
            "action_names": self.action_names,
        }

    def predict_chunk(self, state: dict[str, float], images: dict[str, np.ndarray]) -> list[list[float]]:
        """Actions for the next `chunk_size` control ticks, in `action_names` order.

        `state` maps each SO-101 motor to its normalized position; `images`
        maps each policy camera to an RGB uint8 HxWx3 frame.
        """
        from lerobot.policies.utils import make_robot_action, prepare_observation_for_inference
        from lerobot.utils.constants import OBS_STR
        from lerobot.utils.feature_utils import build_dataset_frame

        torch = self._torch
        obs_raw: dict[str, Any] = {f"{motor}.pos": float(state[motor]) for motor in SO101_MOTOR_IDS}
        obs_raw.update(images)
        obs_processed = self.robot_observation_processor(obs_raw)
        frame = build_dataset_frame(self.dataset_features, obs_processed, prefix=OBS_STR)

        autocast = torch.autocast(device_type="cuda") if self._use_amp else contextlib.nullcontext()
        chunk: list[list[float]] = []
        with torch.inference_mode(), autocast:
            observation = prepare_observation_for_inference(
                copy(frame), torch.device(self.device), self.task, ROBOT_TYPE
            )
            observation = self.preprocessor(observation)
            # The first call runs the model on this observation (the queue is
            # empty); the rest pop the chunk it queued, as the sync rollout's
            # per-tick calls would.
            for _ in range(self.chunk_size):
                action = self.postprocessor(self.policy.select_action(dict(observation)))
                action_dict = make_robot_action(action.squeeze(0).cpu(), self.dataset_features)
                ordered = {key: action_dict[key] for key in self.action_names}
                sent = self.robot_action_processor((ordered, obs_raw))
                chunk.append([float(sent[key]) for key in self.action_names])
        return chunk

    def close(self) -> None:
        """Release the model, and GPU memory when on CUDA."""
        self.policy = None
        if self.device.startswith("cuda"):
            self._torch.cuda.empty_cache()


def decode_observation(
    payload: bytes, cameras: dict[str, tuple[int, int]]
) -> tuple[int, dict[str, float], dict[str, np.ndarray]]:
    """Unpack one observation from the page.

    Layout: a little-endian uint32 header length, the UTF-8 JSON header
    {"seq", "state": {motor: value}, "images": [{"name", "size"}]}, then each
    camera's JPEG bytes in header order. Returns (seq, state, RGB frames).
    """
    import cv2

    if len(payload) < _HEADER_LENGTH.size:
        raise BrowserInferenceError("Observation message is too short.")
    (header_length,) = _HEADER_LENGTH.unpack_from(payload)
    body_start = _HEADER_LENGTH.size + header_length
    if body_start > len(payload):
        raise BrowserInferenceError("Observation header is truncated.")
    try:
        header = json.loads(payload[_HEADER_LENGTH.size : body_start].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise BrowserInferenceError("Observation header is not valid JSON.") from e

    raw_state = header.get("state")
    if not isinstance(raw_state, dict) or any(
        not isinstance(raw_state.get(motor), int | float) for motor in SO101_MOTOR_IDS
    ):
        raise BrowserInferenceError(
            f"Observation state must give a number for each of {list(SO101_MOTOR_IDS)}."
        )
    state = {motor: float(raw_state[motor]) for motor in SO101_MOTOR_IDS}

    images: dict[str, np.ndarray] = {}
    offset = body_start
    for entry in header.get("images") or []:
        name, size = entry.get("name"), entry.get("size")
        if name not in cameras or not isinstance(size, int) or offset + size > len(payload):
            raise BrowserInferenceError(f"Unexpected or truncated camera image {name!r}.")
        bgr = cv2.imdecode(
            np.frombuffer(payload, dtype=np.uint8, count=size, offset=offset), cv2.IMREAD_COLOR
        )
        offset += size
        if bgr is None:
            raise BrowserInferenceError(f"Camera {name!r} sent an image that isn't a valid JPEG.")
        height, width = cameras[name]
        if bgr.shape[:2] != (height, width):
            raise BrowserInferenceError(
                f"Camera {name!r} sent {bgr.shape[1]}x{bgr.shape[0]}, the policy expects {width}x{height}."
            )
        # The policy was trained on RGB frames (lerobot's OpenCVCamera default).
        images[name] = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

    missing = set(cameras) - set(images)
    if missing:
        raise BrowserInferenceError(f"Observation is missing camera(s): {', '.join(sorted(missing))}.")
    return int(header.get("seq", 0)), state, images


# One browser inference at a time: each holds a whole policy in (GPU) memory.
_session_lock = threading.Lock()


async def handle_browser_inference(
    websocket: WebSocket, resolve_checkpoint: Callable[[str, int], str]
) -> None:
    """Serve one browser inference session over an accepted-on-entry WebSocket.

    Protocol: the page sends {"type": "start", "job_id", "step", "task"}; the
    server answers {"type": "loading"} then {"type": "ready", ...spec} once the
    policy is loaded. Each binary observation (see decode_observation) gets
    {"type": "actions", "seq", "actions", "inference_ms"}. {"type": "stop"} or
    closing the socket ends the session. Problems arrive as {"type": "error"}.
    `resolve_checkpoint(job_id, step)` maps a training job's checkpoint to its
    policy ref, so the page can only run checkpoints this server lists.
    """
    await websocket.accept()
    if not _session_lock.acquire(blocking=False):
        await _send_error(websocket, "Another browser is already running a policy on this server.")
        return

    runner: PolicyRunner | None = None
    try:
        start = await websocket.receive_json()
        if not isinstance(start, dict) or start.get("type") != "start":
            raise BrowserInferenceError('The first message must be {"type": "start", ...}.')
        job_id, step, task = start.get("job_id"), start.get("step"), start.get("task") or ""
        if not isinstance(job_id, str) or not isinstance(step, int) or not isinstance(task, str):
            raise BrowserInferenceError("start needs a job_id (string), step (integer) and task (string).")

        await websocket.send_json({"type": "loading"})
        try:
            ref = resolve_checkpoint(job_id, step)
        except (LookupError, ValueError) as e:
            raise BrowserInferenceError(str(e)) from e
        policy_path = await asyncio.to_thread(_resolve_policy_path, ref)
        blocker = browser_inference_blocker(_read_policy_config(policy_path))
        if blocker:
            raise BrowserInferenceError(blocker)
        runner = await asyncio.to_thread(PolicyRunner, policy_path, task)
        logger.info("Browser inference ready: %s on %s, chunk %d", ref, runner.device, runner.chunk_size)
        await websocket.send_json({"type": "ready", **runner.spec})

        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            if message.get("text") is not None:
                if _parse_text(message["text"]).get("type") == "stop":
                    break
                continue
            seq, state, images = decode_observation(message.get("bytes") or b"", runner.cameras)
            started = time.perf_counter()
            actions = await asyncio.to_thread(runner.predict_chunk, state, images)
            await websocket.send_json(
                {
                    "type": "actions",
                    "seq": seq,
                    "actions": actions,
                    "inference_ms": (time.perf_counter() - started) * 1000,
                }
            )
    except WebSocketDisconnect:
        pass
    except BrowserInferenceError as e:
        await _send_error(websocket, str(e))
    except Exception as e:
        logger.exception("Browser inference failed")
        await _send_error(websocket, f"Inference failed on the server: {e}")
    finally:
        _session_lock.release()
        if runner is not None:
            await asyncio.to_thread(runner.close)


def _parse_text(text: str) -> dict[str, Any]:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise BrowserInferenceError("Text messages must be JSON.") from e
    return data if isinstance(data, dict) else {}


async def _send_error(websocket: WebSocket, message: str) -> None:
    with contextlib.suppress(Exception):
        await websocket.send_json({"type": "error", "message": message})
        await websocket.close()
