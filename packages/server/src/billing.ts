import { PLAN_JOB_ALLOWANCE, type BillingPlan } from "@taskflow/shared";
import { JobRecord } from "./models.js";

export class PlanLimitError extends Error {
  constructor(
    public allowance: number,
    public used: number,
  ) {
    super(`This project has used ${used} of ${allowance} jobs for this month`);
    this.name = "PlanLimitError";
  }
}

export function planAllowance(plan: string | undefined): number {
  if (plan !== "scale" && process.env.NODE_ENV === "test" && process.env.TASKFLOW_PLAN_ALLOWANCE) {
    const override = Number(process.env.TASKFLOW_PLAN_ALLOWANCE);
    if (Number.isFinite(override) && override >= 0) return override;
  }
  return plan === "scale" ? PLAN_JOB_ALLOWANCE.scale : PLAN_JOB_ALLOWANCE.developer;
}

export function monthWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

export async function monthlyJobCount(projectId: unknown, now = new Date()) {
  const { start, end } = monthWindow(now);
  return JobRecord.countDocuments({ projectId, createdAt: { $gte: start, $lt: end } });
}

export async function assertJobAllowance(project: { _id: unknown; plan?: string }, additional = 1, now = new Date()) {
  const allowance = planAllowance(project.plan);
  const used = await monthlyJobCount(project._id, now);
  if (used + additional > allowance) throw new PlanLimitError(allowance, used);
}

export function billingPlan(plan: string | undefined): BillingPlan {
  return plan === "scale" ? "scale" : "developer";
}
