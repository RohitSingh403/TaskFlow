import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, api } from "@/lib/api";
import { useSession, useUi } from "@/stores/session";
import { Button, Card, EmptyState, Field, SelectInput } from "@/components/ui";

interface Billing {
  plan: "developer" | "scale";
  allowance: number;
  used: number;
  periodStart: string;
  periodEnd: string;
  plans: { id: "developer" | "scale"; allowance: number }[];
}

export function BillingPage() {
  const projectId = useSession((state) => state.projectId);
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const billing = useQuery({
    queryKey: ["billing", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api<Billing>(`/projects/${projectId}/billing`),
  });
  const project = useQuery({
    queryKey: ["project", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api<{ role?: "owner" | "member" }>(`/projects/${projectId}`),
  });
  const current = billing.data?.data;
  const [plan, setPlan] = useState<Billing["plan"] | "">("");
  const selected = plan || current?.plan || "developer";
  const save = useMutation({
    mutationFn: () => api<Billing>(`/projects/${projectId}/billing`, {
      method: "PATCH",
      body: JSON.stringify({ plan: selected }),
    }),
    onSuccess: () => {
      toast("success", "Plan updated");
      setPlan("");
      void client.invalidateQueries({ queryKey: ["billing", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not update the plan"),
  });

  if (!projectId) return <EmptyState title="Choose a project" body="Usage belongs to a project." />;
  if (billing.isError) return <EmptyState title="Billing unavailable" body="The request failed. Refresh once the API is reachable." />;
  if (!current) return <EmptyState title="Loading usage" body="Reading this month's jobs." />;
  const owner = project.data?.data.role === "owner";
  const month = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(current.periodStart));
  const width = current.allowance === 0 ? 0 : Math.min(100, Math.round((current.used / current.allowance) * 100));
  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h1 className="text-[28px] font-semibold tracking-tight">Billing</h1>
        <p className="text-[13px] text-muted">
          Each job created in {month} counts toward the monthly allowance. TaskFlow does not collect a card payment.
        </p>
      </div>
      <Card className="space-y-3 p-4">
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="text-[12px] text-muted">Jobs this month</div>
            <div className="text-[28px] font-semibold tracking-tight">{current.used.toLocaleString()} <span className="text-[14px] font-normal text-muted">/ {current.allowance.toLocaleString()}</span></div>
          </div>
          <div className="text-[13px] capitalize text-muted">{current.plan}</div>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-white/10">
          <div className="h-full bg-accent" style={{ width: `${width}%` }} />
        </div>
        <p className="text-[12px] text-muted">The count resets at {new Date(current.periodEnd).toISOString()}.</p>
      </Card>
      {owner ? (
        <Card className="space-y-3 p-4">
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
            <Field label="Plan">
              <SelectInput aria-label="Plan" value={selected} onChange={(event) => setPlan(event.target.value as Billing["plan"])}>
                <option value="developer">Developer · {current.plans.find((item) => item.id === "developer")?.allowance.toLocaleString()} jobs</option>
                <option value="scale">Scale · {current.plans.find((item) => item.id === "scale")?.allowance.toLocaleString()} jobs</option>
              </SelectInput>
            </Field>
            <Button type="submit" loading={save.isPending}>Save plan</Button>
          </form>
        </Card>
      ) : project.data?.data.role === "member" ? <p className="text-[13px] text-muted">Only the owner can change the plan.</p> : null}
    </div>
  );
}
