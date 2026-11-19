import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Bar, BarChart, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "@/lib/api";
import { formatDuration, formatWhen } from "@/lib/format";
import type { AuditEntry, Job, LogEntry, Throughput } from "@/lib/types";
import { useSession } from "@/stores/session";
import { Card, EmptyState, SelectInput } from "@/components/ui";
import { JobTable } from "./dashboard";

export function LogsPage() {
  const projectId = useSession((state) => state.projectId);
  const [level, setLevel] = useState("");
  const [jobId, setJobId] = useState("");
  const [q, setQ] = useState("");
  const query = new URLSearchParams({ limit: "50" });
  if (level) query.set("level", level);
  if (jobId) query.set("jobId", jobId);
  if (q) query.set("q", q);
  const logs = useQuery({
    queryKey: ["logs", projectId, query.toString()],
    enabled: Boolean(projectId),
    queryFn: () => api<LogEntry[]>(`/projects/${projectId}/logs?${query.toString()}`),
    refetchInterval: 5_000,
  });
  if (!projectId) return <EmptyState title="Choose a project" body="Logs are scoped to a project." />;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-[28px] font-semibold tracking-tight">Logs</h1>
        <p className="text-[13px] text-muted">Execution logs omit payloads. Entries older than 14 days expire.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <SelectInput className="w-36" value={level} onChange={(event) => setLevel(event.target.value)} aria-label="Level">
          <option value="">All levels</option>
          {["info", "warn", "error"].map((item) => <option key={item}>{item}</option>)}
        </SelectInput>
        <input value={jobId} onChange={(event) => setJobId(event.target.value)} placeholder="Job id" aria-label="Job id" className="h-10 w-56 rounded-[10px] border border-line bg-bg px-3 text-[13px]" />
        <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Message" aria-label="Message" className="h-10 w-56 rounded-[10px] border border-line bg-bg px-3 text-[13px]" />
      </div>
      <Card className="overflow-hidden">
        {(logs.data?.data.length ?? 0) === 0 ? <p className="p-4 text-[13px] text-muted">No log entries match.</p> : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-[13px]">
            <tbody>
              {(logs.data?.data ?? []).map((log) => (
                <tr key={log.id} className="border-b border-line/70">
                  <td className="px-4 py-2 whitespace-nowrap text-faint">{formatWhen(log.timestamp)}</td>
                  <td className={`px-2 py-2 uppercase ${log.level === "error" ? "text-danger" : log.level === "warn" ? "text-warning" : "text-info"}`}>{log.level}</td>
                  <td className="px-2 py-2">{log.message}</td>
                  <td className="px-2 py-2">{log.jobId ? <Link className="mono text-[12px] hover:underline" to={`/jobs/${log.jobId}`}>{log.jobId}</Link> : "—"}</td>
                  <td className="px-4 py-2 text-muted">{formatDuration(log.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

export function AnalyticsPage() {
  const projectId = useSession((state) => state.projectId);
  const [range, setRange] = useState("24h");
  const throughput = useQuery({
    queryKey: ["throughput", projectId, range],
    enabled: Boolean(projectId),
    queryFn: () => api<Throughput>(`/projects/${projectId}/analytics/throughput?range=${range}`),
  });
  const latency = useQuery({
    queryKey: ["latency", projectId, range],
    enabled: Boolean(projectId),
    queryFn: () => api<{ summary: { p50: number | null; p95: number | null; p99: number | null }; points: { at: string; avgMs: number }[] }>(`/projects/${projectId}/analytics/latency?range=${range}`),
  });
  const failures = useQuery({
    queryKey: ["failures", projectId, range],
    enabled: Boolean(projectId),
    queryFn: () => api<{ name?: string; queue?: string; count: number }[]>(`/projects/${projectId}/analytics/failures?range=${range}`),
  });
  if (!projectId) return <EmptyState title="Choose a project" body="Analytics are calculated per project." />;
  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">Analytics</h1>
          <p className="text-[13px] text-muted">Latency percentiles use the latest 5,000 completed jobs in the window.</p>
        </div>
        <div className="flex gap-2">
          {(["24h", "7d", "30d"] as const).map((value) => (
            <button key={value} onClick={() => setRange(value)} className={`h-8 rounded-full px-3 text-[12px] ${range === value ? "bg-accent text-white" : "border border-line text-muted"}`}>{value}</button>
          ))}
        </div>
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <Card className="h-80 p-4">
          <h2 className="mb-3 font-semibold">Throughput</h2>
          <ResponsiveContainer width="100%" height="85%">
            <LineChart data={throughput.data?.data.points ?? []}>
              <XAxis dataKey="at" hide />
              <YAxis allowDecimals={false} stroke="#71717a" fontSize={11} width={32} />
              <Tooltip contentStyle={{ background: "#202024", border: "1px solid #2c2c32", borderRadius: 10 }} />
              <Line type="monotone" dataKey="completed" stroke="#22c55e" dot={false} />
              <Line type="monotone" dataKey="failed" stroke="#ef4444" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Card>
        <Card className="h-80 p-4">
          <h2 className="mb-1 font-semibold">Average latency</h2>
          <p className="mb-3 text-[12px] text-muted">p50 {formatDuration(latency.data?.data.summary.p50)} · p95 {formatDuration(latency.data?.data.summary.p95)} · p99 {formatDuration(latency.data?.data.summary.p99)}</p>
          <ResponsiveContainer width="100%" height="75%">
            <LineChart data={latency.data?.data.points ?? []}>
              <XAxis dataKey="at" hide />
              <YAxis stroke="#71717a" fontSize={11} width={40} />
              <Tooltip contentStyle={{ background: "#202024", border: "1px solid #2c2c32", borderRadius: 10 }} />
              <Line type="monotone" dataKey="avgMs" stroke="#8b5cf6" dot={false} name="Avg ms" />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      </div>
      <Card className="h-72 p-4">
        <h2 className="mb-3 font-semibold">Failing handlers</h2>
        {(failures.data?.data.length ?? 0) === 0 ? <p className="text-[13px] text-muted">No failures in this window.</p> : (
          <ResponsiveContainer width="100%" height="85%">
            <BarChart data={failures.data?.data ?? []}>
              <XAxis dataKey="name" stroke="#a1a1aa" fontSize={12} />
              <YAxis allowDecimals={false} stroke="#71717a" fontSize={11} width={32} />
              <Tooltip contentStyle={{ background: "#202024", border: "1px solid #2c2c32", borderRadius: 10 }} />
              <Bar dataKey="count" fill="#ef4444" radius={4} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </Card>
    </div>
  );
}

export function ActivityPage() {
  const projectId = useSession((state) => state.projectId);
  const jobs = useQuery({
    queryKey: ["jobs", projectId, "activity"],
    enabled: Boolean(projectId),
    queryFn: () => api<Job[]>(`/projects/${projectId}/jobs?limit=20`),
  });
  const audit = useQuery({
    queryKey: ["audit", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api<AuditEntry[]>(`/projects/${projectId}/audit`),
  });
  if (!projectId) return <EmptyState title="Choose a project" body="Activity is recorded per project." />;
  return (
    <div className="space-y-4">
      <h1 className="text-[28px] font-semibold tracking-tight">Activity</h1>
      <div className="grid gap-3 xl:grid-cols-[1.4fr_0.8fr]">
        <Card>
          <div className="px-4 py-3 font-semibold">Latest jobs</div>
          <JobTable jobs={jobs.data?.data ?? []} />
        </Card>
        <Card className="p-4">
          <h2 className="font-semibold">Administrative actions</h2>
          <ul className="mt-3 space-y-3">
            {(audit.data?.data ?? []).length === 0 ? <li className="text-[13px] text-muted">No administrative actions yet.</li> : null}
            {(audit.data?.data ?? []).map((entry) => (
              <li key={entry.id} className="border-b border-line/70 pb-2">
                <div className="text-[13px]">{entry.action}</div>
                <div className="text-[12px] text-muted">{entry.targetId} · {formatWhen(entry.createdAt)}</div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
