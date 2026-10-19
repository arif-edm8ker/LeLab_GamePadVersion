import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, Gamepad2, Loader2, Play, Square, Usb, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import UrdfViewer from "@/components/UrdfViewer";
import BrowserModeLayout from "@/components/browser/BrowserModeLayout";
import PortPicker from "@/components/browser/PortPicker";
import { loadCalibration } from "@/lib/robot/calibrationStore";
import { webSerialSupport } from "@/lib/robot/support";
import { BrowserTeleop, INITIAL_TELEOP_STATE, TeleopInput, TeleopState } from "@/lib/robot/teleopSession";

const ACTIVE_PHASES = new Set(["connecting", "running", "stopping"]);

const GAMEPAD_CONTROLS: [string, string][] = [
  ["Cross / A", "Start or pause arm motion"],
  ["Left stick", "Shoulder pan and lift"],
  ["Right stick", "Elbow (up/down) and wrist roll (left/right)"],
  ["D-pad up/down", "Wrist flex"],
  ["R2 / L2", "Close / open gripper"],
  ["Triangle / Y", "Return to the starting pose"],
  ["Circle / B", "Stop teleoperation"],
];

const BrowserTeleoperation = () => {
  const supported = webSerialSupport().ok;
  const [follower] = useState(() => loadCalibration("robot"));
  const [leader] = useState(() => loadCalibration("teleop"));

  const [input, setInput] = useState<TeleopInput>("gamepad");
  const [followerPort, setFollowerPort] = useState<SerialPort | null>(null);
  const [leaderPort, setLeaderPort] = useState<SerialPort | null>(null);
  const [state, setState] = useState<TeleopState>(INITIAL_TELEOP_STATE);
  const [joints, setJoints] = useState<Record<string, number> | null>(null);
  const sessionRef = useRef<BrowserTeleop | null>(null);

  const active = ACTIVE_PHASES.has(state.phase);
  const leaderMode = input === "leader";
  const canStart =
    supported &&
    !!follower &&
    !!followerPort &&
    (!leaderMode || (!!leader && !!leaderPort && leaderPort !== followerPort));

  const stop = useCallback(async () => {
    await sessionRef.current?.stop();
  }, []);

  // Release the arm however the page is left. A tab close can't wait for the
  // serial writes, so `pagehide` is best effort.
  useEffect(() => {
    const onPageHide = () => void sessionRef.current?.stop();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      void sessionRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);

  const start = () => {
    if (!followerPort || !follower) return;
    setJoints(null);
    const session = new BrowserTeleop({
      input,
      followerPort,
      followerCalibration: follower.calibration,
      leaderPort: leaderMode ? leaderPort ?? undefined : undefined,
      leaderCalibration: leaderMode ? leader?.calibration : undefined,
      onState: setState,
      onJoints: setJoints,
    });
    sessionRef.current = session;
    session.start();
  };

  if (!follower) {
    return (
      <BrowserModeLayout title="Teleoperate in your browser">
        <Alert className="bg-amber-900/40 border-amber-700 text-amber-100">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Calibrate the follower arm first (or import its calibration file) on the{" "}
            <Link to="/browser" className="underline">
              browser mode page
            </Link>
            .
          </AlertDescription>
        </Alert>
      </BrowserModeLayout>
    );
  }

  return (
    <BrowserModeLayout title="Teleoperate in your browser" onBack={stop}>
      <div className="flex flex-col lg:flex-row gap-6">
        <div className="flex-1 bg-black rounded-lg border border-slate-800 h-[50vh] lg:h-[75vh] overflow-hidden">
          <UrdfViewer liveJoints={joints} />
        </div>

        <div className="lg:w-96 space-y-6">
          <Card className="bg-slate-800/60 border-slate-700">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-slate-200">
                <Usb className="w-5 h-5 text-blue-400" />
                Setup
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-sm font-medium text-slate-300">Control with</Label>
                <Select value={input} onValueChange={(v) => setInput(v as TeleopInput)} disabled={active}>
                  <SelectTrigger className="bg-slate-700 border-slate-600 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-slate-700 text-white">
                    <SelectItem value="gamepad">Gamepad</SelectItem>
                    <SelectItem value="leader">Leader arm</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <PortPicker
                label="Follower port"
                port={followerPort}
                disabled={!supported || active}
                onPick={setFollowerPort}
              />
              {leaderMode &&
                (leader ? (
                  <PortPicker
                    label="Leader port"
                    port={leaderPort}
                    disabled={!supported || active}
                    onPick={setLeaderPort}
                  />
                ) : (
                  <p className="text-sm text-amber-200">
                    Calibrate the leader arm first on the{" "}
                    <Link to="/browser" className="underline">
                      browser mode page
                    </Link>
                    .
                  </p>
                ))}
              {leaderMode && leaderPort && leaderPort === followerPort && (
                <p className="text-sm text-red-300">The leader and follower must be different ports.</p>
              )}

              {!active ? (
                <Button
                  onClick={start}
                  disabled={!canStart}
                  className="w-full bg-green-600 hover:bg-green-700 rounded-full py-5"
                >
                  <Play className="w-4 h-4 mr-2" />
                  Start
                </Button>
              ) : (
                <Button
                  onClick={stop}
                  variant="destructive"
                  disabled={state.phase === "stopping"}
                  className="w-full rounded-full py-5"
                >
                  <Square className="w-4 h-4 mr-2" />
                  Stop
                </Button>
              )}
            </CardContent>
          </Card>

          <Card className="bg-slate-800/60 border-slate-700">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-slate-200">
                <Gamepad2 className="w-5 h-5 text-teal-400" />
                Status
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {state.phase === "idle" && <p className="text-slate-400">Not started.</p>}
              {(state.phase === "connecting" || state.phase === "stopping") && (
                <div className="flex items-center gap-2 text-yellow-200">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {state.message}
                </div>
              )}
              {state.phase === "running" && (
                <>
                  <p className="text-slate-200">{state.message}</p>
                  <p className="text-slate-400">
                    Control loop:{" "}
                    <span className="font-mono text-slate-200">
                      {state.loopHz === null ? "measuring..." : `${state.loopHz.toFixed(0)} Hz`}
                    </span>
                  </p>
                  {leaderMode ? null : state.gamepad?.connected ? (
                    <>
                      <p className={state.gamepad.running ? "text-green-300" : "text-amber-300"}>
                        {state.gamepad.name}: {state.gamepad.running ? "moving" : "holding (press Cross/A)"}
                      </p>
                      {!state.gamepad.standardMapping && (
                        <p className="text-amber-200">
                          This controller isn't mapped to the standard layout; sticks may drive the wrong joints.
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-amber-300">No controller seen yet: press any button on it.</p>
                  )}
                </>
              )}
              {state.phase === "stopped" && <p className="text-slate-300">{state.message}</p>}
              {state.phase === "error" && (
                <Alert className="bg-red-900/50 border-red-700 text-red-200">
                  <XCircle className="h-4 w-4" />
                  <AlertDescription>
                    <strong>Error:</strong> {state.error}
                  </AlertDescription>
                </Alert>
              )}

              {!leaderMode && (
                <div className="pt-2 border-t border-slate-700">
                  <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">Controls</div>
                  <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs">
                    {GAMEPAD_CONTROLS.map(([button, action]) => (
                      <div key={button} className="contents">
                        <dt className="text-slate-300 font-medium">{button}</dt>
                        <dd className="text-slate-400">{action}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </BrowserModeLayout>
  );
};

export default BrowserTeleoperation;
