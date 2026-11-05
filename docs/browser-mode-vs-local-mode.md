# Browser mode and local mode

LeLab GamePad Version can drive an SO-101 arm in two ways:

- **Local mode** is the installed app. You install LeLab, run `lelab-gamepad`, and the LeLab
  server on your computer controls the arm through LeRobot. It has every feature.
- **Browser mode** runs in the web page itself. The page talks to the arm's motors over USB, so
  calibrating and teleoperating need nothing installed. On the landing page it's the
  **Try in your browser (no install)** button, and the pages live under `/browser`.

## At a glance

|  | Local mode | Browser mode |
| --- | --- | --- |
| How to open it | Run `lelab-gamepad`; it opens `http://localhost:8000` | Go to `/browser`, on the installed app or on the hosted page |
| What to install | Python, LeLab and LeRobot | Nothing for calibration and teleop; running a policy needs a LeLab server somewhere |
| What controls the arm | The LeLab server, in Python, through LeRobot | The web page, through the browser's Web Serial API |
| Where the arm plugs in | The computer running the LeLab server | The computer running the browser |
| Browser needed | Any modern browser | Chrome or Edge on a desktop; the page must be on HTTPS or `localhost` |
| Gamepad | Plugged into the server computer, read with pygame | Plugged into the browser's computer, read with the Gamepad API |
| Cameras | Read by the server with OpenCV; phone cameras need the HTTPS setup | Only used to run a policy: the browser's own cameras |
| Where calibrations are kept | JSON files on disk, shared with LeRobot (see below) | The browser's `localStorage`: one per arm role, per browser and per site address |
| 3D arm view | Joint positions streamed from the server over WebSocket | Joint positions computed in the page |

## What each mode can do

| Feature | Server mode | Browser mode |
| --- | --- | --- |
| Calibrate the follower or leader arm | Yes | Yes |
| Teleoperate with a leader arm | Yes | Yes |
| Teleoperate with a gamepad | Yes | Yes |
| Record datasets | Yes | No |
| Upload and edit datasets | Yes | No |
| Train policies (on this computer or Hugging Face Jobs) | Yes | No |
| Run a trained policy | Yes: the arm and cameras are on the server computer | Yes: the arm and cameras stay with the browser, and the policy runs on a LeLab server |
| Saved robots and serial ports | Yes | No: you pick the port each time |

Browser mode can't record or train. Those need LeRobot's dataset writer (video encoding, data
files, Hub uploads) and PyTorch, which only run in Python.

## Where calibration files go

**Local mode** writes LeRobot's calibration files:

- follower: `calibration/robots/so_follower/<name>.json`
- leader: `calibration/teleoperators/so_leader/<name>.json`

Both are under `~/.cache/huggingface/lerobot/` by default. `HF_HOME`, `HF_LEROBOT_HOME` or
`HF_LEROBOT_CALIBRATION` move them; these can be set in the shell or in `.env` (see
[`.env.example`](../leLab-main/.env.example)).

**Browser mode** keeps one calibration per arm role in the browser, under the `localStorage` keys
`lelab.browser.calibration.robot` (follower) and `lelab.browser.calibration.teleop` (leader). It
is lost if you clear the site's data, and a different browser or site address has its own copy.

**Moving a calibration between the modes**, from the browser mode home page:

- **Browser to local:**
  - **Send to installed app** saves it on the LeLab server (`PUT /calibration-configs/...`) and
    can attach it to a saved robot.
  - Or use **Download** and copy the file into the folder above.
- **Local to browser:** **Import file** loads a JSON file from that folder.

Both modes use the same file format, so a calibration made in either one works in the other and
with LeRobot's own tools.

## When browser mode contacts a LeLab server

Calibrating, teleoperating, importing and downloading never contact a server. A LeLab server is
only used for:

- **Running a policy.** Choosing a training job and checkpoint uses `GET /jobs` and
  `GET /jobs/{id}/checkpoints/...`. Pressing Start opens the `/ws/browser-inference` WebSocket:
  the page sends joint positions and camera frames, and the server answers with actions.
- **Send to installed app**, which uses `GET /robots` and `PUT /calibration-configs/...`.
- **Two background checks on every page**, `GET /hf-auth-status` and `GET /system/update-check`.
  The update check is skipped on the hosted page. If either fails, the page ignores it.

On the installed app the server is the page's own address. The hosted page looks for the LeLab
app at `http://localhost:8000`, or at whatever `LELAB_BACKEND_PORT` was set to when the page was
built.

## Things to know about browser mode

- **Teleop pauses while the tab is hidden.** The arm holds its last position, because browsers
  slow down timers in background tabs.
- **The LeLab server doesn't know about browser sessions,** so the installed app can't show or
  stop them.
- **Stopping releases the arm.** Stopping teleop turns off motor torque, so the arm goes limp.
  Support it first.

## For contributors

Browser mode is a TypeScript copy of LeLab's and LeRobot's Python, so a change on one side
usually needs the same change on the other:

| Browser mode (`leLab-main/frontend/src/lib/robot/`) | Python it copies |
| --- | --- |
| `calibrationSession.ts` | `lelab/calibrate.py` (`CalibrationManager`) |
| `teleopSession.ts` | `lelab/teleoperate.py` |
| `gamepadTeleop.ts` | `lelab/gamepad_teleop.py` |
| `so101.ts` | LeRobot's `SOFollower` / `SOLeader` |
| `feetechBus.ts`, `feetechProtocol.ts`, `normalization.ts` | LeRobot's `FeetechMotorsBus` and the Feetech SDK |

- **Browser-side inference has two halves:** `inferenceSession.ts` in the page and
  `lelab/browser_inference.py` on the server. The server half must stay in step with
  `lelab/rollout.py`; `tests/test_browser_inference.py` checks it against LeRobot.
- **The browser tests compare against Python output.** Their reference values come from the
  Python code; after changing either side, regenerate them with
  `frontend/scripts/gen_lerobot_fixtures.py`.
- **The pages are in separate folders:**
  - local mode: `frontend/src/pages/*.tsx`, which call the API in `lelab/server.py`;
  - browser mode: `frontend/src/pages/browser/` and `frontend/src/components/browser/`.

The arm-control part of browser mode is being moved into a separate npm package, `so-arm-web`;
see [plans/so-arm-web-package.md](../plans/so-arm-web-package.md).
