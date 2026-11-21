import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError, api } from "@/lib/api";
import { formatDuration, formatWhen, pretty } from "@/lib/format";
import type { Attempt, Job, Queue } from "@/lib/types";
import { useSession, useUi } from "@/stores/session";
import { JobTable } from "./dashboard";
import { JobStatusPill } from "@/components/status";
import { Button, Card, EmptyState, SelectInput, TextInput } from "@/components/ui";

export function JobsPage() {
  const projectId = useSession((state) => state.projectId);
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const page = Number(params.get("page") ?? "1");
  const status = params.get("status") ?? "";
  const queue = params.get("queue") ?? "";
  const q = params.get("q") ?? "";
  const schedule = params.get("schedule") ?? "";
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const query = new URLSearchParams({ page: String(page), limit: "20" });
  if (status) query.set("status", status);
  if (queue) query.set("queue", queue);
  if (q) query.set("q", q);
  if (schedule) query.set("schedule", schedule);
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  const jobs = useQuery({
    queryKey: ["jobs", projectId, query.toString()],
    enabled: Boolean(projectId),
    queryFn: () => api<Job[]>(`/projects/${projectId}/jobs?${query.toString()}`),
  });
  const queues = useQuery({
    queryKey: ["queues", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api<Queue[]>(`/projects/${projectId}/queues`),
  });
  const cancelQueued = useMutation({
    mutationFn: () => api<{ cancelled: number; skipped: number }>(`/projects/${projectId}/jobs/cancel-queued`, {
      method: "POST",
      body: JSON.stringify(queue ? { queue, limit: 20 } : { limit: 20 }),
    }),
    onSuccess: (result) => {
      const count = result.data.cancelled;
      toast(count === 0 ? "warning" : "success", count === 1 ? "Cancelled 1 queued job" : `Cancelled ${count} queued jobs`);
      void client.invalidateQueries({ queryKey: ["jobs", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not cancel queued jobs"),
  });
  if (!projectId) return <EmptyState title="Choose a project" body="Create a project before listing jobs." />;
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    setParams(next);
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">Jobs</h1>
          <p className="text-[13px] text-muted">Application records mirror BullMQ events. From and to limit the list to jobs created in that window. Run now moves a delayed job onto the queue. Reschedule sets a new delay, and Update priority changes the queue order, while a job is waiting or delayed. Cancel queued removes waiting and delayed jobs. Active jobs stay.</p>
        </div>
        <Button variant="secondary" loading={cancelQueued.isPending} onClick={() => cancelQueued.mutate()}>Cancel queued</Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <SelectInput className="w-40" value={status} onChange={(event) => update("status", event.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          {["waiting", "delayed", "active", "completed", "failed", "cancelled"].map((item) => <option key={item} value={item}>{item}</option>)}
        </SelectInput>
        <SelectInput className="w-44" value={queue} onChange={(event) => update("queue", event.target.value)} aria-label="Queue">
          <option value="">All queues</option>
          {(queues.data?.data ?? []).map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}
        </SelectInput>
        <input
          defaultValue={q}
          aria-label="Search"
          placeholder="Job id or name"
          className="h-10 w-56 rounded-[10px] border border-line bg-bg px-3 text-[13px]"
          onKeyDown={(event) => {
            if (event.key === "Enter") update("q", event.currentTarget.value);
          }}
        />
        <label className="flex h-10 items-center gap-2 rounded-[10px] border border-line bg-bg px-3 text-[13px] text-muted">
          From
          <input
            type="datetime-local"
            aria-label="Created from"
            value={isoToLocalInput(from)}
            onChange={(event) => update("from", localInputToIso(event.target.value))}
            className="bg-transparent text-ink outline-none"
          />
        </label>
        <label className="flex h-10 items-center gap-2 rounded-[10px] border border-line bg-bg px-3 text-[13px] text-muted">
          To
          <input
            type="datetime-local"
            aria-label="Created to"
            value={isoToLocalInput(to)}
            onChange={(event) => update("to", localInputToIso(event.target.value))}
            className="bg-transparent text-ink outline-none"
          />
        </label>
        <Button variant="secondary" size="sm" onClick={() => applyCreatedWindow(params, setParams, 24)}>Last 24 hours</Button>
        <Button variant="secondary" size="sm" onClick={() => applyCreatedWindow(params, setParams, 24 * 7)}>Last 7 days</Button>
        <Button variant="secondary" size="sm" onClick={() => applyCreatedWindow(params, setParams, null)}>All time</Button>
      </div>
      <Card>
        {jobs.isLoading ? <p className="p-4 text-[13px] text-muted">Loading jobs…</p> : <JobTable jobs={jobs.data?.data ?? []} />}
      </Card>
      <div className="flex items-center justify-between text-[13px] text-muted">
        <span>{jobs.data?.meta.total ?? 0} jobs</span>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => update("page", String(page - 1))}>Previous</Button>
          <Button variant="secondary" size="sm" disabled={page >= (jobs.data?.meta.totalPages ?? 1)} onClick={() => update("page", String(page + 1))}>Next</Button>
        </div>
      </div>
    </div>
  );
}

export function JobDetailPage() {
  const { jobId = "" } = useParams();
  const navigate = useNavigate();
  const projectId = useSession((state) => state.projectId);
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const job = useQuery({
    queryKey: ["job", projectId, jobId],
    enabled: Boolean(projectId && jobId),
    queryFn: () => api<Job>(`/projects/${projectId}/jobs/${jobId}`),
  });
  const attempts = useQuery({
    queryKey: ["attempts", projectId, jobId],
    enabled: Boolean(projectId && jobId),
    queryFn: () => api<Attempt[]>(`/projects/${projectId}/jobs/${jobId}/attempts`),
  });
  const action = useMutation({
    mutationFn: async (kind: "retry" | "cancel" | "remove") => {
      const path = kind === "remove" ? `/projects/${projectId}/jobs/${jobId}` : `/projects/${projectId}/jobs/${jobId}/${kind}`;
      return api<Job>(path, { method: kind === "remove" ? "DELETE" : "POST" });
    },
    onSuccess: (result, kind) => {
      toast("success", kind === "retry" ? "Job queued for another attempt" : `Job ${result.data.status}`);
      void client.invalidateQueries({ queryKey: ["job", projectId, jobId] });
      void client.invalidateQueries({ queryKey: ["attempts", projectId, jobId] });
      void client.invalidateQueries({ queryKey: ["jobs", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Action failed"),
  });
  const replay = useMutation({
    mutationFn: () => api<Job>(`/projects/${projectId}/jobs/${jobId}/replay`, { method: "POST" }),
    onSuccess: (result) => {
      toast("success", `Queued ${result.data.id}`);
      void client.invalidateQueries({ queryKey: ["jobs", projectId] });
      navigate(`/jobs/${result.data.id}`);
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not run the job again"),
  });
  const promote = useMutation({
    mutationFn: () => api<Job>(`/projects/${projectId}/jobs/${jobId}/promote`, { method: "POST" }),
    onSuccess: () => {
      toast("success", "Job queued to run now");
      void client.invalidateQueries({ queryKey: ["job", projectId, jobId] });
      void client.invalidateQueries({ queryKey: ["jobs", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not run the job now"),
  });
  const [nextDelay, setNextDelay] = useState("");
  const reschedule = useMutation({
    mutationFn: () => api<Job>(`/projects/${projectId}/jobs/${jobId}/reschedule`, {
      method: "POST",
      body: JSON.stringify({ delayMs: Number(nextDelay) }),
    }),
    onSuccess: (result) => {
      toast("success", result.data.delayMs > 0 ? "Delay updated" : "Delay cleared");
      setNextDelay("");
      void client.invalidateQueries({ queryKey: ["job", projectId, jobId] });
      void client.invalidateQueries({ queryKey: ["jobs", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not reschedule the job"),
  });
  const updatePriority = useMutation({
    mutationFn: (priority: string) => api<Job>(`/projects/${projectId}/jobs/${jobId}/priority`, {
      method: "POST",
      body: JSON.stringify({ priority }),
    }),
    onSuccess: (result) => {
      toast("success", "Priority updated");
      void client.invalidateQueries({ queryKey: ["job", projectId, jobId] });
      void client.invalidateQueries({ queryKey: ["jobs", projectId] });
      return result;
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not update the priority"),
  });
  if (job.isLoading) return <p className="text-[13px] text-muted">Loading job…</p>;
  if (!job.data) return <EmptyState title="Job not found" body="This job is not in the current project." />;
  const data = job.data.data;
  return (
    <div className="space-y-4">
      <Link to="/jobs" className="text-[12px] text-muted hover:text-ink">Back to jobs</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-[28px] font-semibold tracking-tight">{data.name}</h1>
            <JobStatusPill status={data.status} />
          </div>
          <p className="mono mt-1 text-[12px] text-muted">{data.id} · {data.queue} · {data.traceId}</p>
          {typeof data.metadata.replayedFrom === "string" ? (
            <p className="mt-1 text-[12px] text-muted">
              Replayed from <Link className="mono hover:underline" to={`/jobs/${data.metadata.replayedFrom}`}>{data.metadata.replayedFrom}</Link>
            </p>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" disabled={replay.isPending || action.isPending} onClick={() => replay.mutate()}>Run again</Button>
          <Button variant="secondary" disabled={data.status !== "delayed" || promote.isPending || action.isPending} onClick={() => promote.mutate()}>Run now</Button>
          <Button variant="secondary" disabled={data.status !== "failed" || action.isPending} onClick={() => action.mutate("retry")}>Retry</Button>
          <Button variant="secondary" disabled={!["waiting", "delayed"].includes(data.status) || action.isPending} onClick={() => action.mutate("cancel")}>Cancel</Button>
          <Button variant="danger" disabled={data.status === "active" || action.isPending} onClick={() => action.mutate("remove")}>Remove</Button>
        </div>
      </div>
      {["waiting", "delayed"].includes(data.status) ? (
        <div className="flex flex-wrap items-end gap-6">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              reschedule.mutate();
            }}
          >
            <label className="text-[13px] text-muted">
              New delay (ms)
              <TextInput
                className="mt-1.5 w-40"
                inputMode="numeric"
                aria-label="New delay (ms)"
                value={nextDelay}
                onChange={(event) => setNextDelay(event.target.value)}
                placeholder="60000"
              />
            </label>
            <Button type="submit" variant="secondary" disabled={nextDelay.trim() === "" || reschedule.isPending}>Reschedule</Button>
          </form>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              updatePriority.mutate(String(new FormData(event.currentTarget).get("priority") ?? ""));
            }}
          >
            <label className="text-[13px] text-muted">
              Priority
              <SelectInput name="priority" aria-label="Queue priority" defaultValue={data.priority} key={data.priority} className="mt-1.5 w-36">
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </SelectInput>
            </label>
            <Button type="submit" variant="secondary" disabled={updatePriority.isPending}>Update priority</Button>
          </form>
        </div>
      ) : null}
      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-5">
        {[
          ["Attempts", `${data.attemptsMade}/${data.maxAttempts}`],
          ["Duration", formatDuration(data.durationMs)],
          ["Priority", data.priority],
          ["Delay", data.delayMs > 0 ? formatDuration(data.delayMs) : "None"],
          ["Backoff", `${data.backoffType} ${data.backoffDelayMs} ms`],
        ].map(([label, value]) => (
          <Card key={label} className="px-4 py-3">
            <div className="text-[12px] text-muted">{label}</div>
            <div className="mt-1 text-[15px] font-medium">{value}</div>
          </Card>
        ))}
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <JsonCard title="Payload" value={data.payload} />
        <JsonCard title={data.error ? "Error" : "Result"} value={data.error ?? data.result ?? { pending: true }} danger={Boolean(data.error)} />
      </div>
      <Card className="p-4">
        <h2 className="text-base font-semibold">Attempts</h2>
        <ol className="mt-4 space-y-4 border-l border-line pl-4">
          {(attempts.data?.data ?? []).length === 0 ? <li className="text-[13px] text-muted">No attempt has started.</li> : null}
          {(attempts.data?.data ?? []).map((attempt) => (
            <li key={attempt.attemptNumber} className="relative">
              <span className="absolute top-1 -left-[21px] h-2.5 w-2.5 rounded-full bg-accent" />
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="font-medium">Attempt {attempt.attemptNumber}</span>
                <span className="capitalize text-muted">{attempt.status}</span>
                <span className="text-faint">{formatDuration(attempt.durationMs)}</span>
              </div>
              <p className="mt-1 text-[12px] text-muted">{formatWhen(attempt.startedAt)} → {formatWhen(attempt.finishedAt)} {attempt.workerId ? `· ${attempt.workerId}` : ""}</p>
              {attempt.errorMessage ? <pre className="mono mt-2 overflow-auto rounded-[10px] bg-bg p-3 text-[12px] text-danger">{attempt.errorMessage}{attempt.errorStack ? `\n\n${attempt.errorStack}` : ""}</pre> : null}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

function applyCreatedWindow(params: URLSearchParams, setParams: (next: URLSearchParams) => void, hours: number | null) {
  const next = new URLSearchParams(params);
  next.delete("page");
  next.delete("to");
  if (hours === null) next.delete("from");
  else next.set("from", new Date(Date.now() - hours * 60 * 60 * 1000).toISOString());
  setParams(next);
}

function isoToLocalInput(iso: string) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localInputToIso(value: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function JsonCard({ title, value, danger = false }: { title: string; value: unknown; danger?: boolean }) {
  const [copied, setCopied] = useState(false);
  const text = pretty(value);
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-base font-semibold">{title}</h2>
        <button
          className="text-[12px] text-muted hover:text-ink"
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className={`mono max-h-80 overflow-auto text-[12px] leading-5 ${danger ? "text-danger" : "text-ink/90"}`}>{text}</pre>
    </Card>
  );
}
