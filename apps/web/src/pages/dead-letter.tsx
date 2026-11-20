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
  const query = new URLSearchParams({ status: "failed", limit: "50" });
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

  if (!projectId) return <EmptyState title="Choose a project" body="Failed jobs belong to a project." />;
  const rows = jobs.data?.data ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">Dead letter</h1>
          <p className="max-w-2xl text-[13px] text-muted">
            These jobs used their attempts and stayed on the original queue. Retry runs the same job again. It does not create a second one.
          </p>
        </div>
        <Button disabled={rows.length === 0 || retry.isPending} loading={retry.isPending} onClick={() => retry.mutate()}>
          Retry failed
        </Button>
      </div>
      <div className="w-44">
        <SelectInput value={queue} onChange={(event) => setQueue(event.target.value)} aria-label="Queue">
        <option value="">All queues</option>
        {(queues.data?.data ?? []).map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}
      </SelectInput>
      </div>
      <Card>
        {jobs.isLoading ? <p className="p-4 text-[13px] text-muted">Loading failed jobs…</p> : <JobTable jobs={rows} />}
      </Card>
    </div>
  );
}
