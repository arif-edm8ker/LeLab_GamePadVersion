import React from "react";
import { VideoOff } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCameraStream } from "@/hooks/useCameraStream";
import type { BrowserCamera } from "@/hooks/useBrowserCameras";

const Preview: React.FC<{ deviceId: string }> = ({ deviceId }) => {
  const { videoRef, hasError } = useCameraStream(deviceId, false);
  if (!deviceId || hasError) {
    return (
      <div className="w-32 h-24 bg-slate-900 rounded border border-slate-700 flex flex-col items-center justify-center">
        <VideoOff className="w-5 h-5 text-slate-500" />
        <span className="text-[10px] text-slate-500">No preview</span>
      </div>
    );
  }
  return (
    <video
      ref={videoRef}
      autoPlay
      muted
      playsInline
      className="w-32 h-24 object-cover rounded border border-slate-700 bg-black"
    />
  );
};

interface CameraPickerProps {
  /** The policy's name for this camera, e.g. "front". */
  name: string;
  width: number;
  height: number;
  cameras: BrowserCamera[];
  value: string;
  disabled: boolean;
  onChange: (deviceId: string) => void;
}

/** Bind one of the policy's cameras to a webcam on this computer, with a live preview. */
const CameraPicker: React.FC<CameraPickerProps> = ({ name, width, height, cameras, value, disabled, onChange }) => (
  <div className="flex items-center gap-3">
    <div className="flex-1 min-w-0 space-y-1">
      <Label className="text-sm text-slate-300">
        {name} <span className="text-slate-500">({width}×{height})</span>
      </Label>
      <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="bg-slate-700 border-slate-600 text-white">
          <SelectValue placeholder="Choose a camera" />
        </SelectTrigger>
        <SelectContent className="bg-slate-800 border-slate-700 text-white">
          {cameras.map((camera) => (
            <SelectItem key={camera.deviceId} value={camera.deviceId}>
              {camera.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
    <Preview deviceId={value} />
  </div>
);

export default CameraPicker;
