import React from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import Logo from "@/components/Logo";
import { webSerialSupport } from "@/lib/robot/support";

interface BrowserModeLayoutProps {
  title: string;
  /** Where the back arrow goes; defaults to the browser-mode home. */
  backTo?: string;
  /** Runs before navigating back (e.g. to stop an active session). */
  onBack?: () => void | Promise<void>;
  children: React.ReactNode;
}

/** Page frame for browser mode (no installed app): header plus a Web Serial support check. */
const BrowserModeLayout: React.FC<BrowserModeLayoutProps> = ({ title, backTo = "/browser", onBack, children }) => {
  const navigate = useNavigate();
  const support = webSerialSupport();

  const goBack = async () => {
    await onBack?.();
    navigate(backTo);
  };

  return (
    <div className="min-h-screen bg-slate-900 text-white p-4">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center gap-4 mb-6">
          <Button
            variant="ghost"
            size="icon"
            onClick={goBack}
            className="text-slate-400 hover:text-white hover:bg-slate-800"
            aria-label="Back"
          >
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="flex items-center gap-3 min-w-0">
            <Logo iconOnly />
            <h1 className="text-2xl sm:text-3xl font-bold truncate">{title}</h1>
          </div>
        </div>

        {!support.ok && (
          <Alert className="mb-6 bg-amber-900/40 border-amber-700 text-amber-100">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{support.reason}</AlertDescription>
          </Alert>
        )}

        {children}
      </div>
    </div>
  );
};

export default BrowserModeLayout;
