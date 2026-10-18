import { isHostedSpace } from "@/lib/isHostedSpace";

/** The LeLab backend on this machine, at LELAB_BACKEND_PORT (default 8000) as set when building. */
export const LOCAL_BACKEND_URL = `http://localhost:${__LELAB_BACKEND_PORT__}`;

/**
 * Default API base URL. The production bundle is served by the backend
 * itself, so the API is on the page's own origin whatever port the backend
 * was started on, without rebuilding. The Vite dev server and the hosted
 * Space are other origins, so they reach the backend on this machine.
 */
export const defaultApiBaseUrl = (): string =>
  import.meta.env.DEV || isHostedSpace() ? LOCAL_BACKEND_URL : window.location.origin;
