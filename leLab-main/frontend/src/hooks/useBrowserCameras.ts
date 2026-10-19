import { useCallback, useEffect, useState } from "react";

export interface BrowserCamera {
  deviceId: string;
  label: string;
}

/**
 * This browser's webcams. Asks for camera permission first so the labels
 * are readable, and refreshes when cameras are plugged in or removed.
 */
export function useBrowserCameras(enabled: boolean) {
  const [cameras, setCameras] = useState<BrowserCamera[]>([]);
  const [denied, setDenied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true });
      probe.getTracks().forEach((t) => t.stop());
      setDenied(false);
    } catch {
      setDenied(true);
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    setCameras(
      devices
        .filter((d) => d.kind === "videoinput")
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }))
    );
  }, []);

  useEffect(() => {
    if (!enabled || !navigator.mediaDevices) return;
    refresh();
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refresh);
  }, [enabled, refresh]);

  return { cameras, denied };
}
