import React from "react";
import { Usb } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { requestArmPort } from "@/lib/robot/support";

interface PortPickerProps {
  label: string;
  port: SerialPort | null;
  disabled: boolean;
  onPick: (port: SerialPort) => void;
}

/** Button that opens the browser's serial port chooser for an arm. */
const PortPicker: React.FC<PortPickerProps> = ({ label, port, disabled, onPick }) => {
  const { toast } = useToast();
  const pick = async () => {
    try {
      const picked = await requestArmPort();
      if (picked) onPick(picked);
    } catch (e) {
      toast({
        title: "Couldn't open the port chooser",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  };
  return (
    <div className="flex items-center gap-3">
      <Button variant="secondary" onClick={pick} disabled={disabled} className="shrink-0">
        <Usb className="w-4 h-4 mr-2" />
        {label}
      </Button>
      <span className={`text-sm ${port ? "text-green-300" : "text-slate-500"}`}>{port ? "Selected" : "Not selected"}</span>
    </div>
  );
};

export default PortPicker;
