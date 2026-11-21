import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { Job, Queue } from "@/lib/types";
import { useSession, useUi } from "@/stores/session";
import { JobTable } from "./dashboard";
import { Button, Card, EmptyState, SelectInput } from "@/components/ui";

export function DeadLetterPage() {
  const projectId = useSession((state) => state.projectId);
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const [queue, setQueue] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const query = new URLSearchParams({ status: "failed", dismissed: dismissed ? "true" : "false", limit: "50" });
  if (queue) query.set("queue", queue);
  const jobs = useQuery({
    queryKey: ["jobs", projectId, "dead-letter", query.toString()],
    enabled: Boolean(projectId),
    queryFn: () => api<Job[]>(`/projects/${projectId}/jobs?${query.toString()}`),
  });
  const queues = useQuery({
    queryKey: ["queues", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api<Queue[]>(`/projects/${projectId}/queues`),
  });
  const retry = useMutation({
    mutationFn: () => api<{ retried: number; skipped: number }>(`/projects/${projectId}/jobs/retry-failed`, {
      method: "POST",
      body: JSON.stringify(queue ? { queue, limit: 20 } : { limit: 20 }),
    }),
    onSuccess: (result) => {
      toast("success", result.data.retried === 1 ? "Retried 1 job" : `Retried ${result.data.retried} jobs`);
      void client.invalidateQueries({ queryKey: ["jobs", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not retry failed jobs"),
  });
  const dismiss = useMutation({
    mutationFn: (jobId: string) => api<Job>(`/projects/${projectId}/jobs/${jobId}/dismiss`, { method: "POST" }),
    onSuccess: () => {
      toast("success", "Job left the dead letter list");
      void client.invalidateQueries({ queryKey: ["jobs", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not dismiss the job"),
  });
  const restore = useMutation({
    mutationFn: (jobId: string) => api<Job>(`/projects/${projectId}/jobs/${jobId}/restore`, { method: "POST" }),
    onSuccess: () => {
      toast("success", "Job restored to the dead letter list");
      void client.invalidateQueries({ queryKey: ["jobs", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not restore the job"),
  });

  if (!projectId) return <EmptyState title="Choose a project" body="Failed jobs belong to a project." />;
  const rows = jobs.data?.data ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">Dead letter</h1>
          <p className="max-w-2xl text-[13px] text-muted">
            These jobs used their attempts and stayed on the original queue. Retry runs the same job again. It does not create a second one. Dismiss takes a failed job off this list and leaves it failed. Restore puts it back. Retry failed skips dismissed jobs.
          </p>
        </div>
        {dismissed ? null : (
          <Button disabled={rows.length === 0 || retry.isPending} loading={retry.isPending} onClick={() => retry.mutate()}>
            Retry failed
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-44">
          <SelectInput value={queue} onChange={(event) => setQueue(event.target.value)} aria-label="Queue">
            <option value="">All queues</option>
            {(queues.data?.data ?? []).map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}
          </SelectInput>
        </div>
        <Button variant="secondary" onClick={() => setDismissed((current) => !current)}>{dismissed ? "Show open" : "Show dismissed"}</Button>
      </div>
      <Card>
        {jobs.isLoading ? <p className="p-4 text-[13px] text-muted">Loading failed jobs…</p> : (
          <JobTable
            jobs={rows}
            action={(job) => dismissed ? (
              <Button size="sm" variant="secondary" loading={restore.isPending} onClick={() => restore.mutate(job.id)}>Restore</Button>
            ) : (
              <Button size="sm" variant="secondary" loading={dismiss.isPending} onClick={() => dismiss.mutate(job.id)}>Dismiss</Button>
            )}
          />
        )}
      </Card>
    </div>
  );
}
