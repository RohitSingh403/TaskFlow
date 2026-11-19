import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api } from "@/lib/api";
import { formatDuration, formatWhen } from "@/lib/format";
import type { Worker } from "@/lib/types";
import { useSession } from "@/stores/session";
import { HealthPill, JobStatusPill } from "@/components/status";
import { Card, EmptyState } from "@/components/ui";
import type { JobStatus } from "@/lib/types";

interface WorkerJob {
  jobId: string;
  name: string | null;
  queue: string | null;
  jobStatus: string | null;
  attemptNumber: number;
  status: string;
  startedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
}

export function WorkersPage() {
  const projectId = useSession((state) => state.projectId);
  const workers = useQuery({
    queryKey: ["workers", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api<Worker[]>(`/projects/${projectId}/workers`),
    refetchInterval: 5_000,
  });
  if (!projectId) return <EmptyState title="Choose a project" body="Workers appear after they attach to one of this project's queues." />;
  const list = workers.data?.data ?? [];
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-[28px] font-semibold tracking-tight">Workers</h1>
        <p className="text-[13px] text-muted">Health is derived from the heartbeat. A stored flag is not treated as proof that a process is alive.</p>
      </div>
      {list.length === 0 ? <EmptyState title="No workers have checked in" body="Start the worker with npm run dev:worker. It will attach to every queue that exists." /> : null}
      <div className="grid gap-3 lg:grid-cols-2">
        {list.map((worker) => (
          <Link key={worker.id} to={`/workers/${worker.id}`}>
            <Card className="p-4 hover:border-accent/50">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="mono text-[13px]">{worker.id}</div>
                  <div className="mt-1 text-[12px] text-muted">{worker.hostname} · pid {worker.pid}</div>
                </div>
                <HealthPill value={worker.health} />
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-2 text-[12px] text-muted">
                <div>Active <span className="text-ink">{worker.activeJobs}</span></div>
                <div>Concurrency <span className="text-ink">{worker.concurrency}</span></div>
                <div>Succeeded <span className="text-ink">{worker.jobsSucceeded}</span></div>
                <div>Failed <span className="text-ink">{worker.jobsFailed}</span></div>
                <div className="col-span-2">Last seen {formatWhen(worker.lastHeartbeatAt)}</div>
                <div className="col-span-2">Queues {worker.queues.map((queue) => queue.name).join(", ") || "—"}</div>
              </dl>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function WorkerDetailPage() {
  const { workerId = "" } = useParams();
  const projectId = useSession((state) => state.projectId);
  const worker = useQuery({
    queryKey: ["worker", projectId, workerId],
    enabled: Boolean(projectId && workerId),
    queryFn: () => api<Worker>(`/projects/${projectId}/workers/${workerId}`),
    refetchInterval: 5_000,
  });
  const jobs = useQuery({
    queryKey: ["worker-jobs", projectId, workerId],
    enabled: Boolean(projectId && workerId),
    queryFn: () => api<WorkerJob[]>(`/projects/${projectId}/workers/${workerId}/jobs`),
  });
  if (!worker.data) return <p className="text-[13px] text-muted">Loading worker…</p>;
  const data = worker.data.data;
  return (
    <div className="space-y-4">
      <Link to="/workers" className="text-[12px] text-muted">Back to workers</Link>
      <div className="flex items-center gap-3">
        <h1 className="mono text-2xl font-semibold">{data.id}</h1>
        <HealthPill value={data.health} />
      </div>
      <p className="text-[13px] text-muted">Started {formatWhen(data.startedAt)} · last heartbeat {formatWhen(data.lastHeartbeatAt)}</p>
      <Card className="overflow-hidden">
        <div className="px-4 py-3 font-semibold">Recent executions</div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-[13px]">
            <thead className="text-[11px] tracking-wide text-faint uppercase">
              <tr className="border-y border-line">{["Job", "Attempt", "Status", "Duration", "Error"].map((heading) => <th key={heading} className="px-4 py-2 font-medium">{heading}</th>)}</tr>
            </thead>
            <tbody>
              {(jobs.data?.data ?? []).map((job) => (
                <tr key={`${job.jobId}-${job.attemptNumber}`} className="border-b border-line/70">
                  <td className="px-4 py-2"><Link className="hover:underline" to={`/jobs/${job.jobId}`}>{job.name ?? job.jobId}</Link></td>
                  <td className="px-4 py-2">{job.attemptNumber}</td>
                  <td className="px-4 py-2">{job.jobStatus ? <JobStatusPill status={job.jobStatus as JobStatus} /> : job.status}</td>
                  <td className="px-4 py-2">{formatDuration(job.durationMs)}</td>
                  <td className="px-4 py-2 text-danger">{job.errorMessage ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
