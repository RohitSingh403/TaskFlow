import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "@/lib/api";
import { formatDuration, formatNumber, formatPercent, formatWhen } from "@/lib/format";
import type { AlertEvent, Job, Overview, Project, Throughput } from "@/lib/types";
import { useSession, useUi } from "@/stores/session";
import { HealthPill, JobStatusPill } from "@/components/status";
import { Button, Card, EmptyState, Field, SelectInput, Skeleton, TextInput } from "@/components/ui";

export function DashboardPage() {
  const projectId = useSession((state) => state.projectId);
  const openSubmit = useUi((state) => state.openSubmit);
  const [range, setRange] = useState("24h");
  const overview = useQuery({
    queryKey: ["overview", projectId, range],
    enabled: Boolean(projectId),
    queryFn: () => api<Overview>(`/projects/${projectId}/analytics/overview?range=${range}`),
    refetchInterval: 15_000,
  });
  const throughput = useQuery({
    queryKey: ["throughput", projectId, range],
    enabled: Boolean(projectId),
    queryFn: () => api<Throughput>(`/projects/${projectId}/analytics/throughput?range=${range}`),
    refetchInterval: 15_000,
  });
  const openAlerts = useQuery({
    queryKey: ["alerts", projectId, "open"],
    enabled: Boolean(projectId),
    queryFn: () => api<AlertEvent[]>(`/projects/${projectId}/alerts?status=open&limit=3`),
    refetchInterval: 15_000,
  });
  const jobs = useQuery({
    queryKey: ["jobs", projectId, "recent"],
    enabled: Boolean(projectId),
    queryFn: () => api<Job[]>(`/projects/${projectId}/jobs?limit=8`),
  });

  if (!projectId) return <CreateProject />;
  const data = overview.data?.data;
  if (overview.isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-24" />)}
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }
  if (overview.isError) return <EmptyState title="Dashboard unavailable" body="The summary request failed. Refresh the page once Redis and MongoDB are reachable." />;

  const noWorkers = data.workers.online === 0;
  const failing = data.totals.failureRate >= 0.2 && data.totals.failed + data.totals.completed >= 3;
  const metrics = [
    ["Submitted", formatNumber(data.totals.submitted)],
    ["Completed", formatNumber(data.totals.completed)],
    ["Failed", formatNumber(data.totals.failed)],
    ["Live waiting", formatNumber(data.live.waiting + data.live.delayed)],
    ["Workers online", `${data.workers.online}/${data.workers.total}`],
    ["Avg duration", formatDuration(data.latency.avg)],
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">Dashboard</h1>
          <p className="text-[13px] text-muted">Queue backlog and worker health come from Redis. Duration comes from completed job records.</p>
        </div>
        <div className="flex items-center gap-2">
          {(["24h", "7d", "30d"] as const).map((value) => (
            <button key={value} onClick={() => setRange(value)} className={`h-8 rounded-full px-3 text-[12px] ${range === value ? "bg-accent text-white" : "border border-line text-muted"}`}>
              {value}
            </button>
          ))}
        </div>
      </div>
      {noWorkers ? (
        <div className="rounded-[12px] border border-warning/40 bg-warning/10 px-4 py-3 text-[13px] text-warning">
          No worker is online for this project. Jobs will stay waiting until you start the worker process.
        </div>
      ) : null}
      {failing ? (
        <div className="rounded-[12px] border border-danger/40 bg-danger/10 px-4 py-3 text-[13px] text-danger">
          Failure rate is {formatPercent(data.totals.failureRate)} in this window. Inspect the failed jobs before adding more load.
        </div>
      ) : null}
      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        {metrics.map(([label, value]) => (
          <Card key={label} className="px-4 py-3">
            <div className="text-[12px] text-muted">{label}</div>
            <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
          </Card>
        ))}
      </div>
      <div className="grid gap-3 xl:grid-cols-[1.6fr_0.8fr]">
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold">Jobs submitted</h2>
            <span className="text-[12px] text-faint">p50 {formatDuration(data.latency.p50)} · p95 {formatDuration(data.latency.p95)} · p99 {formatDuration(data.latency.p99)}</span>
          </div>
          <div className="h-64">
            {(throughput.data?.data.points.length ?? 0) === 0 ? (
              <div className="grid h-full place-items-center text-[13px] text-muted">No jobs in this range yet.</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={throughput.data?.data.points ?? []}>
                  <XAxis dataKey="at" tickFormatter={(value) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} stroke="#71717a" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis allowDecimals={false} stroke="#71717a" fontSize={11} tickLine={false} axisLine={false} width={32} />
                  <Tooltip contentStyle={{ background: "#202024", border: "1px solid #2c2c32", borderRadius: 10, fontSize: 12 }} />
                  <Area type="monotone" dataKey="completed" stroke="#22c55e" fill="#22c55e33" name="Completed" />
                  <Area type="monotone" dataKey="failed" stroke="#ef4444" fill="#ef444433" name="Failed" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>
        <Card className="p-4">
          <h2 className="text-base font-semibold">Queue health</h2>
          <div className="mt-3 space-y-2">
            {data.queues.map((queue) => (
              <Link key={queue.id} to={`/queues/${queue.id}`} className="flex items-center justify-between rounded-[10px] border border-line px-3 py-2 hover:bg-white/5">
                <div>
                  <div className="text-[13px] font-medium">{queue.name}</div>
                  <div className="text-[12px] text-muted">{queue.waiting} waiting · {queue.active} active · {queue.failed} failed</div>
                </div>
                <HealthPill value={queue.status === "paused" ? "paused" : "running"} />
              </Link>
            ))}
          </div>
        </Card>
      </div>
      <div className="grid gap-3 xl:grid-cols-[1.5fr_0.7fr]">
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3">
            <h2 className="text-base font-semibold">Recent jobs</h2>
            <Link to="/jobs" className="text-[12px] text-muted hover:text-ink">View all</Link>
          </div>
          <JobTable jobs={jobs.data?.data ?? []} />
        </Card>
        <Card className="p-4">
          <h2 className="text-base font-semibold">Needs attention</h2>
          <div className="mt-3 space-y-3">
            {(openAlerts.data?.data.length ?? 0) > 0 ? (
              <div className="space-y-2">
                {openAlerts.data?.data.map((alert) => (
                  <Link key={alert.id} to="/alerts" className="block rounded-[10px] border border-warning/40 px-3 py-2 hover:bg-white/5">
                    <div className="text-[13px] font-medium">{alert.title}</div>
                    <p className="mt-1 line-clamp-2 text-[12px] text-muted">{alert.message}</p>
                  </Link>
                ))}
              </div>
            ) : null}
            {data.recentFailures.length === 0 ? <p className="text-[13px] text-muted">No failed jobs in the latest records.</p> : null}
            {data.recentFailures.map((failure) => (
              <Link key={failure.id} to={`/jobs/${failure.id}`} className="block rounded-[10px] border border-line px-3 py-2 hover:bg-white/5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium">{failure.name}</span>
                  <span className="mono text-[11px] text-faint">{failure.attempts}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-[12px] text-danger">{failure.message}</p>
              </Link>
            ))}
            <div className="border-t border-line pt-3">
              <h3 className="text-[12px] tracking-wide text-faint uppercase">Workers</h3>
              <div className="mt-2 space-y-2">
                {data.workers.items.length === 0 ? <p className="text-[13px] text-muted">None have reported a heartbeat.</p> : null}
                {data.workers.items.map((worker) => (
                  <div key={worker.id} className="flex items-center justify-between text-[13px]">
                    <span className="mono text-[12px]">{worker.id}</span>
                    <HealthPill value={worker.health} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Card>
      </div>
      <div className="flex justify-end">
        <Button onClick={openSubmit}>Submit job</Button>
      </div>
    </div>
  );
}

export function JobTable({ jobs, action }: { jobs: Job[]; action?: (job: Job) => ReactNode }) {
  if (jobs.length === 0) return <p className="px-4 py-6 text-[13px] text-muted">No jobs match this view.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-[13px]">
        <thead className="text-[11px] tracking-wide text-faint uppercase">
          <tr className="border-y border-line">
            {["Job", "Name", "Queue", "Status", "Attempts", "Duration", "Created"].map((heading) => (
              <th key={heading} className="px-4 py-2 font-medium">{heading}</th>
            ))}
            {action ? <th className="px-4 py-2 font-medium" /> : null}
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id} className="border-b border-line/70 hover:bg-white/[0.03]">
              <td className="px-4 py-2"><Link className="mono text-[12px] text-ink hover:underline" to={`/jobs/${job.id}`}>{job.id}</Link></td>
              <td className="px-4 py-2">{job.name}</td>
              <td className="px-4 py-2 text-muted">{job.queue}</td>
              <td className="px-4 py-2"><JobStatusPill status={job.status} /></td>
              <td className="px-4 py-2 text-muted">{job.attemptsMade}/{job.maxAttempts}</td>
              <td className="px-4 py-2 text-muted">{formatDuration(job.durationMs)}</td>
              <td className="px-4 py-2 text-muted">{formatWhen(job.createdAt)}</td>
              {action ? <td className="px-4 py-2 text-right">{action(job)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CreateProject() {
  const setProjectId = useSession((state) => state.setProjectId);
  const client = useQueryClient();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <div className="mx-auto max-w-lg">
      <h1 className="text-[28px] font-semibold tracking-tight">Create a project</h1>
      <p className="mt-2 text-[13px] text-muted">A project owns queues, jobs, and API keys. Development projects can simulate handler failures. Production projects cannot.</p>
      <form
        className="mt-6 space-y-3"
        onSubmit={async (event) => {
          event.preventDefault();
          setPending(true);
          setError("");
          const form = new FormData(event.currentTarget);
          try {
            const created = await api<Project>("/projects", {
              method: "POST",
              body: JSON.stringify({
                name: String(form.get("name") ?? ""),
                description: String(form.get("description") ?? ""),
                environment: String(form.get("environment") ?? "development"),
              }),
            });
            client.setQueryData(["projects"], (current: { data: Project[]; meta: object } | undefined) => ({
              data: [created.data, ...(current?.data ?? []).filter((project) => project.id !== created.data.id)],
              meta: current?.meta ?? {},
            }));
            setProjectId(created.data.id);
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Could not create the project");
          } finally {
            setPending(false);
          }
        }}
      >
        <Field label="Name">
          <TextInput name="name" required minLength={2} placeholder="Checkout" />
        </Field>
        <Field label="Description">
          <TextInput name="description" placeholder="Order side effects" />
        </Field>
        <Field label="Environment">
          <SelectInput name="environment" defaultValue="development">
            <option value="development">Development</option>
            <option value="production">Production</option>
          </SelectInput>
        </Field>
        {error ? <p className="text-[13px] text-danger">{error}</p> : null}
        <Button type="submit" loading={pending}>Create project</Button>
      </form>
    </div>
  );
}
