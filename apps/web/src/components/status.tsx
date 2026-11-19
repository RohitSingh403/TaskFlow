import { AlertTriangle, Ban, Check, Clock, Loader2, Pause, Play, Radio, X } from "lucide-react";
import type { JobStatus } from "@/lib/types";

const jobStyles: Record<JobStatus, string> = {
  waiting: "bg-white/5 text-muted",
  delayed: "bg-warning/10 text-warning",
  active: "bg-info/10 text-info",
  completed: "bg-success/10 text-success",
  failed: "bg-danger/10 text-danger",
  cancelled: "bg-white/5 text-faint",
};

export function JobStatusPill({ status }: { status: JobStatus }) {
  const icon = {
    waiting: <Clock className="h-3 w-3" />,
    delayed: <Clock className="h-3 w-3" />,
    active: <Loader2 className="h-3 w-3 animate-spin" />,
    completed: <Check className="h-3 w-3" />,
    failed: <X className="h-3 w-3" />,
    cancelled: <Ban className="h-3 w-3" />,
  }[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium capitalize ${jobStyles[status]}`}>
      {icon}
      {status}
    </span>
  );
}

export function HealthPill({ value }: { value: "online" | "unhealthy" | "offline" | "running" | "paused" }) {
  const map = {
    online: { className: "bg-success/10 text-success", icon: <Radio className="h-3 w-3" />, label: "Online" },
    running: { className: "bg-success/10 text-success", icon: <Play className="h-3 w-3" />, label: "Running" },
    unhealthy: { className: "bg-warning/10 text-warning", icon: <AlertTriangle className="h-3 w-3" />, label: "Unhealthy" },
    offline: { className: "bg-white/5 text-faint", icon: <Radio className="h-3 w-3" />, label: "Offline" },
    paused: { className: "bg-warning/10 text-warning", icon: <Pause className="h-3 w-3" />, label: "Paused" },
  }[value];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium ${map.className}`}>
      {map.icon}
      {map.label}
    </span>
  );
}
