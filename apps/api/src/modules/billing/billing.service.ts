import { AuditLog, billingPlan, monthWindow, monthlyJobCount, planAllowance, type ProjectDoc } from "@taskflow/server";
import { PLAN_JOB_ALLOWANCE, type BillingPlan } from "@taskflow/shared";
import type { AuthContext } from "../../types.js";

export async function getBilling(project: ProjectDoc, now = new Date()) {
  const plan = billingPlan(project.plan);
  const window = monthWindow(now);
  return {
    plan,
    allowance: planAllowance(project.plan),
    used: await monthlyJobCount(project._id, now),
    periodStart: window.start.toISOString(),
    periodEnd: window.end.toISOString(),
    plans: (Object.entries(PLAN_JOB_ALLOWANCE) as [BillingPlan, number][]).map(([id, allowance]) => ({ id, allowance })),
  };
}

export async function updateBilling(project: ProjectDoc, plan: BillingPlan, auth: AuthContext) {
  project.plan = plan;
  await project.save();
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "billing.updated",
    targetType: "project",
    targetId: project.publicId,
    metadata: { plan },
  });
  return getBilling(project);
}
