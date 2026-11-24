import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { formatWhen } from "@/lib/format";
import type { WebhookDelivery, WebhookEndpoint, WebhookEventName } from "@/lib/types";
import { useSession, useUi } from "@/stores/session";
import { Button, Card, Dialog, EmptyState, Field, TextInput } from "@/components/ui";

const eventOptions: { id: WebhookEventName; label: string }[] = [
  { id: "job.completed", label: "Job completed" },
  { id: "job.failed", label: "Job failed" },
  { id: "job.cancelled", label: "Job cancelled" },
  { id: "alert.fired", label: "Alert fired" },
];

export function WebhooksPage() {
  const projectId = useSession((state) => state.projectId);
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<WebhookEndpoint | null>(null);
  const [secret, setSecret] = useState("");
  const [rotatedSecrets, setRotatedSecrets] = useState<{ webhookId: string; url: string; secret: string; secretPrefix: string }[]>([]);
  const [rotateId, setRotateId] = useState<string | null>(null);
  const listed = useQuery({
    queryKey: ["webhooks", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api<{ webhooks: WebhookEndpoint[]; deliveries: WebhookDelivery[] }>(`/projects/${projectId}/webhooks`),
    refetchInterval: 15_000,
  });
  const toggle = useMutation({
    mutationFn: (hook: WebhookEndpoint) => api<WebhookEndpoint>(`/projects/${projectId}/webhooks/${hook.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !hook.enabled }),
    }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["webhooks", projectId] }),
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not update the webhook"),
  });
  const redeliver = useMutation({
    mutationFn: (delivery: WebhookDelivery) => api<WebhookDelivery>(`/projects/${projectId}/webhooks/${delivery.webhookId}/deliveries/${delivery.id}/redeliver`, { method: "POST" }),
    onSuccess: () => {
      toast("success", "Delivery queued");
      void client.invalidateQueries({ queryKey: ["webhooks", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not send the delivery again"),
  });
  const test = useMutation({
    mutationFn: (hookId: string) => api<WebhookDelivery>(`/projects/${projectId}/webhooks/${hookId}/test`, { method: "POST" }),
    onSuccess: () => {
      toast("success", "Test delivery queued");
      void client.invalidateQueries({ queryKey: ["webhooks", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not send the test"),
  });
  const rotate = useMutation({
    mutationFn: (hookId: string) => api<WebhookEndpoint & { secret: string }>(`/projects/${projectId}/webhooks/${hookId}/rotate`, { method: "POST" }),
    onSuccess: (result) => {
      setRotateId(null);
      setSecret(result.data.secret);
      toast("success", "Signing secret replaced");
      void client.invalidateQueries({ queryKey: ["webhooks", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not rotate the secret"),
  });
  const redeliverFailed = useMutation({
    mutationFn: () => api<{ redelivered: number }>(`/projects/${projectId}/webhooks/redeliver-failed`, {
      method: "POST",
      body: JSON.stringify({ limit: 20 }),
    }),
    onSuccess: (result) => {
      toast("success", result.data.redelivered === 1 ? "Queued 1 delivery" : `Queued ${result.data.redelivered} deliveries`);
      void client.invalidateQueries({ queryKey: ["webhooks", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not send the failed deliveries again"),
  });
  const remove = useMutation({
    mutationFn: (hookId: string) => api(`/projects/${projectId}/webhooks/${hookId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast("success", "Webhook deleted");
      void client.invalidateQueries({ queryKey: ["webhooks", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not delete the webhook"),
  });
  const pauseWebhooks = useMutation({
    mutationFn: () => api<{ paused: number; skipped: number; webhookIds: string[] }>(`/projects/${projectId}/webhooks/pause`, {
      method: "POST",
      body: JSON.stringify({ limit: 20 }),
    }),
    onSuccess: (result) => {
      const count = result.data.paused;
      toast(count === 0 ? "warning" : "success", count === 1 ? "Paused 1 webhook" : `Paused ${count} webhooks`);
      void client.invalidateQueries({ queryKey: ["webhooks", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not pause webhooks"),
  });
  const resumeWebhooks = useMutation({
    mutationFn: () => api<{ resumed: number; skipped: number; webhookIds: string[] }>(`/projects/${projectId}/webhooks/resume`, {
      method: "POST",
      body: JSON.stringify({ limit: 20 }),
    }),
    onSuccess: (result) => {
      const count = result.data.resumed;
      toast(count === 0 ? "warning" : "success", count === 1 ? "Resumed 1 webhook" : `Resumed ${count} webhooks`);
      void client.invalidateQueries({ queryKey: ["webhooks", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not resume webhooks"),
  });
  const testWebhooks = useMutation({
    mutationFn: () => api<{ queued: number; skipped: number; webhookIds: string[]; deliveryIds: string[] }>(`/projects/${projectId}/webhooks/test`, {
      method: "POST",
      body: JSON.stringify({ limit: 20 }),
    }),
    onSuccess: (result) => {
      const count = result.data.queued;
      toast(count === 0 ? "warning" : "success", count === 1 ? "Queued 1 test" : `Queued ${count} tests`);
      void client.invalidateQueries({ queryKey: ["webhooks", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not send webhook tests"),
  });
  const rotateWebhooks = useMutation({
    mutationFn: () => api<{ rotated: number; skipped: number; webhookIds: string[]; secrets: { webhookId: string; url: string; secret: string; secretPrefix: string }[] }>(`/projects/${projectId}/webhooks/rotate`, {
      method: "POST",
      body: JSON.stringify({ limit: 20 }),
    }),
    onSuccess: (result) => {
      const count = result.data.rotated;
      toast(count === 0 ? "warning" : "success", count === 1 ? "Rotated 1 secret" : `Rotated ${count} secrets`);
      setRotatedSecrets(result.data.secrets);
      void client.invalidateQueries({ queryKey: ["webhooks", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not rotate webhook secrets"),
  });
  const deleteWebhooks = useMutation({
    mutationFn: () => api<{ deleted: number; skipped: number; webhookIds: string[] }>(`/projects/${projectId}/webhooks/delete`, {
      method: "POST",
      body: JSON.stringify({ limit: 20 }),
    }),
    onSuccess: (result) => {
      const count = result.data.deleted;
      toast(count === 0 ? "warning" : "success", count === 1 ? "Deleted 1 webhook" : `Deleted ${count} webhooks`);
      void client.invalidateQueries({ queryKey: ["webhooks", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not delete webhooks"),
  });

  if (!projectId) return <EmptyState title="Choose a project" body="Webhooks belong to a project." />;
  const hooks = listed.data?.data.webhooks ?? [];
  const deliveries = listed.data?.data.deliveries ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">Webhooks</h1>
          <p className="max-w-2xl text-[13px] text-muted">
            TaskFlow POSTs a signed JSON body when a selected event happens. Delivery is at least once. Edit changes the URL or events and keeps the endpoint id and signing secret. Pause webhooks stops the oldest enabled endpoints, up to 20, and keeps each endpoint id and signing secret. A webhook that is already paused is left alone. Resume webhooks starts the oldest paused endpoints again, up to 20, and keeps each endpoint id and signing secret. A webhook that is already enabled is left alone. Send test queues a webhook.test delivery without waiting for a job. A paused endpoint refuses that test. Send tests does that for the oldest enabled endpoints, up to 20, and keeps each endpoint id and signing secret. A second call queues another test. An enabled endpoint can accept it. Rotate replaces the signing secret. Rotate secrets does that for the oldest endpoints, up to 20, including a paused endpoint, and keeps each endpoint id. The new secrets are shown once. A second call replaces them again. Deliveries that have not been sent use the current URL and secret. Send again queues that same delivery id. Send failed again queues the oldest failed deliveries, up to 20. Each delivery keeps its id. Receivers should ignore a delivery id they have already handled. Delete webhooks removes the oldest endpoints, up to 20, including a paused endpoint, and keeps each endpoint id. A webhook that is already deleted is left alone. A second call deletes none of those endpoints.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" loading={pauseWebhooks.isPending} onClick={() => pauseWebhooks.mutate()}>Pause webhooks</Button>
          <Button variant="secondary" loading={resumeWebhooks.isPending} onClick={() => resumeWebhooks.mutate()}>Resume webhooks</Button>
          <Button variant="secondary" loading={testWebhooks.isPending} onClick={() => testWebhooks.mutate()}>Send tests</Button>
          <Button variant="secondary" loading={rotateWebhooks.isPending} onClick={() => rotateWebhooks.mutate()}>Rotate secrets</Button>
          <Button variant="danger" loading={deleteWebhooks.isPending} onClick={() => deleteWebhooks.mutate()}>Delete webhooks</Button>
          <Button onClick={() => setOpen(true)}>New webhook</Button>
        </div>
      </div>
      {listed.isError ? <EmptyState title="Webhooks unavailable" body="The request failed. Refresh once the API is reachable." /> : null}
      {hooks.length === 0 && !listed.isLoading ? (
        <EmptyState title="No webhooks" body="Add an HTTPS endpoint. A development project can also use localhost." action={<Button onClick={() => setOpen(true)}>New webhook</Button>} />
      ) : null}
      {hooks.length > 0 ? (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-[13px]">
            <thead className="text-[12px] text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-3 font-medium">Endpoint</th>
                <th className="px-4 py-3 font-medium">Events</th>
                <th className="px-4 py-3 font-medium">Secret</th>
                <th className="px-4 py-3 font-medium">State</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {hooks.map((hook) => (
                <tr key={hook.id} className="border-b border-line/70">
                  <td className="px-4 py-3">
                    <div className="mono text-[12px]">{hook.url}</div>
                    {hook.description ? <div className="mt-1 text-[12px] text-muted">{hook.description}</div> : null}
                  </td>
                  <td className="px-4 py-3 text-muted">{hook.events.join(", ")}</td>
                  <td className="mono px-4 py-3 text-[12px]">{hook.secretPrefix}</td>
                  <td className="px-4 py-3">{hook.enabled ? "Enabled" : "Paused"}</td>
                  <td className="px-4 py-3 text-right">
                    <button type="button" className="mr-3 text-muted hover:text-ink" onClick={() => setEditing(hook)}>Edit</button>
                    {hook.enabled ? <button type="button" className="mr-3 text-muted hover:text-ink" onClick={() => test.mutate(hook.id)}>Send test</button> : null}
                    <button type="button" className="mr-3 text-muted hover:text-ink" onClick={() => setRotateId(hook.id)}>Rotate</button>
                    <button type="button" className="mr-3 text-muted hover:text-ink" onClick={() => toggle.mutate(hook)}>{hook.enabled ? "Pause" : "Enable"}</button>
                    <button type="button" className="text-danger" onClick={() => remove.mutate(hook.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      <Card className="overflow-x-auto">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-[13px] font-medium">Recent deliveries</h2>
          <Button
            size="sm"
            variant="secondary"
            disabled={!deliveries.some((delivery) => delivery.status === "failed") || redeliverFailed.isPending}
            loading={redeliverFailed.isPending}
            onClick={() => redeliverFailed.mutate()}
          >
            Send failed again
          </Button>
        </div>
        {deliveries.length === 0 ? <p className="px-4 py-6 text-[13px] text-muted">No deliveries yet.</p> : (
          <table className="w-full min-w-[720px] text-left text-[13px]">
            <thead className="text-[12px] text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-3 font-medium">When</th>
                <th className="px-4 py-3 font-medium">Event</th>
                <th className="px-4 py-3 font-medium">Resource</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Attempts</th>
                <th className="px-4 py-3 font-medium">Last response</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery) => (
                <tr key={delivery.id} className="border-b border-line/70">
                  <td className="px-4 py-3 text-muted">{formatWhen(delivery.createdAt)}</td>
                  <td className="px-4 py-3">{delivery.event}</td>
                  <td className="mono px-4 py-3 text-[12px]">{delivery.resourceId}</td>
                  <td className="px-4 py-3 capitalize">{delivery.status}</td>
                  <td className="px-4 py-3 text-muted">{delivery.attempts.length}</td>
                  <td className="px-4 py-3 text-muted">{lastResponse(delivery)}</td>
                  <td className="px-4 py-3 text-right">
                    {delivery.status === "pending" ? null : (
                      <Button size="sm" variant="secondary" loading={redeliver.isPending} onClick={() => redeliver.mutate(delivery)}>Send again</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <EditWebhook hook={editing} projectId={projectId} onClose={() => setEditing(null)} />
      <CreateWebhook
        open={open}
        projectId={projectId}
        onClose={() => setOpen(false)}
        onCreated={(value) => {
          setOpen(false);
          setSecret(value);
          void client.invalidateQueries({ queryKey: ["webhooks", projectId] });
        }}
      />
      <Dialog open={Boolean(rotateId)} title="Rotate signing secret" description="Deliveries that have not been sent use the new secret. The previous secret stops working." onClose={() => setRotateId(null)}>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setRotateId(null)}>Keep</Button>
          <Button loading={rotate.isPending} onClick={() => rotateId && rotate.mutate(rotateId)}>Replace secret</Button>
        </div>
      </Dialog>
      <Dialog open={Boolean(secret)} title="Signing secret" description="Copy this now. Later responses only show the prefix." onClose={() => setSecret("")}>
        <p className="mono break-all rounded-[10px] border border-line bg-bg px-3 py-2 text-[12px]">{secret}</p>
        <div className="mt-4 flex justify-end"><Button onClick={() => setSecret("")}>Done</Button></div>
      </Dialog>
      <Dialog open={rotatedSecrets.length > 0} title="New signing secrets" description="Copy these now. Later responses only show the prefix. A second rotation replaces them again." onClose={() => setRotatedSecrets([])}>
        <div className="space-y-3">
          {rotatedSecrets.map((item) => (
            <div key={item.webhookId}>
              <p className="mb-1 text-[12px] text-muted">{item.url}</p>
              <p className="mono break-all rounded-[10px] border border-line bg-bg px-3 py-2 text-[12px]">{item.secret}</p>
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end"><Button onClick={() => setRotatedSecrets([])}>Done</Button></div>
      </Dialog>
    </div>
  );
}

function EditWebhook({ hook, projectId, onClose }: { hook: WebhookEndpoint | null; projectId: string; onClose: () => void }) {
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<WebhookEventName[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!hook) return;
    setUrl(hook.url);
    setDescription(hook.description);
    setEvents(hook.events);
    setError("");
  }, [hook]);
  const save = useMutation({
    mutationFn: () => api<WebhookEndpoint>(`/projects/${projectId}/webhooks/${hook?.id}`, {
      method: "PATCH",
      body: JSON.stringify({ url, description, events }),
    }),
    onSuccess: () => {
      toast("success", "Webhook updated");
      setError("");
      onClose();
      void client.invalidateQueries({ queryKey: ["webhooks", projectId] });
    },
    onError: (reason) => setError(reason instanceof ApiError ? reason.message : "Could not update the webhook"),
  });
  return (
    <Dialog open={Boolean(hook)} title="Edit webhook" description="The endpoint id and signing secret stay. The URL is checked again at delivery time." onClose={onClose}>
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
        <Field label="URL">
          <TextInput value={url} onChange={(event) => setUrl(event.target.value)} aria-label="Webhook URL" required />
        </Field>
        <Field label="Description">
          <TextInput value={description} onChange={(event) => setDescription(event.target.value)} aria-label="Webhook description" placeholder="Optional" />
        </Field>
        <fieldset className="space-y-2">
          <legend className="text-[12px] font-medium text-muted">Events</legend>
          {eventOptions.map((option) => (
            <label key={option.id} className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={events.includes(option.id)}
                onChange={(event) => {
                  setEvents((current) => event.target.checked ? [...current, option.id] : current.filter((item) => item !== option.id));
                }}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        {error ? <p className="text-[12px] text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.isPending} disabled={events.length === 0}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}

function lastResponse(delivery: WebhookDelivery) {
  const attempt = delivery.attempts.at(-1);
  if (!attempt) return "—";
  if (attempt.statusCode) return attempt.error ? `${attempt.statusCode} ${attempt.error}` : String(attempt.statusCode);
  return attempt.error ?? "—";
}

function CreateWebhook({
  open,
  projectId,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onCreated: (secret: string) => void;
}) {
  const toast = useUi((state) => state.toast);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<WebhookEventName[]>(["job.completed", "job.failed"]);
  const create = useMutation({
    mutationFn: () => api<WebhookEndpoint & { secret: string }>(`/projects/${projectId}/webhooks`, {
      method: "POST",
      body: JSON.stringify({ url, description, events }),
    }),
    onSuccess: (result) => {
      toast("success", "Webhook created");
      setUrl("");
      setDescription("");
      onCreated(result.data.secret);
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not create the webhook"),
  });
  return (
    <Dialog open={open} title="New webhook" description="The URL is checked again at delivery time. Redirects are not followed." onClose={onClose}>
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
        <Field label="URL">
          <TextInput value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/taskflow" required />
        </Field>
        <Field label="Description">
          <TextInput value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Optional" />
        </Field>
        <fieldset className="space-y-2">
          <legend className="text-[12px] font-medium text-muted">Events</legend>
          {eventOptions.map((option) => (
            <label key={option.id} className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={events.includes(option.id)}
                onChange={(event) => {
                  setEvents((current) => event.target.checked ? [...current, option.id] : current.filter((item) => item !== option.id));
                }}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        <div className="flex justify-end"><Button type="submit" loading={create.isPending} disabled={events.length === 0}>Create</Button></div>
      </form>
    </Dialog>
  );
}
