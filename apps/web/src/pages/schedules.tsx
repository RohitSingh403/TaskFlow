import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "@/lib/api";
import { formatWhen } from "@/lib/format";
import type { HandlerInfo, Job, Queue, Schedule } from "@/lib/types";
import { useSession, useUi } from "@/stores/session";
import { HealthPill } from "@/components/status";
import { Button, Card, Dialog, EmptyState, Field, SelectInput, TextArea, TextInput } from "@/components/ui";

export function SchedulesPage() {
  const projectId = useSession((state) => state.projectId);
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const schedules = useQuery({
    queryKey: ["schedules", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api<Schedule[]>(`/projects/${projectId}/schedules`),
    refetchInterval: 10_000,
  });
  const pauseSchedules = useMutation({
    mutationFn: () => api<{ paused: number; scheduleIds: string[] }>(`/projects/${projectId}/schedules/pause`, { method: "POST", body: JSON.stringify({ limit: 20 }) }),
    onSuccess: (result) => {
      const count = result.data.paused;
      toast(count === 0 ? "warning" : "success", count === 1 ? "Paused 1 schedule" : `Paused ${count} schedules`);
      void client.invalidateQueries({ queryKey: ["schedules", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not pause schedules"),
  });
  const resumeSchedules = useMutation({
    mutationFn: () => api<{ resumed: number; scheduleIds: string[] }>(`/projects/${projectId}/schedules/resume`, { method: "POST", body: JSON.stringify({ limit: 20 }) }),
    onSuccess: (result) => {
      const count = result.data.resumed;
      toast(count === 0 ? "warning" : "success", count === 1 ? "Resumed 1 schedule" : `Resumed ${count} schedules`);
      void client.invalidateQueries({ queryKey: ["schedules", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not resume schedules"),
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
  const run = useMutation({
    mutationFn: (schedule: Schedule) => api<Job>(`/projects/${projectId}/schedules/${schedule.id}/run`, { method: "POST" }),
    onSuccess: (result) => {
      toast("success", `Queued ${result.data.id}`);
      void client.invalidateQueries({ queryKey: ["schedules", projectId] });
      void client.invalidateQueries({ queryKey: ["jobs", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not run the schedule"),
  });
  const runSchedules = useMutation({
    mutationFn: () => api<{ queued: number; skipped: number; scheduleIds: string[]; jobIds: string[] }>(`/projects/${projectId}/schedules/run`, {
      method: "POST",
      body: JSON.stringify({ limit: 20 }),
    }),
    onSuccess: (result) => {
      const count = result.data.queued;
      toast(count === 0 ? "warning" : "success", count === 1 ? "Queued 1 job" : `Queued ${count} jobs`);
      void client.invalidateQueries({ queryKey: ["schedules", projectId] });
      void client.invalidateQueries({ queryKey: ["jobs", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not run schedules"),
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
            One scheduler process turns a cron pattern into a normal job. Edit keeps the same schedule. A new cron or time zone recalculates the next run, and the pause state stays as it is. Run now queues one job and leaves the next cron time where it is. Run schedules does that for the oldest schedules, up to 20, and keeps each schedule id. A paused schedule can still run. A second call queues another job. Pause schedules stops the oldest running schedules, up to 20, and keeps each schedule id. The next run time stays. Resume schedules starts the oldest paused schedules again, up to 20, and keeps each schedule id. A next run that is already past moves forward. A schedule that is already running is left alone. Missed ticks older than a minute are skipped.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" loading={pauseSchedules.isPending} onClick={() => pauseSchedules.mutate()}>Pause schedules</Button>
          <Button variant="secondary" loading={resumeSchedules.isPending} onClick={() => resumeSchedules.mutate()}>Resume schedules</Button>
          <Button variant="secondary" loading={runSchedules.isPending} onClick={() => runSchedules.mutate()}>Run schedules</Button>
          <Button onClick={() => setOpen(true)}>New schedule</Button>
        </div>
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
                        <Button size="sm" variant="secondary" onClick={() => setEditing(schedule)}>Edit</Button>
                        <Button size="sm" variant="secondary" loading={run.isPending} onClick={() => run.mutate(schedule)}>Run now</Button>
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
      <EditSchedule schedule={editing} onClose={() => setEditing(null)} />
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

function EditSchedule({ schedule, onClose }: { schedule: Schedule | null; onClose: () => void }) {
  const projectId = useSession((state) => state.projectId);
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const queues = useQuery({
    queryKey: ["queues", projectId],
    queryFn: () => api<Queue[]>(`/projects/${projectId}/queues`),
    enabled: Boolean(schedule) && Boolean(projectId),
  });
  const [name, setName] = useState("");
  const [cron, setCron] = useState("");
  const [timeZone, setTimeZone] = useState("UTC");
  const [queue, setQueue] = useState("");
  const [payload, setPayload] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!schedule) return;
    setName(schedule.name);
    setCron(schedule.cron);
    setTimeZone(schedule.timeZone);
    setQueue(schedule.queue);
    setPayload(JSON.stringify(schedule.payload, null, 2));
    setError("");
  }, [schedule]);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Schedule>(`/projects/${projectId}/schedules/${schedule?.id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: (result) => {
      toast("success", `Next run ${formatWhen(result.data.nextRunAt)}`);
      setError("");
      onClose();
      void client.invalidateQueries({ queryKey: ["schedules", projectId] });
    },
    onError: (reason) => setError(reason instanceof ApiError ? reason.message : "Could not update the schedule"),
  });

  const queueNames = queues.data?.data.map((item) => item.name) ?? [];
  const options = queue && !queueNames.includes(queue) ? [queue, ...queueNames] : queueNames;

  return (
    <Dialog open={Boolean(schedule)} title="Edit schedule" description="The schedule id stays. A new cron or time zone recalculates the next run. Pause state stays as it is." onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(payload) as Record<string, unknown>;
          } catch {
            setError("Payload must be valid JSON");
            return;
          }
          save.mutate({ name, queue, payload: parsed, cron, timeZone });
        }}
      >
        <Field label="Name">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} required aria-label="Schedule name" />
        </Field>
        <Field label="Queue">
          <SelectInput value={queue} onChange={(event) => setQueue(event.target.value)} aria-label="Queue">
            {options.map((item) => <option key={item} value={item}>{item}</option>)}
          </SelectInput>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Cron">
            <TextInput value={cron} onChange={(event) => setCron(event.target.value)} required aria-label="Cron" className="font-mono" />
          </Field>
          <Field label="Time zone">
            <TextInput value={timeZone} onChange={(event) => setTimeZone(event.target.value)} required aria-label="Time zone" />
          </Field>
        </div>
        <Field label="Payload">
          <TextArea value={payload} onChange={(event) => setPayload(event.target.value)} aria-label="Payload" />
        </Field>
        {error ? <p className="text-[12px] text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.isPending}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}
