import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Activity, AlertCircle, Bot, Camera, Loader2, Play, Square, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import UrdfViewer from "@/components/UrdfViewer";
import BrowserModeLayout from "@/components/browser/BrowserModeLayout";
import CameraPicker from "@/components/browser/CameraPicker";
import PortPicker from "@/components/browser/PortPicker";
import { useApi } from "@/contexts/ApiContext";
import { useBrowserCameras } from "@/hooks/useBrowserCameras";
import { JobCheckpoint, PolicyConfigSummary, getCheckpointPolicyConfig, listJobCheckpoints } from "@/lib/checkpointsApi";
import { JobRecord, listJobs } from "@/lib/jobsApi";
import { loadCalibration } from "@/lib/robot/calibrationStore";
import { BrowserInference, INITIAL_INFERENCE_STATE, InferenceState } from "@/lib/robot/inferenceSession";
import { webSerialSupport } from "@/lib/robot/support";

const ACTIVE_PHASES = new Set(["connecting", "loading", "running", "returning"]);
const CAMERA_MAPPING_KEY = "lelab.browser.inferenceCameras";

function loadCameraMapping(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(CAMERA_MAPPING_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveCameraMapping(mapping: Record<string, string>): void {
  try {
    localStorage.setItem(CAMERA_MAPPING_KEY, JSON.stringify(mapping));
  } catch {
    /* only a convenience */
  }
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

const BrowserInferencePage = () => {
  const [params] = useSearchParams();
  const { baseUrl, wsBaseUrl, fetchWithHeaders } = useApi();
  const supported = webSerialSupport().ok;
  const [follower] = useState(() => loadCalibration("robot"));

  const [jobs, setJobs] = useState<JobRecord[] | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [jobId, setJobId] = useState(params.get("job") ?? "");
  const [checkpoints, setCheckpoints] = useState<JobCheckpoint[]>([]);
  const [step, setStep] = useState<number | null>(params.get("step") ? Number(params.get("step")) : null);
  const [policy, setPolicy] = useState<PolicyConfigSummary | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [task, setTask] = useState("");
  const [durationS, setDurationS] = useState(60);
  const [cameraDevices, setCameraDevices] = useState<Record<string, string>>(loadCameraMapping);
  const [port, setPort] = useState<SerialPort | null>(null);
  const [state, setState] = useState<InferenceState>(INITIAL_INFERENCE_STATE);
  const [joints, setJoints] = useState<Record<string, number> | null>(null);
  const sessionRef = useRef<BrowserInference | null>(null);

  const active = ACTIVE_PHASES.has(state.phase);
  const policyCameras = Object.entries(policy?.image_features ?? {});
  const { cameras, denied } = useBrowserCameras(policyCameras.length > 0);

  // Trained policies on the server: jobs with at least one checkpoint.
  useEffect(() => {
    listJobs(baseUrl, fetchWithHeaders, 50)
      .then((all) => {
        const usable = all.filter((j) => j.checkpoint_count > 0);
        setJobs(usable);
        setJobId((current) => current || usable[0]?.id || "");
      })
      .catch((e) => setServerError(errorMessage(e)));
  }, [baseUrl, fetchWithHeaders]);

  useEffect(() => {
    if (!jobId) return;
    setCheckpoints([]);
    listJobCheckpoints(baseUrl, fetchWithHeaders, jobId)
      .then((list) => {
        setCheckpoints(list);
        // Keep a step from the URL if it exists, otherwise use the latest.
        setStep((current) =>
          current !== null && list.some((c) => c.step === current) ? current : (list.at(-1)?.step ?? null)
        );
      })
      .catch((e) => setPolicyError(errorMessage(e)));
  }, [jobId, baseUrl, fetchWithHeaders]);

  useEffect(() => {
    if (!jobId || step === null) return;
    setPolicy(null);
    setPolicyError(null);
    getCheckpointPolicyConfig(baseUrl, fetchWithHeaders, jobId, step)
      .then(setPolicy)
      .catch((e) => setPolicyError(errorMessage(e)));
  }, [jobId, step, baseUrl, fetchWithHeaders]);

  const stop = useCallback(async () => {
    await sessionRef.current?.stop();
  }, []);

  // Release the arm however the page is left (best effort on tab close).
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

  const chooseCamera = (name: string, deviceId: string) => {
    const next = { ...cameraDevices, [name]: deviceId };
    setCameraDevices(next);
    saveCameraMapping(next);
  };

  const camerasReady = policyCameras.every(([name]) => cameras.some((c) => c.deviceId === cameraDevices[name]));
  const canStart =
    supported &&
    !!follower &&
    !!port &&
    !!policy &&
    !policy.browser_blocker &&
    step !== null &&
    camerasReady &&
    (!policy.requires_task || task.trim().length > 0);

  const start = () => {
    if (!canStart || !port || !follower || step === null) return;
    setJoints(null);
    const session = new BrowserInference({
      followerPort: port,
      followerCalibration: follower.calibration,
      socketUrl: `${wsBaseUrl}/ws/browser-inference`,
      jobId,
      step,
      task: task.trim(),
      durationS,
      cameraDevices: Object.fromEntries(policyCameras.map(([name]) => [name, cameraDevices[name]])),
      onState: setState,
      onJoints: setJoints,
    });
    sessionRef.current = session;
    session.start();
  };

  if (!follower) {
    return (
      <BrowserModeLayout title="Run a policy in your browser">
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

  const { stats, spec } = state;
  return (
    <BrowserModeLayout title="Run a policy in your browser" onBack={stop}>
      {serverError && (
        <Alert className="mb-6 bg-amber-900/40 border-amber-700 text-amber-100">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Couldn't reach the LeLab server ({serverError}). Running a policy needs one: the installed app on this
            computer, or a LeLab server you open this page from.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          <Card className="bg-slate-800/60 border-slate-700">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-slate-200">
                <Bot className="w-5 h-5 text-blue-400" />
                Policy
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-slate-400">
                The policy runs on the LeLab server; this page drives the arm and cameras plugged into this computer.
              </p>
              <div className="space-y-2">
                <Label className="text-sm text-slate-300">Trained model</Label>
                <Select value={jobId || undefined} onValueChange={(id) => { setJobId(id); setStep(null); }} disabled={active || !jobs?.length}>
                  <SelectTrigger className="bg-slate-700 border-slate-600 text-white">
                    <SelectValue placeholder={jobs && jobs.length === 0 ? "No trained models on the server yet" : "Choose a model"} />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-slate-700 text-white">
                    {(jobs ?? []).map((job) => (
                      <SelectItem key={job.id} value={job.id}>
                        {job.name} · {job.config.policy_type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-sm text-slate-300">Checkpoint</Label>
                <Select
                  value={step === null ? undefined : String(step)}
                  onValueChange={(v) => setStep(Number(v))}
                  disabled={active || checkpoints.length === 0}
                >
                  <SelectTrigger className="bg-slate-700 border-slate-600 text-white">
                    <SelectValue placeholder="Choose a checkpoint" />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-slate-700 text-white">
                    {checkpoints.map((c) => (
                      <SelectItem key={c.step} value={String(c.step)}>
                        Step {c.step.toLocaleString()} ({c.source})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {policyError && <p className="text-sm text-red-300">Couldn't read this checkpoint: {policyError}</p>}
              {policy?.browser_blocker && (
                <Alert className="bg-amber-900/40 border-amber-700 text-amber-100">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{policy.browser_blocker}</AlertDescription>
                </Alert>
              )}

              {policy?.requires_task && (
                <div className="space-y-2">
                  <Label htmlFor="task" className="text-sm text-slate-300">
                    Task
                  </Label>
                  <Input
                    id="task"
                    value={task}
                    onChange={(e) => setTask(e.target.value)}
                    disabled={active}
                    placeholder="e.g. Pick up the red cube"
                    className="bg-slate-700 border-slate-600 text-white"
                  />
                  <p className="text-xs text-slate-500">
                    This policy is language-conditioned ({policy.policy_type}).
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="duration" className="text-sm text-slate-300">
                  Max duration (seconds)
                </Label>
                <Input
                  id="duration"
                  type="number"
                  min={1}
                  value={durationS}
                  onChange={(e) => setDurationS(Math.max(1, Number(e.target.value) || 1))}
                  disabled={active}
                  className="bg-slate-700 border-slate-600 text-white"
                />
              </div>

              <PortPicker label="Follower port" port={port} disabled={!supported || active} onPick={setPort} />

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
                  disabled={state.phase === "returning"}
                  className="w-full rounded-full py-5"
                >
                  <Square className="w-4 h-4 mr-2" />
                  Stop
                </Button>
              )}
              <p className="text-xs text-slate-500">
                When it stops, the arm moves back to where it started, then torque is released.
              </p>
            </CardContent>
          </Card>

          {policyCameras.length > 0 && (
            <Card className="bg-slate-800/60 border-slate-700">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-slate-200">
                  <Camera className="w-5 h-5 text-teal-400" />
                  Cameras
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-slate-400">
                  Match each camera the policy was trained with to a camera on this computer, pointed the same way.
                </p>
                {denied && (
                  <p className="text-sm text-amber-200">
                    Camera access was blocked. Allow it in the browser's site settings, then reload.
                  </p>
                )}
                {policyCameras.map(([name, size]) => (
                  <CameraPicker
                    key={name}
                    name={name}
                    width={size.width}
                    height={size.height}
                    cameras={cameras}
                    value={cameraDevices[name] ?? ""}
                    disabled={active}
                    onChange={(deviceId) => chooseCamera(name, deviceId)}
                  />
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <div className="bg-black rounded-lg border border-slate-800 h-[45vh] overflow-hidden">
            <UrdfViewer liveJoints={joints} />
          </div>

          <Card className="bg-slate-800/60 border-slate-700">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-slate-200">
                <Activity className="w-5 h-5 text-teal-400" />
                Status
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {state.phase === "idle" && <p className="text-slate-400">Not started.</p>}
              {(state.phase === "connecting" || state.phase === "loading" || state.phase === "returning") && (
                <div className="flex items-center gap-2 text-yellow-200">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {state.message}
                </div>
              )}
              {state.phase === "running" && <p className="text-green-300">{state.message}</p>}
              {state.phase === "stopped" && <p className="text-slate-300">{state.message}</p>}
              {state.phase === "error" && (
                <Alert className="bg-red-900/50 border-red-700 text-red-200">
                  <XCircle className="h-4 w-4" />
                  <AlertDescription>
                    <strong>Error:</strong> {state.error}
                  </AlertDescription>
                </Alert>
              )}
              {spec && (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-slate-400">
                  <dt>Policy</dt>
                  <dd className="text-slate-200">
                    {spec.policy_type} on {spec.device}, {spec.chunk_size} actions per chunk
                  </dd>
                  <dt>Elapsed</dt>
                  <dd className="text-slate-200 font-mono">
                    {Math.floor(state.elapsedS)} / {durationS} s
                  </dd>
                  <dt>Inference</dt>
                  <dd className="text-slate-200 font-mono">
                    {stats.inferenceMs === null ? "–" : `${stats.inferenceMs.toFixed(0)} ms`}
                  </dd>
                  <dt>Round trip</dt>
                  <dd className="text-slate-200 font-mono">
                    {stats.roundTripMs === null ? "–" : `${stats.roundTripMs.toFixed(0)} ms`}
                  </dd>
                  <dt>Control loop</dt>
                  <dd className="text-slate-200 font-mono">
                    {stats.loopHz === null ? "–" : `${stats.loopHz.toFixed(0)} Hz (target ${spec.fps})`}
                  </dd>
                </dl>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </BrowserModeLayout>
  );
};

export default BrowserInferencePage;
