import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// Ports come from LELAB_* variables in the environment or in the .env next to
// pyproject.toml, the same file the lelab-gamepad launcher reads.
const ENV_DIR = path.resolve(__dirname, "..");

function portSetting(env: Record<string, string>, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const port = /^\d+$/.test(raw) ? Number(raw) : 0;
  if (port < 1 || port > 65535) {
    throw new Error(`${name} must be a port number between 1 and 65535, got "${raw}".`);
  }
  return port;
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ENV_DIR, "LELAB_");
  return {
    server: {
      host: "::",
      port: portSetting(env, "LELAB_FRONTEND_DEV_PORT", 8080),
    },
    plugins: [react(), mode === "development" && componentTagger()].filter(
      Boolean
    ),
    // Strip console.log / debug / info in production minification; keep
    // console.warn and console.error for observability of real problems.
    esbuild: {
      pure:
        mode === "production"
          ? ["console.log", "console.debug", "console.info"]
          : [],
    },
    preview: {
      port: portSetting(env, "LELAB_PREVIEW_PORT", 4173),
      allowedHosts: ["lerobot-lelab.hf.space"],
    },
    define: {
      // Backend port for pages not served by the backend itself (see lib/backendUrl.ts).
      __LELAB_BACKEND_PORT__: JSON.stringify(portSetting(env, "LELAB_BACKEND_PORT", 8000)),
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
