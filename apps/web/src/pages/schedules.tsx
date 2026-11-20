import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "@/lib/api";
import { formatWhen } from "@/lib/format";
import type { HandlerInfo, Queue, Schedule } from "@/lib/types";
import { useSession, useUi } from "@/stores/session";
import { HealthPill } from "@/components/status";
import { Button, Card, Dialog, EmptyState, Field, SelectInput, TextArea, TextInput } from "@/components/ui";

export function SchedulesPage() {
  const projectId = useSession((state) => state.projectId);
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const schedules = useQuery({
    queryKey: ["schedules", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api<Schedule[]>(`/projects/${projectId}/schedules`),
    refetchInterval: 10_000,
  });
  const pause = useMutation({
    mutationFn: (schedule: Schedule) =>
      api<Schedule>(`/projects/${projectId}/schedules/${schedule.id}/${schedule.paused ? "resume" : "pause"}`, { method: "POST" }),
    onSuccess: (result) => {
      toast("success", result.data.paused ? "Schedule paused" : "Schedule resumed");
      void client.invalidateQueries({ queryKey: ["schedules", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not update the schedule"),
  });
  const remove = useMutation({
    mutationFn: (scheduleId: string) => api(`/projects/${projectId}/schedules/${scheduleId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast("success", "Schedule deleted");
      setRemoveId(null);
      void client.invalidateQueries({ queryKey: ["schedules", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not delete the schedule"),
  });

  if (!projectId) return <EmptyState title="Choose a project" body="Schedules belong to a project." />;
  const rows = schedules.data?.data ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">Schedules</h1>
          <p className="max-w-2xl text-[13px] text-muted">
            One scheduler process turns a cron pattern into a normal job. Missed ticks older than a minute are skipped instead of replayed.
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>New schedule</Button>
      </div>
      {schedules.isLoading ? <Card className="p-4 text-[13px] text-muted">Loading schedules…</Card> : null}
      {schedules.isError ? <EmptyState title="Schedules unavailable" body="The list request failed. Refresh once the API is reachable." /> : null}
      {!schedules.isLoading && !schedules.isError && rows.length === 0 ? (
        <EmptyState title="No schedules yet" body="Create one for a daily report or a reminder. The worker still executes each occurrence." action={<Button onClick={() => setOpen(true)}>New schedule</Button>} />
      ) : null}
      {rows.length > 0 ? (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-[13px]">
              <thead className="text-[11px] tracking-wide text-faint uppercase">
                <tr className="border-b border-line">
                  {["Name", "Status", "Cron", "Next run", "Last job", ""].map((heading) => (
                    <th key={heading} className="px-4 py-2 font-medium">{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((schedule) => (
                  <tr key={schedule.id} className="border-b border-line/70">
                    <td className="px-4 py-3">
                      <div className="font-medium">{schedule.name}</div>
                      <div className="text-[12px] text-muted">{schedule.handler} · {schedule.queue} · {schedule.timeZone}</div>
                      {schedule.lastError ? <div className="mt-1 text-[12px] text-danger">{schedule.lastError}</div> : null}
                    </td>
                    <td className="px-4 py-3"><HealthPill value={schedule.paused ? "paused" : "running"} /></td>
                    <td className="mono px-4 py-3 text-[12px]">{schedule.cron}</td>
                    <td className="px-4 py-3 text-[12px] text-muted">{formatWhen(schedule.nextRunAt)}</td>
                    <td className="px-4 py-3">
                      {schedule.lastJobId ? <Link className="mono text-[12px] hover:underline" to={`/jobs/${schedule.lastJobId}`}>{schedule.lastJobId}</Link> : <span className="text-faint">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        <Link to={`/jobs?schedule=${schedule.id}`} className="inline-flex h-8 items-center px-2 text-[13px] text-muted hover:text-ink">Jobs</Link>
                        <Button size="sm" variant="secondary" onClick={() => pause.mutate(schedule)}>{schedule.paused ? "Resume" : "Pause"}</Button>
                        <Button size="sm" variant="danger" onClick={() => setRemoveId(schedule.id)}>Delete</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
      <CreateSchedule open={open} onClose={() => setOpen(false)} />
      <Dialog open={Boolean(removeId)} title="Delete schedule" description="Future occurrences stop. Jobs that already exist stay in their queue." onClose={() => setRemoveId(null)}>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setRemoveId(null)}>Keep</Button>
          <Button variant="danger" loading={remove.isPending} onClick={() => removeId && remove.mutate(removeId)}>Delete</Button>
        </div>
      </Dialog>
    </div>
  );
}

function CreateSchedule({ open, onClose }: { open: boolean; onClose: () => void }) {
  const projectId = useSession((state) => state.projectId);
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const handlers = useQuery({
    queryKey: ["handlers"],
    queryFn: () => api<HandlerInfo[]>("/meta/handlers"),
    enabled: open,
  });
  const queues = useQuery({
    queryKey: ["queues", projectId],
    queryFn: () => api<Queue[]>(`/projects/${projectId}/queues`),
    enabled: open && Boolean(projectId),
  });
  const [handler, setHandler] = useState("generate-report");
  const [queue, setQueue] = useState("reports");
  const [payload, setPayload] = useState("");
  const [error, setError] = useState("");
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  useEffect(() => {
    const selected = handlers.data?.data.find((item) => item.name === handler);
    if (selected && open) {
      setPayload(JSON.stringify(selected.example, null, 2));
      if ((queues.data?.data ?? []).some((item) => item.name === selected.suggestedQueue)) setQueue(selected.suggestedQueue);
    }
  }, [handler, handlers.data, open, queues.data]);

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Schedule>(`/projects/${projectId}/schedules`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (result) => {
      toast("success", `Next run ${formatWhen(result.data.nextRunAt)}`);
      setError("");
      onClose();
      void client.invalidateQueries({ queryKey: ["schedules", projectId] });
    },
    onError: (reason) => setError(reason instanceof ApiError ? reason.message : "Could not create the schedule"),
  });

  return (
    <Dialog open={open} title="Create schedule" description="Five fields: minute hour day month weekday. The next run is calculated in the time zone you choose." onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(payload) as Record<string, unknown>;
          } catch {
            setError("Payload must be valid JSON");
            return;
          }
          create.mutate({
            name: String(form.get("name") ?? ""),
            queue,
            handler,
            payload: parsed,
            cron: String(form.get("cron") ?? ""),
            timeZone: String(form.get("timeZone") ?? "UTC"),
          });
        }}
      >
        <Field label="Name">
          <TextInput name="name" required placeholder="Morning report" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Handler">
            <SelectInput value={handler} onChange={(event) => setHandler(event.target.value)} aria-label="Handler">
              {(handlers.data?.data ?? [{ name: "generate-report" }]).map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
            </SelectInput>
          </Field>
          <Field label="Queue">
            <SelectInput value={queue} onChange={(event) => setQueue(event.target.value)} aria-label="Queue">
              {(queues.data?.data ?? []).map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}
            </SelectInput>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Cron">
            <TextInput name="cron" required defaultValue="0 9 * * *" className="font-mono" />
          </Field>
          <Field label="Time zone">
            <TextInput name="timeZone" required defaultValue={zone} />
          </Field>
        </div>
        <Field label="Payload">
          <TextArea value={payload} onChange={(event) => setPayload(event.target.value)} />
        </Field>
        {error ? <p className="text-[12px] text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={create.isPending}>Create</Button>
        </div>
      </form>
    </Dialog>
  );
}
