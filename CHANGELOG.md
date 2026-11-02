# Changelog

All notable changes to LeLab GamePad Version are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [v1.01] - 2026-11-02

Changes since `v1.00`.

### Added

- **Choose where LeLab keeps its files from `.env`.** You can now set `HF_HOME`,
  `HF_LEROBOT_HOME` or `HF_LEROBOT_CALIBRATION` in the `.env` file, not only in your shell, to
  move calibration files, datasets and robot records somewhere else, such as another drive. See
  [`leLab-main/.env.example`](leLab-main/.env.example) for what each setting moves. A value set in
  your shell still wins over `.env`. Other keys in `.env`, such as `HF_TOKEN`, are still ignored.
  Changing a location doesn't move files you already have, so copy them to the new folder
  yourself. (`84c8c0c`)

### Fixed

- **Calibration files are found when `HF_LEROBOT_CALIBRATION` is set.** lerobot saves
  calibration to that folder, but LeLab kept looking in `HF_LEROBOT_HOME/calibration`, so
  calibrations saved there didn't appear in LeLab. LeLab now looks in the same folder lerobot
  saves to. Nothing changes if you don't set this variable. (`2422e1e`)
