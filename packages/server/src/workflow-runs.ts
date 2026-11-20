import { JobRecord, WorkflowRun } from "./models.js";

export async function syncWorkflowRun(workflowRunId: string | undefined) {
  if (!workflowRunId) return;
  const run = await WorkflowRun.findOne({ publicId: workflowRunId });
  if (!run) return;
  const jobs = await JobRecord.find({ workflowRunId });
  const failed = jobs.find((job) => job.status === "failed");
  const completed = jobs.filter((job) => job.status === "completed").length;
  const active = jobs.some((job) => job.status === "active");
  const status = failed ? "failed" : jobs.length > 0 && completed === jobs.length ? "completed" : active ? "active" : "waiting";
  run.status = status;
  run.failedStepKey = failed?.workflowStepKey;
  if (status === "completed" || status === "failed") {
    const finished = jobs
      .map((job) => job.completedAt?.getTime())
      .filter((value): value is number => typeof value === "number");
    const completedAt = new Date(finished.length > 0 ? Math.max(...finished) : Date.now());
    run.completedAt = completedAt;
    run.durationMs = completedAt.getTime() - run.startedAt.getTime();
  } else {
    run.set("completedAt", undefined);
    run.set("durationMs", undefined);
    run.set("failedStepKey", undefined);
  }
  await run.save();
}
