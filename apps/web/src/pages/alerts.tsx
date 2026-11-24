import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { formatWhen } from "@/lib/format";
import type { AlertEvent, AlertRule, AlertType, Queue } from "@/lib/types";
import { useSession, useUi } from "@/stores/session";
import { Button, Card, Dialog, EmptyState, Field, SelectInput, TextInput } from "@/components/ui";

const labels: Record<AlertType, string> = {
  "queue.backlog": "Queue backlog",
  "failure.rate": "Failure rate",
  "worker.offline": "Worker offline",
  "job.long_running": "Long-running job",
};

const silenceChoices = [
  { label: "1 hour", durationMs: 60 * 60 * 1000 },
  { label: "8 hours", durationMs: 8 * 60 * 60 * 1000 },
  { label: "1 day", durationMs: 24 * 60 * 60 * 1000 },
  { label: "7 days", durationMs: 7 * 24 * 60 * 60 * 1000 },
];

export function AlertsPage() {
  const projectId = useSession((state) => state.projectId);
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AlertRule | null>(null);
  const [durationMs, setDurationMs] = useState(silenceChoices[0]?.durationMs ?? 60 * 60 * 1000);
  const rules = useQuery({
    queryKey: ["alert-rules", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api<AlertRule[]>(`/projects/${projectId}/alerts/rules`),
  });
  const alerts = useQuery({
    queryKey: ["alerts", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api<AlertEvent[]>(`/projects/${projectId}/alerts?limit=20`),
    refetchInterval: 15_000,
  });
  const toggle = useMutation({
    mutationFn: (rule: AlertRule) => api<AlertRule>(`/projects/${projectId}/alerts/rules/${rule.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !rule.enabled }),
    }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["alert-rules", projectId] }),
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not update the rule"),
  });
  const remove = useMutation({
    mutationFn: (ruleId: string) => api(`/projects/${projectId}/alerts/rules/${ruleId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast("success", "Alert rule deleted");
      void client.invalidateQueries({ queryKey: ["alert-rules", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not delete the rule"),
  });
  const resolveOpen = useMutation({
    mutationFn: () => api<{ resolved: number }>(`/projects/${projectId}/alerts/resolve-open`, {
      method: "POST",
      body: JSON.stringify({ limit: 20 }),
    }),
    onSuccess: (result) => {
      toast("success", result.data.resolved === 1 ? "Resolved 1 alert" : `Resolved ${result.data.resolved} alerts`);
      void client.invalidateQueries({ queryKey: ["alerts", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not resolve open alerts"),
  });
  const resolve = useMutation({
    mutationFn: (alertId: string) => api<AlertEvent>(`/projects/${projectId}/alerts/${alertId}/resolve`, { method: "POST" }),
    onSuccess: () => {
      toast("success", "Alert resolved");
      void client.invalidateQueries({ queryKey: ["alerts", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not resolve the alert"),
  });
  const silenceRules = useMutation({
    mutationFn: () => api<{ silenced: number; skipped: number; ruleIds: string[] }>(`/projects/${projectId}/alerts/rules/silence`, {
      method: "POST",
      body: JSON.stringify({ durationMs, limit: 20 }),
    }),
    onSuccess: (result) => {
      const count = result.data.silenced;
      toast(count === 0 ? "warning" : "success", count === 1 ? "Silenced 1 rule" : `Silenced ${count} rules`);
      void client.invalidateQueries({ queryKey: ["alert-rules", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not silence rules"),
  });
  const clearSilences = useMutation({
    mutationFn: () => api<{ unsilenced: number; skipped: number; ruleIds: string[] }>(`/projects/${projectId}/alerts/rules/unsilence`, {
      method: "POST",
      body: JSON.stringify({ limit: 20 }),
    }),
    onSuccess: (result) => {
      const count = result.data.unsilenced;
      toast(count === 0 ? "warning" : "success", count === 1 ? "Cleared 1 silence" : `Cleared ${count} silences`);
      void client.invalidateQueries({ queryKey: ["alert-rules", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not clear silences"),
  });
  const pauseRules = useMutation({
    mutationFn: () => api<{ paused: number; skipped: number; ruleIds: string[] }>(`/projects/${projectId}/alerts/rules/pause`, {
      method: "POST",
      body: JSON.stringify({ limit: 20 }),
    }),
    onSuccess: (result) => {
      const count = result.data.paused;
      toast(count === 0 ? "warning" : "success", count === 1 ? "Paused 1 rule" : `Paused ${count} rules`);
      void client.invalidateQueries({ queryKey: ["alert-rules", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not pause rules"),
  });
  const resumeRules = useMutation({
    mutationFn: () => api<{ resumed: number; skipped: number; ruleIds: string[] }>(`/projects/${projectId}/alerts/rules/resume`, {
      method: "POST",
      body: JSON.stringify({ limit: 20 }),
    }),
    onSuccess: (result) => {
      const count = result.data.resumed;
      toast(count === 0 ? "warning" : "success", count === 1 ? "Resumed 1 rule" : `Resumed ${count} rules`);
      void client.invalidateQueries({ queryKey: ["alert-rules", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not resume rules"),
  });
  const deleteRules = useMutation({
    mutationFn: () => api<{ deleted: number; skipped: number; ruleIds: string[] }>(`/projects/${projectId}/alerts/rules/delete`, {
      method: "POST",
      body: JSON.stringify({ limit: 20 }),
    }),
    onSuccess: (result) => {
      const count = result.data.deleted;
      toast(count === 0 ? "warning" : "success", count === 1 ? "Deleted 1 rule" : `Deleted ${count} rules`);
      void client.invalidateQueries({ queryKey: ["alert-rules", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not delete rules"),
  });

  if (!projectId) return <EmptyState title="Choose a project" body="Alert rules belong to a project." />;
  const ruleRows = rules.data?.data ?? [];
  const history = alerts.data?.data ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">Alerts</h1>
          <p className="max-w-2xl text-[13px] text-muted">
            The scheduler checks these rules. A rule that is still true waits out its cooldown before it opens another alert. Edit changes the name, threshold, or cooldown and keeps the rule id and its silence. Silence skips a rule until the time you choose. Silence rules does that for the oldest rules that are still checking, up to 20, and keeps each rule id. Clear silences starts the oldest silenced rules checking again, up to 20, and keeps each rule id. A rule that is already checking is left alone. The rule stays enabled. Pause rules stops the oldest enabled rules, up to 20, and keeps each rule id and its silence. A rule that is already paused is left alone. A paused rule is not checked. Resume rules starts the oldest paused rules checking again, up to 20, and keeps each rule id and its silence. A rule that is already enabled is left alone. A silence that is still in the future keeps that rule from opening an alert. Resolve open marks the oldest open alerts resolved, up to 20. Each alert keeps its id. Delete rules removes the oldest rules, up to 20, including a paused rule and a silenced rule, and keeps each rule id. A rule that is already deleted is left alone. A second call deletes none of those rules.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SelectInput className="h-8 w-28" aria-label="Silence rules for" value={String(durationMs)} onChange={(event) => setDurationMs(Number(event.target.value))}>
            {silenceChoices.map((choice) => <option key={choice.durationMs} value={choice.durationMs}>{choice.label}</option>)}
          </SelectInput>
          <Button variant="secondary" loading={silenceRules.isPending} onClick={() => silenceRules.mutate()}>Silence rules</Button>
          <Button variant="secondary" loading={clearSilences.isPending} onClick={() => clearSilences.mutate()}>Clear silences</Button>
          <Button variant="secondary" loading={pauseRules.isPending} onClick={() => pauseRules.mutate()}>Pause rules</Button>
          <Button variant="secondary" loading={resumeRules.isPending} onClick={() => resumeRules.mutate()}>Resume rules</Button>
          <Button variant="danger" loading={deleteRules.isPending} onClick={() => deleteRules.mutate()}>Delete rules</Button>
          <Button onClick={() => setOpen(true)}>New rule</Button>
        </div>
      </div>
      {rules.isError || alerts.isError ? <EmptyState title="Alerts unavailable" body="The request failed. Refresh once the API is reachable." /> : null}
      {ruleRows.length === 0 && !rules.isLoading ? (
        <EmptyState title="No alert rules" body="Start with a backlog threshold or a failure rate. Nothing is sent until a rule is true." action={<Button onClick={() => setOpen(true)}>New rule</Button>} />
      ) : null}
      {ruleRows.length > 0 ? (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-[13px]">
            <thead className="text-[12px] text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-3 font-medium">Rule</th>
                <th className="px-4 py-3 font-medium">Condition</th>
                <th className="px-4 py-3 font-medium">Last opened</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {ruleRows.map((rule) => (
                <tr key={rule.id} className="border-b border-line/70">
                  <td className="px-4 py-3">
                    <div className="font-medium">{rule.name}</div>
                    <div className="text-[12px] text-muted">{labels[rule.type]}{rule.lastError ? ` · ${rule.lastError}` : ""}</div>
                  </td>
                  <td className="px-4 py-3 text-muted">{describe(rule)}</td>
                  <td className="px-4 py-3">{formatWhen(rule.lastTriggeredAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(rule)}>Edit</Button>
                    <RuleSilence rule={rule} />
                    <Button variant="ghost" size="sm" onClick={() => toggle.mutate(rule)}>{rule.enabled ? "Pause" : "Enable"}</Button>
                    <Button variant="ghost" size="sm" onClick={() => remove.mutate(rule.id)}>Delete</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      <Card className="overflow-x-auto">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <h2 className="text-[14px] font-medium">History</h2>
          <Button
            size="sm"
            variant="secondary"
            disabled={!history.some((alert) => alert.status === "open") || resolveOpen.isPending}
            loading={resolveOpen.isPending}
            onClick={() => resolveOpen.mutate()}
          >
            Resolve open
          </Button>
        </div>
        {history.length === 0 ? <p className="px-4 pb-4 text-[13px] text-muted">No alerts yet.</p> : (
          <table className="w-full min-w-[720px] text-left text-[13px]">
            <tbody>
              {history.map((alert) => (
                <tr key={alert.id} className="border-t border-line/70">
                  <td className="px-4 py-3">
                    <div className="font-medium">{alert.title}</div>
                    <div className="text-[12px] text-muted">{alert.message}</div>
                  </td>
                  <td className="px-4 py-3 text-muted">{formatWhen(alert.createdAt)}</td>
                  <td className="px-4 py-3 text-right">
                    {alert.status === "open" ? (
                      <Button size="sm" variant="secondary" loading={resolve.isPending} onClick={() => resolve.mutate(alert.id)}>Resolve</Button>
                    ) : (
                      <span className="text-[12px] text-muted">Resolved</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {open ? <CreateRule onClose={() => setOpen(false)} /> : null}
      <EditRule rule={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function RuleSilence({ rule }: { rule: AlertRule }) {
  const projectId = useSession((state) => state.projectId);
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const [durationMs, setDurationMs] = useState(silenceChoices[0]?.durationMs ?? 60 * 60 * 1000);
  const silenced = Boolean(rule.silencedUntil && new Date(rule.silencedUntil).getTime() > Date.now());
  const refresh = () => void client.invalidateQueries({ queryKey: ["alert-rules", projectId] });
  const silence = useMutation({
    mutationFn: () => api<AlertRule>(`/projects/${projectId}/alerts/rules/${rule.id}/silence`, {
      method: "POST",
      body: JSON.stringify({ durationMs }),
    }),
    onSuccess: (result) => {
      toast("success", `Silenced until ${formatWhen(result.data.silencedUntil)}`);
      refresh();
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not silence the rule"),
  });
  const clear = useMutation({
    mutationFn: () => api<AlertRule>(`/projects/${projectId}/alerts/rules/${rule.id}/unsilence`, { method: "POST" }),
    onSuccess: () => {
      toast("success", "Silence cleared");
      refresh();
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not clear the silence"),
  });
  if (silenced) {
    return (
      <span className="mr-2 inline-flex items-center gap-2">
        <span className="text-[12px] text-muted">Silenced until {formatWhen(rule.silencedUntil)}</span>
        <Button variant="ghost" size="sm" loading={clear.isPending} onClick={() => clear.mutate()}>Clear silence</Button>
      </span>
    );
  }
  return (
    <span className="mr-2 inline-flex items-center gap-2">
      <SelectInput className="h-8 w-28" aria-label={`Silence ${rule.name}`} value={String(durationMs)} onChange={(event) => setDurationMs(Number(event.target.value))}>
        {silenceChoices.map((choice) => <option key={choice.durationMs} value={choice.durationMs}>{choice.label}</option>)}
      </SelectInput>
      <Button variant="ghost" size="sm" loading={silence.isPending} onClick={() => silence.mutate()}>Silence</Button>
    </span>
  );
}

function EditRule({ rule, onClose }: { rule: AlertRule | null; onClose: () => void }) {
  const projectId = useSession((state) => state.projectId);
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [threshold, setThreshold] = useState("");
  const [cooldownMinutes, setCooldownMinutes] = useState("15");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!rule) return;
    setName(rule.name);
    setThreshold(String(rule.threshold));
    setCooldownMinutes(String(Math.round(rule.cooldownMs / 60_000)));
    setError("");
  }, [rule]);
  const save = useMutation({
    mutationFn: () => api<AlertRule>(`/projects/${projectId}/alerts/rules/${rule?.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name,
        cooldownMs: Number(cooldownMinutes) * 60_000,
        ...(rule && rule.type !== "worker.offline" ? { threshold: Number(threshold) } : {}),
      }),
    }),
    onSuccess: () => {
      toast("success", "Alert rule updated");
      setError("");
      onClose();
      void client.invalidateQueries({ queryKey: ["alert-rules", projectId] });
    },
    onError: (reason) => setError(reason instanceof ApiError ? reason.message : "Could not update the rule"),
  });
  const thresholdLabel = rule?.type === "failure.rate" ? "Failure percent" : rule?.type === "job.long_running" ? "Active for (ms)" : "Waiting jobs";
  return (
    <Dialog open={Boolean(rule)} title="Edit alert rule" description="The rule id and silence stay. The type and queue stay too." onClose={onClose}>
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
        <Field label="Name">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} aria-label="Alert rule name" required minLength={2} />
        </Field>
        {rule && rule.type !== "worker.offline" ? (
          <Field label={thresholdLabel}>
            <TextInput value={threshold} onChange={(event) => setThreshold(event.target.value)} aria-label="Alert threshold" inputMode="numeric" required />
          </Field>
        ) : null}
        <Field label="Cooldown (minutes)">
          <TextInput value={cooldownMinutes} onChange={(event) => setCooldownMinutes(event.target.value)} aria-label="Alert cooldown" inputMode="numeric" required />
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

function describe(rule: AlertRule) {
  if (rule.type === "queue.backlog") return `${rule.queue} waiting ≥ ${rule.threshold}`;
  if (rule.type === "failure.rate") return `${rule.threshold}% failed${rule.queue ? ` on ${rule.queue}` : ""}`;
  if (rule.type === "worker.offline") return "Assigned worker stops or goes stale";
  return `Active longer than ${Math.round(rule.threshold / 1000)}s`;
}

function CreateRule({ onClose }: { onClose: () => void }) {
  const projectId = useSession((state) => state.projectId);
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const [type, setType] = useState<AlertType>("queue.backlog");
  const [name, setName] = useState("Email backlog");
  const [queue, setQueue] = useState("emails");
  const [threshold, setThreshold] = useState("100");
  const queues = useQuery({
    queryKey: ["queues", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api<Queue[]>(`/projects/${projectId}/queues`),
  });
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<AlertRule>(`/projects/${projectId}/alerts/rules`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      toast("success", "Alert rule created");
      void client.invalidateQueries({ queryKey: ["alert-rules", projectId] });
      onClose();
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not create the rule"),
  });

  return (
    <Dialog open title="New alert rule" onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const body: Record<string, unknown> = { type, name };
          if (type !== "worker.offline") body.threshold = Number(threshold);
          if (type === "queue.backlog" || type === "failure.rate" || type === "job.long_running") body.queue = queue;
          if (type === "failure.rate" && !queue) delete body.queue;
          create.mutate(body);
        }}
      >
        <Field label="Name"><TextInput value={name} onChange={(event) => setName(event.target.value)} required /></Field>
        <Field label="Type">
          <SelectInput
            value={type}
            onChange={(event) => {
              const next = event.target.value as AlertType;
              setType(next);
              setThreshold(next === "failure.rate" ? "25" : next === "job.long_running" ? "300000" : "100");
              setName(labels[next]);
            }}
          >
            {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </SelectInput>
        </Field>
        {type !== "worker.offline" ? (
          <Field label="Queue">
            <SelectInput value={queue} onChange={(event) => setQueue(event.target.value)}>
              {type !== "queue.backlog" ? <option value="">Any queue</option> : null}
              {(queues.data?.data ?? []).map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}
            </SelectInput>
          </Field>
        ) : null}
        {type !== "worker.offline" ? (
          <Field label={type === "failure.rate" ? "Failure percent" : type === "job.long_running" ? "Active for (ms)" : "Waiting jobs"}>
            <TextInput value={threshold} onChange={(event) => setThreshold(event.target.value)} inputMode="numeric" required />
          </Field>
        ) : null}
        <div className="flex justify-end"><Button type="submit" loading={create.isPending}>Create</Button></div>
      </form>
    </Dialog>
  );
}
