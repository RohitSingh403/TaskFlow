import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { HandlerInfo, Job, Queue } from "@/lib/types";
import { useSession, useUi } from "@/stores/session";
import { Button, Dialog, Field, SelectInput, TextArea, TextInput } from "./ui";

export function JobDialog() {
  const open = useUi((state) => state.submitOpen);
  const close = useUi((state) => state.closeSubmit);
  const toast = useUi((state) => state.toast);
  const projectId = useSession((state) => state.projectId);
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
  const [handler, setHandler] = useState("send-email");
  const [queue, setQueue] = useState("emails");
  const [payload, setPayload] = useState("");
  const [priority, setPriority] = useState("medium");
  const [maxAttempts, setMaxAttempts] = useState("3");
  const [backoffType, setBackoffType] = useState("exponential");
  const [backoffDelayMs, setBackoffDelayMs] = useState("5000");
  const [delayMs, setDelayMs] = useState("0");
  const [timeoutMs, setTimeoutMs] = useState("30000");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const selected = handlers.data?.data.find((item) => item.name === handler);
    if (selected && open) {
      setPayload(JSON.stringify(selected.example, null, 2));
      if ((queues.data?.data ?? []).some((item) => item.name === selected.suggestedQueue)) setQueue(selected.suggestedQueue);
    }
  }, [handler, handlers.data, open, queues.data]);

  const submit = useMutation({
    mutationFn: async () => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        throw new ApiError(400, "VALIDATION_ERROR", "Payload must be valid JSON");
      }
      return api<Job>(`/projects/${projectId}/jobs`, {
        method: "POST",
        body: JSON.stringify({
          queue,
          name: handler,
          payload: parsed,
          priority,
          maxAttempts: Number(maxAttempts),
          backoffType,
          backoffDelayMs: Number(backoffDelayMs),
          delayMs: Number(delayMs),
          timeoutMs: Number(timeoutMs),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        }),
      });
    },
    onSuccess: (result) => {
      toast(result.data.duplicate ? "warning" : "success", result.data.duplicate ? `Replayed ${result.data.id}` : `Submitted ${result.data.id}`);
      void client.invalidateQueries({ queryKey: ["jobs", projectId] });
      void client.invalidateQueries({ queryKey: ["overview", projectId] });
      close();
      setError("");
    },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "Could not submit the job"),
  });

  return (
    <Dialog open={open} onClose={close} title="Submit job" description="The API returns immediately. A worker executes the trusted handler later.">
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          submit.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Handler">
            <SelectInput value={handler} onChange={(event) => setHandler(event.target.value)}>
              {(handlers.data?.data ?? [{ name: "send-email", title: "Send email" }]).map((item) => (
                <option key={item.name} value={item.name}>
                  {item.title}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field label="Queue">
            <SelectInput value={queue} onChange={(event) => setQueue(event.target.value)}>
              {(queues.data?.data ?? []).map((item) => (
                <option key={item.id} value={item.name}>
                  {item.name}
                </option>
              ))}
            </SelectInput>
          </Field>
        </div>
        <Field label="Payload">
          <TextArea value={payload} onChange={(event) => setPayload(event.target.value)} spellCheck={false} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Priority">
            <SelectInput value={priority} onChange={(event) => setPriority(event.target.value)}>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </SelectInput>
          </Field>
          <Field label="Max attempts">
            <TextInput value={maxAttempts} onChange={(event) => setMaxAttempts(event.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Timeout (ms)">
            <TextInput value={timeoutMs} onChange={(event) => setTimeoutMs(event.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Backoff">
            <SelectInput value={backoffType} onChange={(event) => setBackoffType(event.target.value)}>
              <option value="exponential">Exponential</option>
              <option value="fixed">Fixed</option>
            </SelectInput>
          </Field>
          <Field label="Backoff base (ms)">
            <TextInput value={backoffDelayMs} onChange={(event) => setBackoffDelayMs(event.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Delay (ms)">
            <TextInput value={delayMs} onChange={(event) => setDelayMs(event.target.value)} inputMode="numeric" />
          </Field>
        </div>
        <Field label="Idempotency key">
          <TextInput value={idempotencyKey} onChange={(event) => setIdempotencyKey(event.target.value)} placeholder="Optional, 8–200 characters" />
        </Field>
        {error ? <p className="text-[13px] text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" loading={submit.isPending}>
            Submit
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
