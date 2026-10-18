import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Activity, AlertCircle, CheckCircle, Download, Loader2, Play, Square, Usb, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { isMotorRangeComplete } from "@/lib/calibrationTargets";
import BrowserModeLayout from "@/components/browser/BrowserModeLayout";
import RangeBars from "@/components/browser/RangeBars";
import {
  BrowserCalibration as CalibrationSession,
  CalibrationState,
  DISCONTINUITY_ERROR_PREFIX,
  INITIAL_CALIBRATION_STATE,
} from "@/lib/robot/calibrationSession";
import {
  defaultCalibrationName,
  downloadCalibration,
  loadCalibration,
  saveCalibration,
} from "@/lib/robot/calibrationStore";
import { DeviceType } from "@/lib/robot/so101";
import { requestArmPort, webSerialSupport } from "@/lib/robot/support";

const DEMO_VIDEO =
  "https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/lerobot/calibrate_so101_2.mp4";

// Same characters LeLab accepts in dataset/robot names, so the file name works everywhere.
const VALID_NAME = /^[A-Za-z0-9._-]+$/;

const ACTIVE_PHASES = new Set(["connecting", "recording", "saving"]);

const describePort = (port: SerialPort) => {
  const { usbVendorId, usbProductId } = port.getInfo();
  const hex = (n?: number) => (n === undefined ? "????" : n.toString(16).padStart(4, "0"));
  return usbVendorId === undefined ? "Serial port selected" : `USB device ${hex(usbVendorId)}:${hex(usbProductId)}`;
};

const BrowserCalibration = () => {
  const [params, setParams] = useSearchParams();
  const device: DeviceType = params.get("device") === "teleop" ? "teleop" : "robot";
  const { toast } = useToast();
  const supported = webSerialSupport().ok;

  const [name, setName] = useState(() => loadCalibration(device)?.name ?? defaultCalibrationName(device));
  const [port, setPort] = useState<SerialPort | null>(null);
  const [state, setState] = useState<CalibrationState>(INITIAL_CALIBRATION_STATE);
  const sessionRef = useRef<CalibrationSession | null>(null);
  const savedResultRef = useRef<CalibrationState["result"]>(null);

  const active = ACTIVE_PHASES.has(state.phase);
  const nameValid = VALID_NAME.test(name);

  // Stop the session (releasing torque and the port) however the page is left.
  useEffect(() => () => void sessionRef.current?.stop(), []);

  // Persist a finished calibration once.
  useEffect(() => {
    if (state.phase !== "completed" || !state.result || savedResultRef.current === state.result) return;
    savedResultRef.current = state.result;
    const stored = saveCalibration(device, name, state.result);
    toast({
      title: "Calibration saved",
      description: stored
        ? "Saved in this browser. Download it to use it in the installed app."
        : "This browser wouldn't store it; download the file to keep it.",
      variant: stored ? undefined : "destructive",
    });
  }, [state.phase, state.result, device, name, toast]);

  const choosePort = async () => {
    try {
      const picked = await requestArmPort();
      if (picked) setPort(picked);
    } catch (e) {
      toast({
        title: "Couldn't open the port chooser",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  };

  const start = () => {
    if (!port) return;
    const session = new CalibrationSession(device, setState);
    sessionRef.current = session;
    session.start(port);
  };

  const stop = useCallback(async () => {
    await sessionRef.current?.stop();
  }, []);

  const changeDevice = (next: string) => {
    setParams({ device: next });
    setName(loadCalibration(next as DeviceType)?.name ?? defaultCalibrationName(next as DeviceType));
    setPort(null);
    setState(INITIAL_CALIBRATION_STATE);
  };

  const ranges = state.ranges ?? {};
  const allComplete =
    Object.keys(ranges).length > 0 &&
    Object.entries(ranges).every(([motor, r]) => isMotorRangeComplete(device, motor, r.max - r.min));

  return (
    <BrowserModeLayout title="Calibrate in your browser" onBack={stop}>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="bg-slate-800/60 border-slate-700">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-slate-200">
              <Usb className="w-5 h-5 text-blue-400" />
              Arm
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label className="text-sm font-medium text-slate-300">Which arm</Label>
              <Select value={device} onValueChange={changeDevice} disabled={active}>
                <SelectTrigger className="bg-slate-700 border-slate-600 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-slate-700 text-white">
                  <SelectItem value="robot">Follower arm</SelectItem>
                  <SelectItem value="teleop">Leader arm</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="calibration-name" className="text-sm font-medium text-slate-300">
                Calibration name
              </Label>
              <Input
                id="calibration-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={active}
                className="bg-slate-700 border-slate-600 text-white"
              />
              <p className={`text-xs ${nameValid ? "text-slate-500" : "text-red-300"}`}>
                {nameValid
                  ? `Saved as ${name}.json. Use the same name as the arm's id in the installed app.`
                  : "Use only letters, numbers, dots, dashes and underscores."}
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-sm font-medium text-slate-300">USB port</Label>
              <div className="flex items-center gap-3">
                <Button variant="secondary" onClick={choosePort} disabled={!supported || active}>
                  <Usb className="w-4 h-4 mr-2" />
                  {port ? "Change port" : "Choose port"}
                </Button>
                <span className="text-sm text-slate-400 truncate">
                  {port ? describePort(port) : "Pick the arm's USB serial device in the browser's list."}
                </span>
              </div>
            </div>

            <Alert className="bg-slate-900/50 border-slate-700 text-slate-300">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                Put every joint in the middle of its range before starting (see the demo). Torque is switched off
                during calibration, so hold the arm while it runs.
              </AlertDescription>
            </Alert>

            {!active ? (
              <Button
                onClick={start}
                disabled={!supported || !port || !nameValid}
                className="w-full bg-blue-600 hover:bg-blue-700 rounded-full py-6 text-lg"
              >
                <Play className="w-5 h-5 mr-2" />
                Start calibration
              </Button>
            ) : (
              <Button onClick={stop} variant="destructive" className="w-full rounded-full py-6 text-lg">
                <Square className="w-5 h-5 mr-2" />
                Cancel calibration
              </Button>
            )}
          </CardContent>
        </Card>

        <Card className="bg-slate-800/60 border-slate-700">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-slate-200">
              <Activity className="w-5 h-5 text-teal-400" />
              Status
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {state.phase === "idle" && (
              <p className="text-sm text-slate-400">{state.message || "Not started."}</p>
            )}

            {(state.phase === "connecting" || state.phase === "saving") && (
              <div className="flex items-center gap-2 text-sm text-yellow-200">
                <Loader2 className="w-4 h-4 animate-spin" />
                {state.message}
              </div>
            )}

            {state.phase === "recording" && state.ranges && (
              <>
                <RangeBars deviceType={device} ranges={state.ranges} />
                <div className="flex justify-center">
                  <Button
                    onClick={() => sessionRef.current?.complete()}
                    className={`px-8 py-3 rounded-full ${
                      allComplete ? "bg-green-600 hover:bg-green-700" : "bg-orange-500 hover:bg-orange-600"
                    }`}
                  >
                    {allComplete ? <CheckCircle className="w-4 h-4 mr-2" /> : <AlertCircle className="w-4 h-4 mr-2" />}
                    Save calibration
                  </Button>
                </div>
                <Alert className="bg-purple-900/50 border-purple-700 text-purple-200">
                  <Activity className="h-4 w-4" />
                  <AlertDescription>
                    <strong>Important:</strong> Move EACH joint through its full range. A check appears next to each
                    joint once its range is wide enough.
                  </AlertDescription>
                </Alert>
              </>
            )}

            {state.phase === "completed" && state.result && (
              <div className="space-y-3">
                <Alert className="bg-green-900/50 border-green-700 text-green-200">
                  <CheckCircle className="h-4 w-4" />
                  <AlertDescription>Calibration completed and saved in this browser.</AlertDescription>
                </Alert>
                {state.warnings.length > 0 && (
                  <Alert className="bg-amber-900/40 border-amber-700 text-amber-100">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      Some joints barely moved ({state.warnings.join("; ")}). Consider recalibrating with full
                      motion.
                    </AlertDescription>
                  </Alert>
                )}
                <Button
                  variant="secondary"
                  onClick={() => state.result && downloadCalibration({ name, calibration: state.result })}
                >
                  <Download className="w-4 h-4 mr-2" />
                  Download {name}.json
                </Button>
              </div>
            )}

            {state.phase === "error" && state.error && (
              <Alert className="bg-red-900/50 border-red-700 text-red-200">
                <XCircle className="h-4 w-4" />
                <AlertDescription>
                  {state.error.startsWith(DISCONTINUITY_ERROR_PREFIX) ? (
                    <>
                      <div className="font-semibold text-base mb-1">Motor discontinuity detected</div>
                      Make sure to start the calibration with the robot in a middle position — all joints in the
                      middle of their ranges. See the calibration demo below for the correct starting pose.
                    </>
                  ) : (
                    <>
                      <strong>Error:</strong> {state.error}
                    </>
                  )}
                </AlertDescription>
              </Alert>
            )}

            <div className="bg-slate-900/50 p-4 rounded-lg border border-slate-700">
              <h4 className="font-semibold mb-3 text-slate-200">Calibration demo:</h4>
              <video className="w-full h-auto rounded-md" controls preload="metadata" muted>
                <source src={DEMO_VIDEO} type="video/mp4" />
              </video>
            </div>
          </CardContent>
        </Card>
      </div>
    </BrowserModeLayout>
  );
};

export default BrowserCalibration;
