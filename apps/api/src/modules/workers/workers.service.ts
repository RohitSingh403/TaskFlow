import { JobAttempt, JobRecord, WorkerRecord, type ProjectDoc } from "@taskflow/server";
import { AppError } from "../../errors.js";

export async function listWorkers(project: ProjectDoc) {
  return WorkerRecord.find({ "assignments.projectPublicId": project.publicId }).sort({ lastHeartbeatAt: -1 });
}

export async function getWorker(project: ProjectDoc, workerId: string) {
  const worker = await WorkerRecord.findOne({
    workerId,
    "assignments.projectPublicId": project.publicId,
  });
  if (!worker) throw new AppError(404, "WORKER_NOT_FOUND", "Worker not found for this project");
  return worker;
}

export async function workerJobs(project: ProjectDoc, workerId: string) {
  await getWorker(project, workerId);
  const attempts = await JobAttempt.find({ projectId: project._id, workerId }).sort({ startedAt: -1 }).limit(50).lean();
  const jobIds = [...new Set(attempts.map((attempt) => String(attempt.jobId)))];
  const jobs = await JobRecord.find({ _id: { $in: jobIds } }).select("publicId name queueName status").lean();
  const byId = new Map(jobs.map((job) => [String(job._id), job]));
  return attempts.map((attempt) => {
    const job = byId.get(String(attempt.jobId));
    return {
      jobId: job?.publicId ?? attempt.jobPublicId,
      name: job?.name ?? null,
      queue: job?.queueName ?? null,
      jobStatus: job?.status ?? null,
      attemptNumber: attempt.attemptNumber,
      status: attempt.status,
      startedAt: attempt.startedAt?.toISOString?.() ?? null,
      finishedAt: attempt.finishedAt?.toISOString?.() ?? null,
      durationMs: attempt.durationMs ?? null,
      errorMessage: attempt.errorMessage ?? null,
    };
  });
}
