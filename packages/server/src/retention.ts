import { JOB_PURGE_BATCH } from "@taskflow/shared";
import { getBullQueue } from "./bull.js";
import { JobAttempt, JobRecord, Project, WorkflowRun } from "./models.js";

const TERMINAL = ["completed", "failed", "cancelled"];

async function releaseQueueJob(bullQueueName: string, publicId: string) {
  const bullJob = await getBullQueue(bullQueueName).getJob(publicId);
  if (!bullJob) return;
  const state = await bullJob.getState();
  if (state === "active") throw new Error("active");
  await bullJob.remove();
}

export async function purgeExpiredJobs(now = new Date()) {
  const projects = await Project.find({}).select("jobRetentionDays");
  let jobs = 0;
  let runs = 0;
  for (const project of projects) {
    const days = project.jobRetentionDays >= 1 ? project.jobRetentionDays : 30;
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    const standalone = await JobRecord.find({
      projectId: project._id,
      status: { $in: TERMINAL },
      updatedAt: { $lt: cutoff },
      workflowRunId: null,
    }).limit(JOB_PURGE_BATCH);
    const removedIds = [];
    for (const job of standalone) {
      try {
        await releaseQueueJob(job.bullQueueName, job.publicId);
      } catch {
        continue;
      }
      removedIds.push(job._id);
    }
    if (removedIds.length > 0) {
      await JobAttempt.deleteMany({ jobId: { $in: removedIds } });
      await JobRecord.deleteMany({ _id: { $in: removedIds } });
      jobs += removedIds.length;
    }

    const staleRuns = await WorkflowRun.find({ projectId: project._id, updatedAt: { $lt: cutoff } }).limit(20);
    for (const run of staleRuns) {
      const steps = await JobRecord.find({ projectId: project._id, workflowRunId: run.publicId });
      const ready = steps.every((step) => TERMINAL.includes(step.status) && step.updatedAt < cutoff);
      if (!ready) continue;
      let released = true;
      for (const step of steps) {
        try {
          await releaseQueueJob(step.bullQueueName, step.publicId);
        } catch {
          released = false;
          break;
        }
      }
      if (!released) continue;
      if (steps.length > 0) {
        const stepIds = steps.map((step) => step._id);
        await JobAttempt.deleteMany({ jobId: { $in: stepIds } });
        await JobRecord.deleteMany({ _id: { $in: stepIds } });
        jobs += steps.length;
      }
      await WorkflowRun.deleteOne({ _id: run._id });
      runs += 1;
    }
  }
  return { jobs, runs };
}
