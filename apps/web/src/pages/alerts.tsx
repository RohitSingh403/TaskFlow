import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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

export function AlertsPage() {
  const projectId = useSession((state) => state.projectId);
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
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
  const resolve = useMutation({
    mutationFn: (alertId: string) => api<AlertEvent>(`/projects/${projectId}/alerts/${alertId}/resolve`, { method: "POST" }),
    onSuccess: () => {
      toast("success", "Alert resolved");
      void client.invalidateQueries({ queryKey: ["alerts", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not resolve the alert"),
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
            The scheduler checks these rules. A rule that is still true waits out its cooldown before it opens another alert.
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>New rule</Button>
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
        <div className="px-4 py-3">
          <h2 className="text-[14px] font-medium">History</h2>
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
    </div>
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
