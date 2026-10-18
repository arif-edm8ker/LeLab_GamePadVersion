import React, { useEffect, useState } from "react";
import { AlertCircle, Gamepad2 } from "lucide-react";
import { pickGamepad } from "@/lib/robot/gamepadTeleop";

interface PadView {
  id: string;
  standard: boolean;
  axes: number[];
  l2: number;
  r2: number;
  pressed: number[];
}

const REFRESH_MS = 50;

// Standard-layout button names for the readout.
const BUTTON_NAMES: Record<number, string> = {
  0: "Cross/A",
  1: "Circle/B",
  2: "Square/X",
  3: "Triangle/Y",
  4: "L1",
  5: "R1",
  6: "L2",
  7: "R2",
  8: "Share",
  9: "Options",
  10: "L3",
  11: "R3",
  12: "D-pad up",
  13: "D-pad down",
  14: "D-pad left",
  15: "D-pad right",
  16: "Home",
};

function readPad(): PadView | null {
  const pad = pickGamepad(navigator.getGamepads ? navigator.getGamepads() : []);
  if (!pad) return null;
  return {
    id: pad.id,
    standard: pad.mapping === "standard",
    axes: pad.axes.slice(0, 4).map((a) => Math.round(a * 100) / 100),
    l2: pad.buttons[6]?.value ?? 0,
    r2: pad.buttons[7]?.value ?? 0,
    pressed: pad.buttons.flatMap((b, i) => (b.pressed ? [i] : [])),
  };
}

const Bar: React.FC<{ label: string; value: number; min?: number }> = ({ label, value, min = -1 }) => {
  const percent = ((value - min) / (1 - min)) * 100;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-slate-400">
        <span>{label}</span>
        <span className="font-mono">{value.toFixed(2)}</span>
      </div>
      <div className="h-2 bg-slate-700 rounded-full relative">
        <div
          className="absolute top-0 h-2 w-1.5 rounded-full bg-teal-400"
          style={{ left: `${Math.max(0, Math.min(100, percent))}%`, transform: "translateX(-50%)" }}
        />
      </div>
    </div>
  );
};

/** Live readout of the browser's view of the controller, to check it before driving the arm. */
const GamepadPanel: React.FC = () => {
  const [pad, setPad] = useState<PadView | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setPad(readPad()), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  if (!pad) {
    return (
      <div className="flex items-start gap-3 rounded-md border border-slate-700 bg-slate-900/50 p-4 text-sm text-slate-300">
        <Gamepad2 className="w-5 h-5 mt-0.5 text-slate-500 shrink-0" />
        <p>
          No controller seen yet. Connect it (USB, wireless dongle or Bluetooth), then{" "}
          <strong>press any button</strong>: browsers only reveal a controller after it is used on the page.
        </p>
      </div>
    );
  }

  const [lx, ly, rx, ry] = pad.axes;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-slate-200">
        <Gamepad2 className="w-4 h-4 text-green-400" />
        <span className="truncate">{pad.id}</span>
      </div>
      {!pad.standard && (
        <div className="flex items-start gap-2 rounded-md border border-amber-700 bg-amber-900/30 p-3 text-amber-200 text-sm">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          This browser doesn't map this controller to the standard layout, so sticks and buttons may drive the
          wrong joints. Try another browser or controller.
        </div>
      )}
      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
        <Bar label="Left stick X (shoulder pan)" value={lx ?? 0} />
        <Bar label="Left stick Y (shoulder lift)" value={ly ?? 0} />
        <Bar label="Right stick X (wrist roll)" value={rx ?? 0} />
        <Bar label="Right stick Y (elbow)" value={ry ?? 0} />
        <Bar label="L2 (open gripper)" value={pad.l2} min={0} />
        <Bar label="R2 (close gripper)" value={pad.r2} min={0} />
      </div>
      <div className="text-xs text-slate-400">
        Pressed:{" "}
        <span className="text-slate-200">
          {pad.pressed.length ? pad.pressed.map((i) => BUTTON_NAMES[i] ?? `#${i}`).join(", ") : "none"}
        </span>
      </div>
    </div>
  );
};

export default GamepadPanel;
