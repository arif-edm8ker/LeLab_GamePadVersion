// pm2 process file for running LeLab on a Linux server.
//
// One process runs both the backend and the frontend: the FastAPI backend
// also serves the built web app (frontend/dist, committed to the repo) on the
// same port. Don't add a separate frontend process: a page served from
// another origin sends its API calls there instead of to the backend.
//
// One-time setup, from this directory (leLab-main/), with Python 3.12 or 3.13:
//   python3.12 -m venv .venv
//   .venv/bin/pip install -e .
//   cp .env.example .env        # optional: change LELAB_BACKEND_PORT
//
// Run:
//   pm2 start ecosystem.config.js
//   pm2 logs lelab
//   pm2 save && pm2 startup     # optional: start again after a reboot
//
// After pulling new code: `pm2 restart lelab`. Frontend changes need
// `npm run build` in frontend/ first unless frontend/dist was committed with them.
//
// The backend listens on 127.0.0.1 only. To reach it from other machines, put
// an HTTPS reverse proxy (Caddy, nginx) with password protection in front of
// it: browsers only allow USB access (browser mode) on HTTPS pages, and the
// API has no login of its own.

module.exports = {
  apps: [
    {
      name: "lelab",
      // `python -m` from this directory runs the code in this checkout.
      script: ".venv/bin/python",
      args: "-m lelab.scripts.lelab --no-open",
      interpreter: "none",
      cwd: __dirname, // the launcher reads .env from here
      env: {
        // No display on a server; lets pygame start for the gamepad endpoints.
        SDL_VIDEODRIVER: "dummy",
      },
      // pm2's default (1.6 s) is shorter than the backend's graceful shutdown.
      kill_timeout: 5000,
    },
  ],
};
