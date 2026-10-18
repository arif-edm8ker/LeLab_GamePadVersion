// Browser-mode calibration storage: one saved calibration per arm role, kept
// in localStorage, plus download/import of lerobot-compatible JSON files so a
// calibration can move between the browser and the installed app.

import { CalibrationFile } from "./normalization";
import { DeviceType, parseCalibrationFile, serializeCalibration } from "./so101";

export interface StoredCalibration {
  name: string;
  savedAt: number;
  calibration: CalibrationFile;
}

const storageKey = (device: DeviceType) => `lelab.browser.calibration.${device}`;

export function loadCalibration(device: DeviceType): StoredCalibration | null {
  try {
    const raw = localStorage.getItem(storageKey(device));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredCalibration>;
    return {
      name: typeof parsed.name === "string" && parsed.name ? parsed.name : defaultCalibrationName(device),
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
      calibration: parseCalibrationFile(parsed.calibration),
    };
  } catch {
    // Unavailable storage or a corrupted entry: treat as not calibrated.
    return null;
  }
}

/** Returns false when the browser refuses to store it (private mode, storage full). */
export function saveCalibration(device: DeviceType, name: string, calibration: CalibrationFile): boolean {
  const entry: StoredCalibration = { name, savedAt: Date.now(), calibration };
  try {
    localStorage.setItem(storageKey(device), JSON.stringify(entry));
    return true;
  } catch {
    return false;
  }
}

export function deleteCalibration(device: DeviceType): void {
  try {
    localStorage.removeItem(storageKey(device));
  } catch {
    /* nothing stored */
  }
}

export function defaultCalibrationName(device: DeviceType): string {
  return device === "robot" ? "my_follower" : "my_leader";
}

/** Save as `<name>.json`, the file name lerobot looks up by arm id. */
export function downloadCalibration(stored: Pick<StoredCalibration, "name" | "calibration">): void {
  const blob = new Blob([serializeCalibration(stored.calibration)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${stored.name}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Read a calibration JSON chosen by the user; the name comes from the file name. */
export async function readCalibrationFile(file: File): Promise<{ name: string; calibration: CalibrationFile }> {
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error(`${file.name} is not valid JSON.`);
  }
  return { name: file.name.replace(/\.json$/i, ""), calibration: parseCalibrationFile(data) };
}
