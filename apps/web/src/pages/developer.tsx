import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { formatWhen } from "@/lib/format";
import type { ApiKey, Project } from "@/lib/types";
import { useSession, useUi } from "@/stores/session";
import { Button, Card, Dialog, EmptyState, Field, TextInput } from "@/components/ui";

const SCOPES = ["jobs:read", "jobs:write", "queues:read", "queues:write", "workers:read", "logs:read", "analytics:read"];

export function ApiKeysPage() {
  const projectId = useSession((state) => state.projectId);
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ApiKey | null>(null);
  const [scoping, setScoping] = useState<ApiKey | null>(null);
  const [expiring, setExpiring] = useState<ApiKey | null>(null);
  const [secret, setSecret] = useState("");
  const keys = useQuery({
    queryKey: ["api-keys", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api<ApiKey[]>(`/projects/${projectId}/api-keys`),
  });
  const create = useMutation({
    mutationFn: (body: { name: string; description: string; scopes: string[]; expiresInDays?: number }) =>
      api<ApiKey>(`/projects/${projectId}/api-keys`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (result) => {
      setSecret(result.data.secret ?? "");
      setOpen(false);
      void client.invalidateQueries({ queryKey: ["api-keys", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not create the key"),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/projects/${projectId}/api-keys/${id}/revoke`, { method: "POST" }),
    onSuccess: () => {
      toast("success", "API key revoked");
      void client.invalidateQueries({ queryKey: ["api-keys", projectId] });
    },
  });
  if (!projectId) return <EmptyState title="Choose a project" body="API keys are bound to one project." />;
  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">API keys</h1>
          <p className="text-[13px] text-muted">Only a SHA-256 hash is stored. The full secret is shown once. Edit changes the label and keeps that secret. Scopes changes what the same secret can do. Expiry moves or clears the date and keeps that secret. A key can expire after 1 to 365 days, or stay valid until it is revoked.</p>
        </div>
        <Button onClick={() => setOpen(true)}>Create key</Button>
      </div>
      {secret ? (
        <Card className="border-warning/40 p-4">
          <h2 className="font-semibold">Copy this secret now</h2>
          <p className="mt-1 text-[13px] text-muted">It will not be shown again. Requests use <span className="mono">Authorization: Bearer</span>.</p>
          <div className="mt-3 flex gap-2">
            <code className="mono flex-1 overflow-auto rounded-[10px] bg-bg px-3 py-2 text-[12px]">{secret}</code>
            <Button variant="secondary" onClick={() => navigator.clipboard.writeText(secret)}>Copy</Button>
          </div>
        </Card>
      ) : null}
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-left text-[13px]">
          <thead className="text-[11px] tracking-wide text-faint uppercase">
            <tr className="border-b border-line">{["Name", "Prefix", "Scopes", "Expires", "Last used", "Status", ""].map((heading) => <th key={heading} className="px-4 py-2 font-medium">{heading}</th>)}</tr>
          </thead>
          <tbody>
            {(keys.data?.data ?? []).map((key) => (
              <tr key={key.id} className="border-b border-line/70">
                <td className="px-4 py-2">
                  <div>{key.name}</div>
                  {key.description ? <div className="text-[12px] text-muted">{key.description}</div> : null}
                </td>
                <td className="mono px-4 py-2 text-[12px]">{key.prefix}…</td>
                <td className="px-4 py-2 text-muted">{key.scopes.join(", ")}</td>
                <td className="px-4 py-2 text-muted">{key.expiresAt ? formatWhen(key.expiresAt) : "Never"}</td>
                <td className="px-4 py-2 text-muted">{formatWhen(key.lastUsedAt)}</td>
                <td className="px-4 py-2 capitalize">{key.status}</td>
                <td className="px-4 py-2 text-right">
                  {key.status === "revoked" ? null : (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(key)}>Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => setScoping(key)}>Scopes</Button>
                      <Button size="sm" variant="ghost" onClick={() => setExpiring(key)}>Expiry</Button>
                      <Button size="sm" variant="danger" onClick={() => revoke.mutate(key.id)}>Revoke</Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <EditApiKey apiKey={editing} projectId={projectId} onClose={() => setEditing(null)} />
      <EditApiKeyScopes apiKey={scoping} projectId={projectId} onClose={() => setScoping(null)} />
      <EditApiKeyExpiry apiKey={expiring} projectId={projectId} onClose={() => setExpiring(null)} />
      <Dialog open={open} title="Create API key" onClose={() => setOpen(false)}>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const days = String(form.get("expiresInDays") ?? "").trim();
            create.mutate({
              name: String(form.get("name") ?? ""),
              description: String(form.get("description") ?? ""),
              scopes: SCOPES.filter((scope) => form.get(scope) === "on"),
              ...(days ? { expiresInDays: Number(days) } : {}),
            });
          }}
        >
          <Field label="Name"><TextInput name="name" required minLength={2} /></Field>
          <Field label="Description"><TextInput name="description" /></Field>
          <Field label="Expires in days">
            <TextInput name="expiresInDays" type="number" min={1} max={365} placeholder="Never" />
          </Field>
          <fieldset>
            <legend className="mb-2 text-[12px] text-muted">Scopes</legend>
            <div className="grid grid-cols-2 gap-2 text-[13px]">
              {SCOPES.map((scope) => (
                <label key={scope} className="flex items-center gap-2">
                  <input type="checkbox" name={scope} defaultChecked />
                  {scope}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex justify-end"><Button type="submit" loading={create.isPending}>Create</Button></div>
        </form>
      </Dialog>
    </div>
  );
}

function EditApiKeyScopes({ apiKey, projectId, onClose }: { apiKey: ApiKey | null; projectId: string; onClose: () => void }) {
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!apiKey) return;
    setSelected(apiKey.scopes);
    setError("");
  }, [apiKey]);
  const save = useMutation({
    mutationFn: () => api<ApiKey>(`/projects/${projectId}/api-keys/${apiKey?.id}`, {
      method: "PATCH",
      body: JSON.stringify({ scopes: SCOPES.filter((scope) => selected.includes(scope)) }),
    }),
    onSuccess: () => {
      toast("success", "API key scopes updated");
      setError("");
      onClose();
      void client.invalidateQueries({ queryKey: ["api-keys", projectId] });
    },
    onError: (reason) => setError(reason instanceof ApiError ? reason.message : "Could not update the scopes"),
  });
  return (
    <Dialog open={Boolean(apiKey)} title="Edit scopes" description="The secret and the key id stay. Callers keep the same key, with these scopes." onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (selected.length === 0) {
            setError("Choose at least one scope");
            return;
          }
          save.mutate();
        }}
      >
        <fieldset>
          <legend className="mb-2 text-[12px] text-muted">Scopes</legend>
          <div className="grid grid-cols-2 gap-2 text-[13px]">
            {SCOPES.map((scope) => (
              <label key={scope} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name={scope}
                  checked={selected.includes(scope)}
                  onChange={(event) => {
                    setSelected((current) => event.target.checked ? [...current, scope] : current.filter((item) => item !== scope));
                  }}
                />
                {scope}
              </label>
            ))}
          </div>
        </fieldset>
        {error ? <p className="text-[12px] text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.isPending}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}

function EditApiKeyExpiry({ apiKey, projectId, onClose }: { apiKey: ApiKey | null; projectId: string; onClose: () => void }) {
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const [days, setDays] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!apiKey) return;
    setDays("");
    setError("");
  }, [apiKey]);
  const save = useMutation({
    mutationFn: () => api<ApiKey>(`/projects/${projectId}/api-keys/${apiKey?.id}`, {
      method: "PATCH",
      body: JSON.stringify({ expiresInDays: days.trim() === "" ? null : Number(days) }),
    }),
    onSuccess: () => {
      toast("success", "API key expiry updated");
      setError("");
      onClose();
      void client.invalidateQueries({ queryKey: ["api-keys", projectId] });
    },
    onError: (reason) => setError(reason instanceof ApiError ? reason.message : "Could not update the expiry"),
  });
  return (
    <Dialog open={Boolean(apiKey)} title="Edit expiry" description="The secret and the key id stay. Leave this empty and the key stays valid until it is revoked. A number from 1 to 365 sets a new expiry from now." onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (days.trim() !== "" && (!Number.isInteger(Number(days)) || Number(days) < 1 || Number(days) > 365)) {
            setError("Use a whole number from 1 to 365, or leave the field empty");
            return;
          }
          save.mutate();
        }}
      >
        {apiKey?.expiresAt ? <p className="text-[12px] text-muted">Currently expires {formatWhen(apiKey.expiresAt)}.</p> : <p className="text-[12px] text-muted">This key does not expire.</p>}
        <Field label="Expires in days">
          <TextInput value={days} onChange={(event) => setDays(event.target.value)} aria-label="Expires in days" inputMode="numeric" placeholder="Never" />
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

function EditApiKey({ apiKey, projectId, onClose }: { apiKey: ApiKey | null; projectId: string; onClose: () => void }) {
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!apiKey) return;
    setName(apiKey.name);
    setDescription(apiKey.description);
    setError("");
  }, [apiKey]);
  const save = useMutation({
    mutationFn: () => api<ApiKey>(`/projects/${projectId}/api-keys/${apiKey?.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name, description }),
    }),
    onSuccess: () => {
      toast("success", "API key renamed");
      setError("");
      onClose();
      void client.invalidateQueries({ queryKey: ["api-keys", projectId] });
    },
    onError: (reason) => setError(reason instanceof ApiError ? reason.message : "Could not rename the key"),
  });
  return (
    <Dialog open={Boolean(apiKey)} title="Rename API key" description="The secret, prefix, and scopes stay. Callers keep using the same key." onClose={onClose}>
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
        <Field label="Name">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} aria-label="API key name" required minLength={2} />
        </Field>
        <Field label="Description">
          <TextInput value={description} onChange={(event) => setDescription(event.target.value)} aria-label="API key description" placeholder="Optional" />
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

export function DocsPage() {
  const projectId = useSession((state) => state.projectId);
  const rows = [
    ["POST", "/auth/register", "Create an account and a refresh cookie"],
    ["POST", "/auth/login", "Start a session"],
    ["POST", "/auth/refresh", "Rotate the refresh token and return an access token"],
    ["POST", "/projects", "Create a project and its default queues"],
    ["POST", "/projects/:id/api-keys", "Create a key, optionally expiring in 1–365 days"],
    ["POST", "/projects/:id/jobs", "Submit a job. Returns before execution."],
    ["GET", "/projects/:id/jobs", "List jobs by created-at window or idempotency key"],
    ["GET", "/projects/:id/jobs/:jobId", "Read status, result, and error"],
    ["POST", "/projects/:id/jobs/:jobId/retry", "Retry a failed job"],
    ["POST", "/projects/:id/jobs/:jobId/replay", "Queue a new copy of a job"],
    ["POST", "/projects/:id/jobs/:jobId/promote", "Run a delayed job now"],
    ["POST", "/projects/:id/jobs/promote-delayed", "Run up to 50 delayed jobs now and keep their ids"],
    ["POST", "/projects/:id/jobs/:jobId/reschedule", "Give a waiting or delayed job a new delay"],
    ["POST", "/projects/:id/jobs/:jobId/priority", "Change the priority of a waiting or delayed job"],
    ["POST", "/projects/:id/jobs/:jobId/queue", "Move a waiting or delayed job to another queue"],
    ["POST", "/projects/:id/jobs/:jobId/dismiss", "Take a failed job off the dead letter list"],
    ["POST", "/projects/:id/jobs/:jobId/restore", "Put a dismissed job back on the dead letter list"],
    ["POST", "/projects/:id/jobs/retry-failed", "Retry up to 50 failed jobs that are still listed"],
    ["POST", "/projects/:id/jobs/dismiss-failed", "Take up to 50 failed jobs off the dead letter list"],
    ["POST", "/projects/:id/jobs/restore-dismissed", "Put up to 50 dismissed jobs back on the dead letter list"],
    ["POST", "/projects/:id/jobs/cancel-queued", "Cancel up to 50 waiting or delayed jobs"],
    ["POST", "/projects/:id/schedules", "Create a recurring schedule"],
    ["PATCH", "/projects/:id/schedules/:scheduleId", "Change a schedule and keep its id"],
    ["POST", "/projects/:id/schedules/:scheduleId/run", "Queue one occurrence now"],
    ["POST", "/projects/:id/schedules/:scheduleId/pause", "Stop future occurrences"],
    ["POST", "/projects/:id/workflows", "Create a workflow of dependent jobs"],
    ["PATCH", "/projects/:id/workflows/:workflowId", "Change a workflow name or its steps and keep its id"],
    ["POST", "/projects/:id/workflows/:workflowId/pause", "Stop new runs and keep the workflow"],
    ["POST", "/projects/:id/workflows/:workflowId/runs", "Start one run of that workflow"],
    ["POST", "/projects/:id/workflows/:workflowId/runs/:runId/cancel", "Cancel the steps that are still waiting"],
    ["POST", "/projects/:id/alerts/rules", "Create a backlog, failure, offline, or long-running alert"],
    ["PATCH", "/projects/:id/alerts/rules/:ruleId", "Change an alert rule and keep its id"],
    ["POST", "/projects/:id/alerts/rules/:ruleId/silence", "Skip a rule until a chosen time"],
    ["POST", "/projects/:id/alerts/resolve-open", "Resolve up to 50 open alerts and keep their ids"],
    ["POST", "/projects/:id/alerts/:alertId/resolve", "Mark an alert resolved"],
    ["POST", "/projects/:id/webhooks", "Register a signed outbound endpoint"],
    ["PATCH", "/projects/:id/webhooks/:webhookId", "Change a webhook URL or its events"],
    ["POST", "/projects/:id/webhooks/:webhookId/test", "Queue a signed test delivery"],
    ["POST", "/projects/:id/webhooks/:webhookId/deliveries/:deliveryId/redeliver", "Queue the same delivery again"],
    ["POST", "/projects/:id/webhooks/redeliver-failed", "Queue up to 50 failed deliveries again and keep their ids"],
    ["POST", "/projects/:id/members", "Add an existing account to the project"],
    ["POST", "/projects/:id/members/transfer", "Make a member the project owner"],
    ["GET", "/projects/:id/billing", "Read this month's job allowance"],
    ["PATCH", "/projects/:id", "Change project settings, including job retention"],
    ["POST", "/projects/:id/webhooks/:webhookId/rotate", "Replace the signing secret"],
    ["PATCH", "/projects/:id/api-keys/:keyId", "Change an API key's name, scopes, or expiry and keep its secret"],
    ["POST", "/projects/:id/queues/:queueId/pause", "Stop workers from taking new jobs"],
    ["DELETE", "/projects/:id/queues/:queueId", "Remove an empty queue that nothing still uses"],
  ];
  return (
    <div className="space-y-4">
      <h1 className="text-[28px] font-semibold tracking-tight">API documentation</h1>
      <p className="max-w-2xl text-[13px] leading-5 text-muted">
        Base path <span className="mono text-ink">/api/v1</span>. Browser sessions send the access token as a bearer token. Automation sends an API key the same way.
        Send <span className="mono text-ink">Idempotency-Key</span> when a client retry must not create a second job.
      </p>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-[13px]">
          <tbody>
            {rows.map(([method, path, purpose]) => (
              <tr key={path} className="border-b border-line/70">
                <td className="px-4 py-2 font-medium text-accent">{method}</td>
                <td className="mono px-4 py-2 text-[12px]">/api/v1{path}</td>
                <td className="px-4 py-2 text-muted">{purpose}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card className="p-4">
        <h2 className="font-semibold">Submit a job</h2>
        <pre className="mono mt-3 overflow-auto text-[12px] leading-5 text-ink/90">{`curl -X POST /api/v1/projects/${projectId ?? "proj_..."}/jobs \\
  -H "Authorization: Bearer $TASKFLOW_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: welcome-user-123" \\
  -d '{
    "queue": "emails",
    "name": "send-email",
    "payload": {
      "to": "user@example.com",
      "subject": "Welcome",
      "body": "Glad you are here."
    }
  }'`}</pre>
      </Card>
      <Card className="p-4">
        <h2 className="font-semibold">TypeScript client</h2>
        <p className="mt-2 text-[13px] leading-5 text-muted">
          <span className="mono text-ink">@taskflow/sdk</span> uses an API key. <span className="mono text-ink">jobs.create</span> returns when the job is accepted. <span className="mono text-ink">jobs.wait</span> polls until that job is completed, failed, or cancelled. A read is retried after a transient failure. A create is retried only when it has an idempotency key.
        </p>
        <pre className="mono mt-3 overflow-auto text-[12px] leading-5 text-ink/90">{`import { TaskFlow } from "@taskflow/sdk";

const taskflow = new TaskFlow({
  apiKey: process.env.TASKFLOW_API_KEY,
  baseUrl: "http://127.0.0.1:4000/api/v1",
});

const accepted = await taskflow.jobs.create({
  queue: "emails",
  name: "send-email",
  payload: { to: "user@example.com", subject: "Welcome", body: "Glad you are here." },
  idempotencyKey: "welcome-user-123",
});

const finished = await taskflow.jobs.wait(accepted.data.id);
console.log(finished.data.status, finished.data.result);`}</pre>
      </Card>
    </div>
  );
}

export function ProjectSettingsPage() {
  const projectId = useSession((state) => state.projectId);
  const setProjectId = useSession((state) => state.setProjectId);
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const project = useQuery({
    queryKey: ["project", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api<Project>(`/projects/${projectId}`),
  });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Project>(`/projects/${projectId}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      toast("success", "Project saved");
      void client.invalidateQueries({ queryKey: ["project", projectId] });
      void client.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (reason) => toast("error", reason instanceof Error ? reason.message : "Could not save"),
  });
  const remove = useMutation({
    mutationFn: () => api(`/projects/${projectId}`, { method: "DELETE" }),
    onSuccess: () => {
      setProjectId(null);
      toast("success", "Project deleted");
      void client.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  if (!project.data) return <EmptyState title="No project selected" body="Create a project from the dashboard." />;
  const data = project.data.data;
  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-[28px] font-semibold tracking-tight">Project settings</h1>
      {data.role === "member" ? <p className="text-[13px] text-muted">You are a member of this project. Only the owner can change these settings or delete it.</p> : null}
      <Card className="p-4">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            save.mutate({
              name: String(form.get("name") ?? ""),
              description: String(form.get("description") ?? ""),
              environment: String(form.get("environment") ?? data.environment),
              jobRetentionDays: Number(form.get("jobRetentionDays")),
              defaultJobSettings: {
                maxAttempts: Number(form.get("maxAttempts")),
                backoffType: String(form.get("backoffType")),
                backoffDelayMs: Number(form.get("backoffDelayMs")),
                timeoutMs: Number(form.get("timeoutMs")),
                priority: String(form.get("priority")),
              },
            });
          }}
        >
          <Field label="Name"><TextInput name="name" defaultValue={data.name} required /></Field>
          <Field label="Description"><TextInput name="description" defaultValue={data.description} /></Field>
          <Field label="Environment">
            <select name="environment" defaultValue={data.environment} className="h-10 w-full rounded-[10px] border border-line bg-bg px-3">
              <option value="development">Development</option>
              <option value="production">Production</option>
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Default attempts"><TextInput name="maxAttempts" defaultValue={String(data.defaultJobSettings.maxAttempts)} /></Field>
            <Field label="Default priority">
              <select name="priority" defaultValue={data.defaultJobSettings.priority} className="h-10 w-full rounded-[10px] border border-line bg-bg px-3">
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </Field>
            <Field label="Backoff">
              <select name="backoffType" defaultValue={data.defaultJobSettings.backoffType} className="h-10 w-full rounded-[10px] border border-line bg-bg px-3">
                <option value="exponential">Exponential</option>
                <option value="fixed">Fixed</option>
              </select>
            </Field>
            <Field label="Backoff base ms"><TextInput name="backoffDelayMs" defaultValue={String(data.defaultJobSettings.backoffDelayMs)} /></Field>
            <Field label="Timeout ms"><TextInput name="timeoutMs" defaultValue={String(data.defaultJobSettings.timeoutMs)} /></Field>
            <Field label="Keep finished jobs (days)">
              <TextInput name="jobRetentionDays" type="number" min={1} max={365} defaultValue={String(data.jobRetentionDays ?? 30)} />
            </Field>
          </div>
          <p className="text-[12px] text-muted">Finished, failed, and cancelled jobs older than this are deleted by the scheduler. Waiting and active jobs stay. Usage: {data.usage?.jobs ?? 0} jobs · {data.usage?.failedJobs ?? 0} failed · {data.usage?.activeKeys ?? 0} active keys</p>
          {data.role === "member" ? null : <Button type="submit" loading={save.isPending}>Save</Button>}
        </form>
      </Card>
      {data.role === "member" ? null : <Card className="border-danger/40 p-4">
        <h2 className="font-semibold">Delete project</h2>
        <p className="mt-1 text-[13px] text-muted">Queues are paused and hidden. Finished jobs are still deleted once they pass the retention window.</p>
        <Button className="mt-3" variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>Delete project</Button>
      </Card>}
    </div>
  );
}

export function AccountPage() {
  const user = useSession((state) => state.user);
  const clear = useSession((state) => state.clear);
  const setSession = useSession((state) => state.setSession);
  const accessToken = useSession((state) => state.accessToken);
  const toast = useUi((state) => state.toast);
  return (
    <div className="max-w-lg space-y-4">
      <h1 className="text-[28px] font-semibold tracking-tight">Account</h1>
      <Card className="space-y-3 p-4">
        <form
          className="space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            const name = String(new FormData(event.currentTarget).get("name") ?? "");
            const updated = await api<typeof user>("/auth/me", { method: "PATCH", body: JSON.stringify({ name }) });
            if (updated.data && accessToken) setSession(updated.data, accessToken);
            toast("success", "Profile updated");
          }}
        >
          <Field label="Name"><TextInput name="name" defaultValue={user?.name} required /></Field>
          <Field label="Email"><TextInput value={user?.email ?? ""} disabled /></Field>
          <Button type="submit">Save profile</Button>
        </form>
      </Card>
      <Card className="space-y-3 p-4">
        <h2 className="font-semibold">Change password</h2>
        <form
          className="space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            try {
              await api("/auth/change-password", {
                method: "POST",
                body: JSON.stringify({
                  currentPassword: String(form.get("currentPassword") ?? ""),
                  newPassword: String(form.get("newPassword") ?? ""),
                }),
              });
              clear();
              toast("success", "Password updated. Sign in again.");
            } catch (reason) {
              toast("error", reason instanceof Error ? reason.message : "Could not change the password");
            }
          }}
        >
          <Field label="Current password"><TextInput name="currentPassword" type="password" required /></Field>
          <Field label="New password"><TextInput name="newPassword" type="password" required minLength={10} /></Field>
          <Button type="submit" variant="secondary">Update password</Button>
        </form>
      </Card>
      <Button
        variant="ghost"
        onClick={async () => {
          await api("/auth/logout", { method: "POST" });
          clear();
        }}
      >
        Log out
      </Button>
    </div>
  );
}
