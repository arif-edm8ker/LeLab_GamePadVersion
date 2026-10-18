import React from "react";
import { CheckCircle } from "lucide-react";
import { isMotorRangeComplete } from "@/lib/calibrationTargets";
import type { MotorRange } from "@/lib/robot/calibrationSession";
import type { DeviceType } from "@/lib/robot/so101";

interface RangeBarsProps {
  deviceType: DeviceType;
  ranges: Record<string, MotorRange>;
}

/** Live per-joint range display while calibrating, same reading as the Calibration page's. */
const RangeBars: React.FC<RangeBarsProps> = ({ deviceType, ranges }) => (
  <div className="bg-slate-800 rounded-lg p-4 border border-slate-700 space-y-3">
    {Object.entries(ranges).map(([motor, range]) => {
      const total = range.max - range.min;
      const percent = total > 0 ? ((range.current - range.min) / total) * 100 : 50;
      const complete = isMotorRangeComplete(deviceType, motor, total);
      return (
        <div key={motor} className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-white font-semibold text-sm">{motor}</span>
              {complete && <CheckCircle className="w-4 h-4 text-green-400" aria-label="Range complete" />}
            </div>
            <span className="text-slate-300 text-xs font-mono">{range.current}</span>
          </div>
          <div className="w-full bg-slate-600 rounded-full h-3 relative">
            <div
              className={`absolute top-0 w-1 h-3 rounded-full transition-all duration-100 ${
                complete ? "bg-green-400" : "bg-yellow-400"
              }`}
              style={{ left: `${Math.max(0, Math.min(100, percent))}%`, transform: "translateX(-50%)" }}
            />
          </div>
          <div className="flex justify-between text-xs text-slate-400">
            <span>{range.min}</span>
            <span>{range.max}</span>
          </div>
        </div>
      );
    })}
  </div>
);

export default RangeBars;
