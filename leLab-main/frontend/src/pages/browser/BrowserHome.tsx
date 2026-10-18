import React, { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle, Circle, Download, Gamepad2, Info, Play, Send, Settings, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import BrowserModeLayout from "@/components/browser/BrowserModeLayout";
import GamepadPanel from "@/components/browser/GamepadPanel";
import SendToAppDialog from "@/components/browser/SendToAppDialog";
import {
  StoredCalibration,
  deleteCalibration,
  downloadCalibration,
  loadCalibration,
  readCalibrationFile,
  saveCalibration,
} from "@/lib/robot/calibrationStore";
import { DeviceType } from "@/lib/robot/so101";
import { webSerialSupport } from "@/lib/robot/support";

const ARM_LABELS: Record<DeviceType, { title: string; hint: string }> = {
  robot: { title: "Follower arm", hint: "The arm that moves. Required." },
  teleop: { title: "Leader arm", hint: "Only needed to teleoperate with a leader arm instead of a gamepad." },
};

const CalibrationCard: React.FC<{
  device: DeviceType;
  stored: StoredCalibration | null;
  onChange: () => void;
}> = ({ device, stored, onChange }) => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const { title, hint } = ARM_LABELS[device];
  const supported = webSerialSupport().ok;

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const { name, calibration } = await readCalibrationFile(file);
      if (!saveCalibration(device, name, calibration)) throw new Error("The browser refused to store it.");
      onChange();
      toast({ title: "Calibration imported", description: `${title}: ${name}` });
    } catch (err) {
      toast({
        title: "Couldn't import calibration",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    }
  };

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-4 space-y-3">
      <div className="flex items-start gap-2">
        {stored ? (
          <CheckCircle className="w-5 h-5 text-green-400 mt-0.5 shrink-0" />
        ) : (
          <Circle className="w-5 h-5 text-slate-500 mt-0.5 shrink-0" />
        )}
        <div className="min-w-0">
          <div className="font-medium text-slate-100">{title}</div>
          <div className="text-sm text-slate-400">
            {stored
              ? `Calibrated as "${stored.name}"${
                  stored.savedAt ? ` on ${new Date(stored.savedAt).toLocaleDateString()}` : ""
                }`
              : hint}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => navigate(`/browser/calibration?device=${device}`)}
          disabled={!supported}
          className="bg-blue-600 hover:bg-blue-700"
        >
          <Settings className="w-4 h-4 mr-1.5" />
          {stored ? "Recalibrate" : "Calibrate"}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => fileInput.current?.click()}>
          <Upload className="w-4 h-4 mr-1.5" />
          Import file
        </Button>
        {stored && (
          <>
            <Button size="sm" variant="secondary" onClick={() => downloadCalibration(stored)}>
              <Download className="w-4 h-4 mr-1.5" />
              Download
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setSendOpen(true)}>
              <Send className="w-4 h-4 mr-1.5" />
              Send to installed app
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-slate-400 hover:text-red-300 hover:bg-slate-800"
              onClick={() => {
                deleteCalibration(device);
                onChange();
              }}
              aria-label={`Remove ${title} calibration`}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </>
        )}
        <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={handleImport} />
      </div>
      {stored && <SendToAppDialog open={sendOpen} onOpenChange={setSendOpen} device={device} stored={stored} />}
    </div>
  );
};

const BrowserHome = () => {
  const navigate = useNavigate();
  const [follower, setFollower] = useState(() => loadCalibration("robot"));
  const [leader, setLeader] = useState(() => loadCalibration("teleop"));
  const supported = webSerialSupport().ok;

  return (
    <BrowserModeLayout title="Try LeLab in your browser" backTo="/">
      <Alert className="mb-6 bg-slate-800/60 border-slate-700 text-slate-200">
        <Info className="h-4 w-4" />
        <AlertDescription>
          Nothing to install: this page talks to the arm and controller directly over USB, in Chrome or Edge on a
          desktop computer. Calibration and teleoperation work here. Recording datasets, training and running
          policies need the installed LeLab app. Calibrations are kept in this browser; use "Send to installed
          app" to reuse one there.
        </AlertDescription>
      </Alert>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="bg-slate-800/60 border-slate-700">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-slate-200">
              <Settings className="w-5 h-5 text-blue-400" />
              1. Calibrate
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <CalibrationCard device="robot" stored={follower} onChange={() => setFollower(loadCalibration("robot"))} />
            <CalibrationCard device="teleop" stored={leader} onChange={() => setLeader(loadCalibration("teleop"))} />
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card className="bg-slate-800/60 border-slate-700">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-slate-200">
                <Play className="w-5 h-5 text-green-400" />
                2. Teleoperate
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-slate-400">
                Drive the follower arm with a gamepad or a leader arm, with a live 3D view.
              </p>
              <Button
                className="w-full bg-green-600 hover:bg-green-700 rounded-full py-5"
                disabled={!supported || !follower}
                onClick={() => navigate("/browser/teleoperation")}
              >
                <Play className="w-4 h-4 mr-2" />
                Start teleoperation
              </Button>
              {!follower && <p className="text-xs text-slate-500">Calibrate the follower arm first.</p>}
            </CardContent>
          </Card>

          <Card className="bg-slate-800/60 border-slate-700">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-slate-200">
                <Gamepad2 className="w-5 h-5 text-teal-400" />
                Test your controller
              </CardTitle>
            </CardHeader>
            <CardContent>
              <GamepadPanel />
            </CardContent>
          </Card>
        </div>
      </div>
    </BrowserModeLayout>
  );
};

export default BrowserHome;
