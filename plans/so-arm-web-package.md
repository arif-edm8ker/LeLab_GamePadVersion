# Extract browser-mode arm control into the `so-arm-web` npm package

Status as of 2026-11-02: steps 1–3 are done locally in `~/dev_dir/sl2/so-arm-web`. Nothing is
committed in the new repository, pushed or published, and LeLab itself is unchanged.

## Goal

Browser mode controls the SO-101 arm with TypeScript that runs in the page (Web Serial for the
motors, the Gamepad API for the controller). That code lives in
`leLab-main/frontend/src/lib/robot/` and doesn't depend on React or anything else in the app.
The goal is to publish it as an npm package other projects can use, and have LeLab use the
published package instead of its own copy.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Separate repository or a folder inside LeLab | Separate repository | The package gets its own README, releases, issues and CI. Inside LeLab it would have to live under `frontend/`, because the HF Space only receives that folder, and the Space's Docker build runs `npm ci` before the source is copied, which breaks npm workspaces. |
| Package name | `so-arm-web`, unscoped | Names the arm family and the platform. It was free on npm when checked. Names with `lerobot` or `lelab` were avoided: they're confusing next to `@lerobot/web`, the `lerobot` CLI and `@huggingface/lerobot`, and would look official. |
| Build our own or use an existing package | Our own | `@lerobot/web` (LeRobot.js, 0.5.0) covers SO-100 with keyboard and programmatic control only; its README lists leader arms and joysticks as future work. `@huggingface/lerobot` only reads datasets on the Hub. |
| What goes in the package | Arm control only | The inference client works only with LeLab's `/ws/browser-inference`, and the `localStorage` calibration slots are an app decision, so both stay in LeLab. |

## What moved and what stays

| Moved to `so-arm-web` (`src/`) | Stays in LeLab (`frontend/src/`) |
| --- | --- |
| `feetechProtocol`, `serialTransport`, `feetechBus`, `normalization`, `so101`, `support`, `webSerial.d.ts` | `lib/robot/calibrationStore.ts` |
| `calibrationSession`, `teleopSession`, `gamepadTeleop` | `lib/robot/inferenceSession.ts`, `inferenceProtocol.ts`, `cameraCapture.ts` and `inferenceSession.test.ts` |
| `calibrationTargets` (from `lib/calibrationTargets.ts`) | The React pages and `components/browser/*` |
| Tests for all of the above, `testing/fakeServos.ts`, `__fixtures__/lerobot_reference.json` | |
| `scripts/gen_lerobot_fixtures.py` | |

## Step 1: extract the files with their history

```bash
git clone --no-local --branch feat/browser-mode --single-branch \
  ~/dev_dir/sl2/LeLab_GamePadVersion ~/dev_dir/sl2/so-arm-web
cd ~/dev_dir/sl2/so-arm-web

git filter-repo \
  --path leLab-main/frontend/src/lib/robot/ \
  --path leLab-main/frontend/src/lib/calibrationTargets.ts \
  --path leLab-main/frontend/scripts/gen_lerobot_fixtures.py \
  --path-rename leLab-main/frontend/src/lib/robot/:src/ \
  --path-rename leLab-main/frontend/src/lib/calibrationTargets.ts:src/calibrationTargets.ts \
  --path-rename leLab-main/frontend/scripts/:scripts/

git filter-repo --force --invert-paths \
  --path src/calibrationStore.ts --path src/cameraCapture.ts --path src/inferenceProtocol.ts \
  --path src/inferenceSession.ts --path src/inferenceSession.test.ts

git branch -m feat/browser-mode main
```

Result:

- Three commits of history are kept with their original authors:
  - `b565fc8`: SaiJeevanPuchakayala, 2026-08-19, which added `calibrationTargets.ts`;
  - `a904bb5` and `8f3cedf`: Arif Rachman H, 2026-10-19.
- Every extracted file was compared with LeLab's copy and is byte-identical.
- `git filter-repo` removed the `origin` remote, so nothing can be pushed back to LeLab by accident.

## Step 2: turn it into a package

These changes are in the new repository's working tree and are not committed yet.

**Source changes**

- **Relative imports end in `.js`** (`from "./feetechBus.js"`) in all source and test files.
  Published ES modules need this so that Node, and TypeScript projects using `nodenext`
  resolution, can find the files. Vite and Vitest map `.js` to the `.ts` source.
- **`src/index.ts` defines the public API.** It re-exports every moved module; no names clash.
- **The Web Serial typings reach consumers.** `src/index.ts` and `src/testing/fakeServos.ts`
  start with `/// <reference path="…webSerial.d.ts" preserve="true" />`. Since TypeScript 5.5,
  the compiler drops such references from its output unless they're marked `preserve`.
- **`scripts/gen_lerobot_fixtures.py` takes the path to a LeLab checkout as an argument.** It
  imports `lelab.gamepad_teleop` to compare the gamepad mapping, and the new repository no longer
  sits inside LeLab. It also writes to the new location, `src/__fixtures__/`.

**New files**

| File | Contents |
| --- | --- |
| `package.json` | Name `so-arm-web`, version 0.1.0, Apache-2.0, ESM only, `sideEffects: false`. Two entry points: `so-arm-web` and `so-arm-web/testing` (simulated servos). Publishes `dist/` plus `src/webSerial.d.ts`, which the generated type files point to. Scripts: `build`, `typecheck`, `test`, and `prepublishOnly`, which runs all three before a publish. |
| `tsconfig.json` | `strict: true`, `lib: ES2022` (one test uses `Array.prototype.at`), type-checks everything in `src/` without emitting. |
| `tsconfig.build.json` | Emits JavaScript and type files to `dist/`, without the tests. |
| `README.md` | For developers using the package: requirements, calibration, teleop, gamepad controls, using the files with LeRobot, lower-level motor access, the simulated servos, development. Warns that `stop()` turns torque off so the arm goes limp. |
| `LICENSE` | Apache-2.0, copied from LeLab. |
| `.gitignore`, `package-lock.json` | The lockfile resolves only from `registry.npmjs.org`. |

`repository` and `homepage` are deliberately missing from `package.json` until the GitHub owner
is chosen.

## Step 3: verify

The new repository needs Node 20.19+ or 22.12+ for Vitest 5. The default `node` in this shell
is 18.19.1, so the checks below used nvm's 22.21.1.

| Check | Result |
| --- | --- |
| `npm test` | 7 files, 165 tests pass: LeLab's 173 minus the 8 inference tests that stay in LeLab. |
| `npm run typecheck` (strict) | Passes. |
| `npm run build` | `dist/` contains JavaScript and type files for every module, and no relative import lacks `.js`. |
| Fixture script against `leLab-main/` | Regenerates `lerobot_reference.json` with no differences. |
| `npm pack` contents | 28 files, 26.3 kB: `dist/`, `src/webSerial.d.ts`, README, LICENSE, `package.json`. |
| Tarball installed in a scratch project, `tsc` with `skipLibCheck: false` | Types pass with both `bundler` and `nodenext` resolution, for the main entry and for `so-arm-web/testing` on its own. A deliberate type error was caught, so the types are real rather than `any`. |
| Tarball loaded in Node | 54 exports load. A full calibration against the simulated servos runs `connecting → recording → saving → completed`, and the result survives `serializeCalibration` followed by `parseCalibrationFile`. |

## Remaining steps

### Before publishing (you)

1. **Commit the new repository.** Suggested split:
   - the `.js` import extensions;
   - the package setup (`package.json`, the tsconfigs, `src/index.ts`, the typings references,
     README, LICENSE, `.gitignore`, the lockfile);
   - the fixture script change.
2. **Choose the GitHub owner** (`arif-edm8ker` or `SustainableLivingLab`), create the repository,
   add `repository` and `homepage` to `package.json`, and push.
3. **Publish 0.1.0:** run `npm publish` in the new repository with Node 22. `prepublishOnly`
   runs the type-check, tests and build first.

### Step 5: switch LeLab to the package

1. **Add the dependency.** In `leLab-main/frontend`, run `npm install so-arm-web`. It's a normal
   registry dependency, so the Dockerfile's `npm ci`, the CI build and the lockfile registry
   guard all keep working.
2. **Delete the moved files** from `frontend/src/lib/robot/` and `frontend/src/lib/calibrationTargets.ts`.
3. **Point the imports at `so-arm-web`.**
   - In `components/browser/`: `SendToAppDialog`, `BrowserModeLayout`, `GamepadPanel`,
     `RangeBars`, `PortPicker`.
   - In `pages/browser/`: `BrowserHome`, `BrowserCalibration`, `BrowserTeleoperation`,
     `BrowserInference`.
   - `pages/Calibration.tsx`, which uses `calibrationTargets`.
   - The files that stay in `lib/robot/`: `calibrationStore`, `inferenceSession`,
     `inferenceProtocol`, `cameraCapture`.
4. **Keep the inference test working.** `inferenceSession.test.ts` uses the simulated servos and
   the reference fixtures:
   - import the servos from `so-arm-web/testing`;
   - keep a copy of `lerobot_reference.json` in LeLab for the values it reads;
   - remove `frontend/scripts/gen_lerobot_fixtures.py` from LeLab, or keep it only for that copy.
5. **Check the result:** `npm test`, `npm run build`, then calibrate, teleoperate and run a policy
   in browser mode with a real arm.
6. **Update `CLAUDE.md`** where it describes the browser robot layer.

## Risks and follow-ups

- **Changes become a two-step release.** Any fix to arm control has to be released in
  `so-arm-web` and then bumped in LeLab. The code is young (most of it dates from 2026-10-19), so
  expect several early releases.
- **Keeping the browser code in step with the Python now spans two repositories.** The gamepad
  mapping has to match `leLab-main/lelab/gamepad_teleop.py`, and the units have to match
  lerobot's. Rerun the fixture script after changing either.
- **SO-100 is untested.** It uses the same motors, and lerobot 0.6 drives both arms with the
  same class, so it should work. Test on a real SO-100 before advertising support. The
  calibration range targets would then need to become a per-arm table.
