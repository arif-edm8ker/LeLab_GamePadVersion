// Can this browser drive the arm directly? Web Serial exists only in
// Chromium-based desktop browsers, and only on secure origins (HTTPS or
// localhost).

export type BrowserSupport = { ok: true } | { ok: false; reason: string };

export function webSerialSupport(): BrowserSupport {
  if (typeof window === "undefined") return { ok: false, reason: "Not running in a browser." };
  if (!window.isSecureContext) {
    return {
      ok: false,
      reason: "This page must be opened over HTTPS (or on localhost) to use USB devices.",
    };
  }
  if (!navigator.serial) {
    return {
      ok: false,
      reason: "This browser can't talk to USB serial devices. Use Chrome or Edge on a desktop computer.",
    };
  }
  return { ok: true };
}

/** Ask the user to pick the arm's serial port. Resolves to null if they cancel the chooser. */
export async function requestArmPort(): Promise<SerialPort | null> {
  try {
    return (await navigator.serial?.requestPort()) ?? null;
  } catch (e) {
    // NotFoundError: the chooser was closed without picking a port.
    if (e instanceof DOMException && e.name === "NotFoundError") return null;
    throw e;
  }
}
