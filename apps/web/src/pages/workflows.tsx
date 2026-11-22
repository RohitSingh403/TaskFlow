import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { HealthPill, JobStatusPill } from "@/components/status";
import { Button, Card, Dialog, EmptyState, Field, SelectInput, TextInput } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { formatDuration, formatWhen } from "@/lib/format";
import type { HandlerInfo, Job, Queue, Workflow, WorkflowRun } from "@/lib/types";
import { useSession, useUi } from "@/stores/session";

interface DraftStep {
  key: string;
  handler: string;
  queue: string;
  dependsOn: string[];
  payload: string;
}

const starter: DraftStep[] = [
  {
    key: "report",
    handler: "generate-report",
    queue: "reports",
    dependsOn: [],
    payload: JSON.stringify({ reportType: "activity", format: "pdf", rangeDays: 7 }, null, 2),
  },
  {
    key: "email",
    handler: "send-email",
    queue: "emails",
    dependsOn: ["report"],
    payload: JSON.stringify({ to: "ops@example.com", subject: "Activity report", body: "The activity report is ready." }, null, 2),
  },
];

export function WorkflowsPage() {
  const projectId = useSession((state) => state.projectId);
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Workflow | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const workflows = useQuery({
    queryKey: ["workflows", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api<Workflow[]>(`/projects/${projectId}/workflows`),
    refetchInterval: 10_000,
  });
  const remove = useMutation({
    mutationFn: (workflowId: string) => api(`/projects/${projectId}/workflows/${workflowId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast("success", "Workflow deleted");
      setRemoveId(null);
      void client.invalidateQueries({ queryKey: ["workflows", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not delete the workflow"),
  });

  if (!projectId) return <EmptyState title="Choose a project" body="Workflows belong to a project." />;
  const rows = workflows.data?.data ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">Workflows</h1>
          <p className="max-w-2xl text-[13px] text-muted">
            A workflow is a tree of jobs. Earlier steps finish before the step that waits on them. Each step can lead to only one later step. Edit changes the name or description and keeps the workflow id. Pause stops new runs and leaves the steps and runs that already started. Cancel removes the steps that are still waiting and keeps the run id.
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>New workflow</Button>
      </div>
      {workflows.isLoading ? <Card className="p-4 text-[13px] text-muted">Loading workflows…</Card> : null}
      {workflows.isError ? <EmptyState title="Workflows unavailable" body="The list request failed. Refresh once the API is reachable." /> : null}
      {!workflows.isLoading && !workflows.isError && rows.length === 0 ? (
        <EmptyState title="No workflows yet" body="Start with a report that finishes before the email that sends it." action={<Button onClick={() => setOpen(true)}>New workflow</Button>} />
      ) : null}
      {rows.length > 0 ? (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-[13px]">
            <thead className="text-[12px] text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Steps</th>
                <th className="px-4 py-3 font-medium">Last run</th>
                <th className="px-4 py-3 font-medium">Duration</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map((workflow) => (
                <tr key={workflow.id} className="border-b border-line/70">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Link className="font-medium hover:text-accent" to={`/workflows/${workflow.id}`}>{workflow.name}</Link>
                      {workflow.paused ? <HealthPill value="paused" /> : null}
                    </div>
                    <div className="text-[12px] text-muted">{workflow.executionOrder.join(" → ")}</div>
                  </td>
                  <td className="px-4 py-3">{workflow.steps.length}</td>
                  <td className="px-4 py-3">{workflow.lastRun ? <JobStatusPill status={workflow.lastRun.status} /> : "—"}</td>
                  <td className="px-4 py-3">{formatDuration(workflow.lastRun?.durationMs)}</td>
                  <td className="px-4 py-3 text-right">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(workflow)}>Edit</Button>
                    <WorkflowPause workflow={workflow} />
                    <Button variant="ghost" size="sm" onClick={() => setRemoveId(workflow.id)}>Delete</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      {open ? <CreateWorkflow onClose={() => setOpen(false)} /> : null}
      <EditWorkflow workflow={editing} onClose={() => setEditing(null)} />
      <Dialog open={Boolean(removeId)} title="Delete workflow" onClose={() => setRemoveId(null)}>
        <p className="text-[13px] text-muted">Existing runs stay in history. New runs stop being accepted.</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setRemoveId(null)}>Cancel</Button>
          <Button variant="danger" loading={remove.isPending} onClick={() => removeId && remove.mutate(removeId)}>Delete</Button>
        </div>
      </Dialog>
    </div>
  );
}

function WorkflowPause({ workflow, variant = "ghost" }: { workflow: Workflow; variant?: "ghost" | "secondary" }) {
  const projectId = useSession((state) => state.projectId);
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const toggle = useMutation({
    mutationFn: () => api<Workflow>(`/projects/${projectId}/workflows/${workflow.id}/${workflow.paused ? "resume" : "pause"}`, { method: "POST" }),
    onSuccess: () => {
      toast("success", workflow.paused ? "Workflow resumed" : "Workflow paused");
      void client.invalidateQueries({ queryKey: ["workflows", projectId] });
      void client.invalidateQueries({ queryKey: ["workflow", projectId, workflow.id] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not update the workflow"),
  });
  return (
    <Button variant={variant} size="sm" loading={toggle.isPending} onClick={() => toggle.mutate()}>
      {workflow.paused ? "Resume" : "Pause"}
    </Button>
  );
}

function EditWorkflow({ workflow, onClose }: { workflow: Workflow | null; onClose: () => void }) {
  const projectId = useSession((state) => state.projectId);
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!workflow) return;
    setName(workflow.name);
    setDescription(workflow.description);
    setError("");
  }, [workflow]);
  const save = useMutation({
    mutationFn: () => api<Workflow>(`/projects/${projectId}/workflows/${workflow?.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name, description }),
    }),
    onSuccess: () => {
      toast("success", "Workflow updated");
      setError("");
      onClose();
      void client.invalidateQueries({ queryKey: ["workflows", projectId] });
      void client.invalidateQueries({ queryKey: ["workflow", projectId, workflow?.id] });
    },
    onError: (reason) => setError(reason instanceof ApiError ? reason.message : "Could not update the workflow"),
  });
  return (
    <Dialog open={Boolean(workflow)} title="Edit workflow" description="The workflow id and steps stay. Existing runs stay on this workflow." onClose={onClose}>
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
        <Field label="Name">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} aria-label="Workflow name" required minLength={2} />
        </Field>
        <Field label="Description">
          <TextInput value={description} onChange={(event) => setDescription(event.target.value)} aria-label="Workflow description" />
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

function CreateWorkflow({ onClose }: { onClose: () => void }) {
  const projectId = useSession((state) => state.projectId);
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const [name, setName] = useState("Report then email");
  const [description, setDescription] = useState("Generate the activity report, then send it.");
  const [steps, setSteps] = useState<DraftStep[]>(starter);
  const handlers = useQuery({ queryKey: ["handlers"], queryFn: () => api<HandlerInfo[]>("/meta/handlers") });
  const queues = useQuery({
    queryKey: ["queues", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api<Queue[]>(`/projects/${projectId}/queues`),
  });
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Workflow>(`/projects/${projectId}/workflows`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      toast("success", "Workflow created");
      void client.invalidateQueries({ queryKey: ["workflows", projectId] });
      onClose();
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not create the workflow"),
  });

  function update(index: number, patch: Partial<DraftStep>) {
    setSteps((current) => current.map((step, position) => (position === index ? { ...step, ...patch } : step)));
  }

  return (
    <Dialog open title="New workflow" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = [];
          for (const step of steps) {
            try {
              parsed.push({
                key: step.key.trim(),
                handler: step.handler,
                queue: step.queue,
                dependsOn: step.dependsOn,
                payload: JSON.parse(step.payload) as Record<string, unknown>,
              });
            } catch {
              toast("error", `Payload for ${step.key || "a step"} is not valid JSON`);
              return;
            }
          }
          create.mutate({ name, description, steps: parsed });
        }}
      >
        <Field label="Name"><TextInput value={name} onChange={(event) => setName(event.target.value)} required /></Field>
        <Field label="Description"><TextInput value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
        {steps.map((step, index) => (
          <fieldset key={index} className="space-y-3 rounded-[12px] border border-line p-3">
            <div className="flex items-center justify-between">
              <legend className="text-[12px] font-medium text-muted">Step {index + 1}</legend>
              {steps.length > 2 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSteps((current) => current.filter((_, position) => position !== index).map((item) => ({
                    ...item,
                    dependsOn: item.dependsOn.filter((key) => key !== step.key),
                  })))}
                >
                  Remove
                </Button>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Key"><TextInput value={step.key} onChange={(event) => update(index, { key: event.target.value })} required /></Field>
              <Field label="Handler">
                <SelectInput value={step.handler} onChange={(event) => update(index, { handler: event.target.value })}>
                  {(handlers.data?.data ?? []).map((handler) => <option key={handler.name} value={handler.name}>{handler.title}</option>)}
                </SelectInput>
              </Field>
              <Field label="Queue">
                <SelectInput value={step.queue} onChange={(event) => update(index, { queue: event.target.value })}>
                  {(queues.data?.data ?? []).map((queue) => <option key={queue.id} value={queue.name}>{queue.name}</option>)}
                </SelectInput>
              </Field>
            </div>
            <Field label="Waits for">
              <div className="flex flex-wrap gap-3">
                {steps.filter((other) => other.key && other.key !== step.key).map((other) => (
                  <label key={other.key} className="flex items-center gap-2 text-[13px]">
                    <input
                      type="checkbox"
                      checked={step.dependsOn.includes(other.key)}
                      onChange={(event) => update(index, {
                        dependsOn: event.target.checked
                          ? [...step.dependsOn, other.key]
                          : step.dependsOn.filter((key) => key !== other.key),
                      })}
                    />
                    {other.key}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Payload">
              <textarea
                className="min-h-24 w-full rounded-[10px] border border-line bg-bg px-3 py-2 font-mono text-[12px] outline-none focus:border-accent"
                value={step.payload}
                onChange={(event) => update(index, { payload: event.target.value })}
              />
            </Field>
          </fieldset>
        ))}
        <div className="flex justify-between gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={steps.length >= 8}
            onClick={() => setSteps((current) => [...current, {
              key: `step-${current.length + 1}`,
              handler: "send-notification",
              queue: "notifications",
              dependsOn: current.at(-1)?.key ? [current.at(-1)!.key] : [],
              payload: JSON.stringify({ channel: "in-app", recipientId: "ops", message: "Workflow finished" }, null, 2),
            }])}
          >
            Add step
          </Button>
          <Button type="submit" loading={create.isPending}>Create</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function WorkflowDetailPage() {
  const { workflowId } = useParams();
  const projectId = useSession((state) => state.projectId);
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const workflow = useQuery({
    queryKey: ["workflow", projectId, workflowId],
    enabled: Boolean(projectId && workflowId),
    queryFn: () => api<Workflow>(`/projects/${projectId}/workflows/${workflowId}`),
  });
  const latestId = workflow.data?.data.lastRun?.id;
  const [selected, setSelected] = useState<string | null>(null);
  const runId = selected ?? latestId;
  const run = useQuery({
    queryKey: ["workflow-run", projectId, workflowId, runId],
    enabled: Boolean(projectId && workflowId && runId),
    queryFn: () => api<WorkflowRun>(`/projects/${projectId}/workflows/${workflowId}/runs/${runId}`),
    refetchInterval: (query) => {
      const status = query.state.data?.data.status;
      return status === "completed" || status === "failed" || status === "cancelled" ? false : 2_000;
    },
  });
  const start = useMutation({
    mutationFn: () => api<WorkflowRun>(`/projects/${projectId}/workflows/${workflowId}/runs`, { method: "POST" }),
    onSuccess: (result) => {
      setSelected(result.data.id);
      toast("success", "Workflow run started");
      void client.invalidateQueries({ queryKey: ["workflow", projectId, workflowId] });
      void client.invalidateQueries({ queryKey: ["workflows", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not start the workflow"),
  });
  const [cancelOpen, setCancelOpen] = useState(false);
  const [editing, setEditing] = useState<Workflow | null>(null);
  const cancel = useMutation({
    mutationFn: (id: string) => api<WorkflowRun>(`/projects/${projectId}/workflows/${workflowId}/runs/${id}/cancel`, { method: "POST" }),
    onSuccess: () => {
      toast("success", "Workflow run cancelled");
      setCancelOpen(false);
      void client.invalidateQueries({ queryKey: ["workflow-run", projectId, workflowId] });
      void client.invalidateQueries({ queryKey: ["workflow", projectId, workflowId] });
      void client.invalidateQueries({ queryKey: ["workflows", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not cancel the workflow"),
  });
  const retry = useMutation({
    mutationFn: (jobId: string) => api<Job>(`/projects/${projectId}/jobs/${jobId}/retry`, { method: "POST" }),
    onSuccess: () => {
      toast("success", "Failed step queued again");
      void client.invalidateQueries({ queryKey: ["workflow-run", projectId, workflowId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not retry the step"),
  });
  const ordered = useMemo(() => {
    const definition = workflow.data?.data;
    const current = run.data?.data;
    if (!definition || !current) return [];
    const byKey = new Map(current.steps.map((step) => [step.key, step]));
    return definition.executionOrder.map((key) => byKey.get(key)).filter((step): step is WorkflowRun["steps"][number] => Boolean(step));
  }, [workflow.data, run.data]);

  if (!projectId || !workflowId) return null;
  const definition = workflow.data?.data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link className="text-[12px] text-muted hover:text-ink" to="/workflows">Workflows</Link>
          <div className="flex items-center gap-2">
            <h1 className="text-[28px] font-semibold tracking-tight">{definition?.name ?? "Workflow"}</h1>
            {definition?.paused ? <HealthPill value="paused" /> : null}
          </div>
          <p className="max-w-2xl text-[13px] text-muted">{definition?.description}</p>
        </div>
        <div className="flex items-center gap-2">
          {definition ? <Button variant="secondary" onClick={() => setEditing(definition)}>Edit</Button> : null}
          {definition ? <WorkflowPause workflow={definition} variant="secondary" /> : null}
          <Button onClick={() => start.mutate()} loading={start.isPending}>Run</Button>
        </div>
      </div>
      {definition ? (
        <Card className="space-y-3 p-4">
          <h2 className="text-[14px] font-medium">Steps</h2>
          <ol className="space-y-2">
            {definition.executionOrder.map((key, index) => {
              const step = definition.steps.find((item) => item.key === key);
              if (!step) return null;
              return (
                <li key={key} className="rounded-[12px] border border-line px-3 py-2 text-[13px]">
                  <div className="font-medium">{index + 1}. {step.key}</div>
                  <div className="text-[12px] text-muted">
                    {step.handler} on {step.queue}
                    {step.dependsOn.length > 0 ? ` · waits for ${step.dependsOn.join(", ")}` : " · starts immediately"}
                  </div>
                </li>
              );
            })}
          </ol>
        </Card>
      ) : null}
      {definition && definition.runs && definition.runs.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {definition.runs.map((item) => (
            <button
              key={item.id}
              className={`rounded-full border px-3 py-1 text-[12px] ${item.id === runId ? "border-accent text-ink" : "border-line text-muted"}`}
              onClick={() => setSelected(item.id)}
            >
              {formatWhen(item.createdAt ?? item.startedAt)}
            </button>
          ))}
        </div>
      ) : null}
      {run.data?.data ? (
        <Card className="overflow-x-auto">
          <div className="flex items-center justify-between px-4 py-3">
            <h2 className="text-[14px] font-medium">Run</h2>
            <div className="flex items-center gap-2">
              {run.data.data.steps.some((step) => step.status === "waiting" || step.status === "delayed") ? (
                <Button size="sm" variant="secondary" onClick={() => setCancelOpen(true)}>Cancel</Button>
              ) : null}
              <JobStatusPill status={run.data.data.status} />
            </div>
          </div>
          <table className="w-full min-w-[720px] text-left text-[13px]">
            <thead className="text-[12px] text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2 font-medium">Step</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Duration</th>
                <th className="px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {ordered.map((step) => (
                <tr key={step.key} className="border-b border-line/70">
                  <td className="px-4 py-3">
                    <Link className="font-medium hover:text-accent" to={`/jobs/${step.jobId}`}>{step.key}</Link>
                    <div className="text-[12px] text-muted">{step.error ?? (step.dependsOn.length > 0 ? `After ${step.dependsOn.join(", ")}` : "First step")}</div>
                  </td>
                  <td className="px-4 py-3"><JobStatusPill status={step.status} /></td>
                  <td className="px-4 py-3">{formatDuration(step.durationMs)}</td>
                  <td className="px-4 py-3 text-right">
                    {step.status === "failed" ? (
                      <Button size="sm" variant="secondary" loading={retry.isPending} onClick={() => retry.mutate(step.jobId)}>Retry</Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <EmptyState title="No run yet" body="Run the workflow to create one job per step. Later steps stay waiting until the steps they depend on complete." />
      )}
      <EditWorkflow workflow={editing} onClose={() => setEditing(null)} />
      <Dialog open={cancelOpen} title="Cancel this run" description="Waiting and delayed steps are removed from their queues. Completed and failed steps stay. A step that is already running cannot be cancelled." onClose={() => setCancelOpen(false)}>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setCancelOpen(false)}>Keep</Button>
          <Button variant="danger" loading={cancel.isPending} onClick={() => runId && cancel.mutate(runId)}>Cancel run</Button>
        </div>
      </Dialog>
    </div>
  );
}
