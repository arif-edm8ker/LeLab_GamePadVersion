import React, { useEffect, useState } from "react";
import { AlertCircle, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useApi } from "@/contexts/ApiContext";
import { useToast } from "@/hooks/use-toast";
import type { StoredCalibration } from "@/lib/robot/calibrationStore";
import type { DeviceType } from "@/lib/robot/so101";

// Radix Select can't use "" as an item value.
const NO_ROBOT = "__none__";

type Load = { status: "loading" } | { status: "unreachable" } | { status: "ready"; robots: string[] };

interface SendToAppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  device: DeviceType;
  stored: StoredCalibration;
}

/**
 * Copy a browser-mode calibration into the installed LeLab app on this
 * computer (PUT /calibration-configs), optionally attaching it to one of its
 * robots. The app is only contacted once this dialog opens, so the hosted page
 * never triggers the browser's local-network permission prompt by itself.
 */
const SendToAppDialog: React.FC<SendToAppDialogProps> = ({ open, onOpenChange, device, stored }) => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const { toast } = useToast();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [robot, setRobot] = useState(NO_ROBOT);
  const [sending, setSending] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoad({ status: "loading" });
    setConfirmOverwrite(false);
    fetchWithHeaders(`${baseUrl}/robots`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { robots?: { name: string }[] }) => {
        if (!cancelled) setLoad({ status: "ready", robots: (data.robots ?? []).map((r) => r.name) });
      })
      .catch(() => {
        if (!cancelled) setLoad({ status: "unreachable" });
      });
    return () => {
      cancelled = true;
    };
  }, [open, baseUrl, fetchWithHeaders]);

  const send = async (overwrite: boolean) => {
    setSending(true);
    try {
      const query = new URLSearchParams();
      if (overwrite) query.set("overwrite", "true");
      if (robot !== NO_ROBOT) query.set("robot_name", robot);
      const res = await fetchWithHeaders(
        `${baseUrl}/calibration-configs/${device}/${encodeURIComponent(stored.name)}?${query}`,
        { method: "PUT", body: JSON.stringify(stored.calibration) }
      );
      const data = (await res.json()) as { success: boolean; exists?: boolean; message?: string };
      if (data.exists) {
        setConfirmOverwrite(true);
        return;
      }
      if (!data.success) throw new Error(data.message || "The app rejected the calibration.");
      toast({
        title: "Sent to the installed app",
        description:
          robot === NO_ROBOT ? `Saved as ${stored.name}.json.` : `Saved as ${stored.name}.json and attached to ${robot}.`,
      });
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "Couldn't send the calibration",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-gray-900 border-gray-700 text-gray-200 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-white">Send to the installed app</DialogTitle>
          <DialogDescription>
            Copies "{stored.name}" into LeLab running on this computer, so it can be used for recording and policies.
          </DialogDescription>
        </DialogHeader>

        {load.status === "loading" && (
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <Loader2 className="w-4 h-4 animate-spin" />
            Looking for the installed app...
          </div>
        )}

        {load.status === "unreachable" && (
          <div className="flex items-start gap-2 rounded-md border border-amber-700 bg-amber-900/30 p-3 text-sm text-amber-200">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <p>
              Couldn't reach the installed LeLab app. Start it on this computer (run <code>lelab-gamepad</code>), then
              reopen this dialog. If your browser asked to allow access to devices on your local network, allow it.
            </p>
          </div>
        )}

        {load.status === "ready" && (
          <div className="space-y-2">
            <Label className="text-sm text-gray-300">Use it for robot</Label>
            <Select value={robot} onValueChange={setRobot}>
              <SelectTrigger className="bg-gray-800 border-gray-700 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-gray-800 border-gray-700 text-white">
                <SelectItem value={NO_ROBOT}>Just save the file</SelectItem>
                {load.robots.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-gray-500">
              Attaching sets this robot's {device === "robot" ? "follower" : "leader"} calibration, as calibrating
              from its tile would.
            </p>
          </div>
        )}

        {confirmOverwrite && (
          <div className="flex items-start gap-2 rounded-md border border-amber-700 bg-amber-900/30 p-3 text-sm text-amber-200">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            The app already has a calibration named "{stored.name}". Replace it?
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="text-gray-300">
            Cancel
          </Button>
          <Button
            onClick={() => send(confirmOverwrite)}
            disabled={load.status !== "ready" || sending}
            className={confirmOverwrite ? "bg-amber-600 hover:bg-amber-700" : "bg-blue-600 hover:bg-blue-700"}
          >
            {sending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
            {confirmOverwrite ? "Replace" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default SendToAppDialog;
