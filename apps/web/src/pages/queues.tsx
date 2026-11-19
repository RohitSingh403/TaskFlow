import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, api } from "@/lib/api";
import type { Job, Queue } from "@/lib/types";
import { useSession, useUi } from "@/stores/session";
import { HealthPill } from "@/components/status";
import { Button, Card, Dialog, EmptyState, Field, TextInput } from "@/components/ui";
import { JobTable } from "./dashboard";

export function QueuesPage() {
  const projectId = useSession((state) => state.projectId);
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const queues = useQuery({
    queryKey: ["queues", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api<Queue[]>(`/projects/${projectId}/queues`),
    refetchInterval: 10_000,
  });
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Queue>(`/projects/${projectId}/queues`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      toast("success", "Queue created");
      setOpen(false);
      void client.invalidateQueries({ queryKey: ["queues", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not create the queue"),
  });
  if (!projectId) return <EmptyState title="Choose a project" body="Queues belong to a project." />;
  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">Queues</h1>
          <p className="text-[13px] text-muted">Counts are read from BullMQ. Configuration is stored with the project.</p>
        </div>
        <Button onClick={() => setOpen(true)}>New queue</Button>
      </div>
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-[13px]">
            <thead className="text-[11px] tracking-wide text-faint uppercase">
              <tr className="border-b border-line">
                {["Queue", "Status", "Waiting", "Active", "Completed", "Failed", "Concurrency", ""].map((heading) => (
                  <th key={heading} className="px-4 py-2 font-medium">{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(queues.data?.data ?? []).map((queue) => (
                <tr key={queue.id} className="border-b border-line/70">
                  <td className="px-4 py-2 font-medium"><Link to={`/queues/${queue.id}`} className="hover:underline">{queue.name}</Link></td>
                  <td className="px-4 py-2"><HealthPill value={queue.status === "paused" ? "paused" : "running"} /></td>
                  <td className="px-4 py-2">{queue.stats?.waiting ?? 0}</td>
                  <td className="px-4 py-2">{queue.stats?.active ?? 0}</td>
                  <td className="px-4 py-2">{queue.stats?.completed ?? 0}</td>
                  <td className="px-4 py-2">{queue.stats?.failed ?? 0}</td>
                  <td className="px-4 py-2">{queue.concurrency}</td>
                  <td className="px-4 py-2 text-right"><QueueToggle queue={queue} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Dialog open={open} title="Create queue" onClose={() => setOpen(false)}>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const rateMax = String(form.get("rateMax") ?? "");
            create.mutate({
              name: String(form.get("name") ?? ""),
              description: String(form.get("description") ?? ""),
              concurrency: Number(form.get("concurrency") ?? 5),
              maxWaiting: Number(form.get("maxWaiting") ?? 10000),
              rateLimit: rateMax ? { max: Number(rateMax), duration: Number(form.get("rateDuration") ?? 1000) } : null,
            });
          }}
        >
          <Field label="Name"><TextInput name="name" required placeholder="image-resize" pattern="[a-z][a-z0-9-]{1,40}" /></Field>
          <Field label="Description"><TextInput name="description" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Concurrency"><TextInput name="concurrency" defaultValue="5" inputMode="numeric" /></Field>
            <Field label="Max waiting"><TextInput name="maxWaiting" defaultValue="10000" inputMode="numeric" /></Field>
            <Field label="Rate max"><TextInput name="rateMax" placeholder="Optional" /></Field>
            <Field label="Rate window (ms)"><TextInput name="rateDuration" placeholder="1000" /></Field>
          </div>
          <div className="flex justify-end"><Button type="submit" loading={create.isPending}>Create</Button></div>
        </form>
      </Dialog>
    </div>
  );
}

export function QueueDetailPage() {
  const { queueId = "" } = useParams();
  const projectId = useSession((state) => state.projectId);
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const queue = useQuery({
    queryKey: ["queue", projectId, queueId],
    enabled: Boolean(projectId && queueId),
    queryFn: () => api<Queue>(`/projects/${projectId}/queues/${queueId}`),
  });
  const jobs = useQuery({
    queryKey: ["jobs", projectId, "queue", queue.data?.data.name],
    enabled: Boolean(projectId && queue.data?.data.name),
    queryFn: () => api<Job[]>(`/projects/${projectId}/jobs?queue=${queue.data?.data.name}&limit=10`),
  });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Queue>(`/projects/${projectId}/queues/${queueId}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      toast("success", "Queue updated. Workers pick up concurrency on the next sync.");
      void client.invalidateQueries({ queryKey: ["queue", projectId, queueId] });
    },
    onError: (reason) => toast("error", reason instanceof Error ? reason.message : "Update failed"),
  });
  if (!queue.data) return <p className="text-[13px] text-muted">Loading queue…</p>;
  const data = queue.data.data;
  return (
    <div className="space-y-4">
      <Link to="/queues" className="text-[12px] text-muted">Back to queues</Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">{data.name}</h1>
          <p className="text-[13px] text-muted">{data.description || "No description"}</p>
        </div>
        <div className="flex items-center gap-2">
          <HealthPill value={data.status === "paused" ? "paused" : "running"} />
          <QueueToggle queue={data} />
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-5">
        {Object.entries({ Waiting: data.stats?.waiting, Active: data.stats?.active, Delayed: data.stats?.delayed, Completed: data.stats?.completed, Failed: data.stats?.failed }).map(([label, value]) => (
          <Card key={label} className="px-4 py-3"><div className="text-[12px] text-muted">{label}</div><div className="mt-1 text-xl font-semibold">{value ?? 0}</div></Card>
        ))}
      </div>
      <Card className="p-4">
        <h2 className="text-base font-semibold">Capacity</h2>
        <form
          className="mt-3 grid gap-3 md:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const rateMax = String(form.get("rateMax") ?? "");
            save.mutate({
              concurrency: Number(form.get("concurrency")),
              maxWaiting: Number(form.get("maxWaiting")),
              description: String(form.get("description") ?? ""),
              rateLimit: rateMax ? { max: Number(rateMax), duration: Number(form.get("rateDuration") ?? 1000) } : null,
            });
          }}
        >
          <Field label="Description"><TextInput name="description" defaultValue={data.description} /></Field>
          <Field label="Concurrency"><TextInput name="concurrency" defaultValue={String(data.concurrency)} /></Field>
          <Field label="Max waiting"><TextInput name="maxWaiting" defaultValue={String(data.maxWaiting)} /></Field>
          <Field label="Rate max / window ms">
            <div className="grid grid-cols-2 gap-2">
              <TextInput name="rateMax" defaultValue={data.rateLimit ? String(data.rateLimit.max) : ""} placeholder="max" />
              <TextInput name="rateDuration" defaultValue={data.rateLimit ? String(data.rateLimit.duration) : ""} placeholder="ms" />
            </div>
          </Field>
          <div className="md:col-span-4"><Button type="submit" loading={save.isPending}>Save</Button></div>
        </form>
        <p className="mt-3 text-[12px] text-muted">Concurrency is how many jobs run at once. Rate limiting is how many may start inside the window. They are separate controls.</p>
      </Card>
      <Card>
        <div className="px-4 py-3 text-base font-semibold">Recent jobs</div>
        <JobTable jobs={jobs.data?.data ?? []} />
      </Card>
    </div>
  );
}

function QueueToggle({ queue }: { queue: Queue }) {
  const projectId = useSession((state) => state.projectId);
  const client = useQueryClient();
  const toast = useUi((state) => state.toast);
  const toggle = useMutation({
    mutationFn: () => api(`/projects/${projectId}/queues/${queue.id}/${queue.isPaused ? "resume" : "pause"}`, { method: "POST" }),
    onSuccess: () => {
      toast("success", queue.isPaused ? "Queue resumed" : "Queue paused");
      void client.invalidateQueries({ queryKey: ["queues", projectId] });
      void client.invalidateQueries({ queryKey: ["queue", projectId, queue.id] });
    },
    onError: (reason) => toast("error", reason instanceof Error ? reason.message : "Could not update the queue"),
  });
  return <Button size="sm" variant="secondary" loading={toggle.isPending} onClick={() => toggle.mutate()}>{queue.isPaused ? "Resume" : "Pause"}</Button>;
}
