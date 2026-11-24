import { cancelQueuedJobsSchema, dismissFailedJobsSchema, listJobsQuerySchema, moveJobSchema, moveQueuedJobsSchema, promoteDelayedJobsSchema, replayJobsSchema, rescheduleJobSchema, rescheduleQueuedJobsSchema, restoreDismissedJobsSchema, retryFailedJobsSchema, submitJobSchema, updateJobPrioritySchema, updateQueuedPrioritySchema } from "@taskflow/shared";
import { Router } from "express";
import { toJob } from "../../dto.js";
import { sendCreated, sendOk } from "../../http.js";
import { requireAuth } from "../../middleware/auth.js";
import { asyncHandler, readQuery, requireScope, validateBody, validateQuery } from "../../middleware/common.js";
import { loadProject } from "../../middleware/project.js";
import { readLimiter, writeLimiter } from "../../rate-limit.js";
import { cancelJob, cancelQueuedJobs, dismissFailedJobs, dismissJob, getJob, listAttempts, listJobs, moveJob, moveQueuedJobs, promoteDelayedJobs, promoteJob, removeJob, replayFinishedJobs, replayJob, rescheduleJob, rescheduleQueuedJobs, restoreDismissedJobs, restoreJob, retryFailedJobs, retryJob, submitJob, updateJobPriority, updateQueuedPriorities } from "./jobs.service.js";
import type { JobListQuery } from "./jobs.service.js";

export const jobRouter = Router({ mergeParams: true });

jobRouter.use(requireAuth, loadProject, readLimiter);

jobRouter.post(
  "/",
  writeLimiter,
  requireScope("jobs:write"),
  (req, _res, next) => {
    const header = req.get("idempotency-key");
    if (header) req.body = { ...(req.body ?? {}), idempotencyKey: header };
    next();
  },
  validateBody(submitJobSchema),
  asyncHandler(async (req, res) => {
    const result = await submitJob(req.project!, req.body, req.auth!);
    if (result.duplicate) sendOk(res, { ...toJob(result.job), duplicate: true });
    else sendCreated(res, { ...toJob(result.job), duplicate: false });
  }),
);

jobRouter.get(
  "/",
  requireScope("jobs:read"),
  validateQuery(listJobsQuerySchema),
  asyncHandler(async (req, res) => {
    const query = readQuery<JobListQuery>(req);
    const page = await listJobs(req.project!, query);
    sendOk(
      res,
      page.jobs.map((job) => toJob(job)),
      { page: page.page, limit: page.limit, total: page.total, totalPages: page.totalPages },
    );
  }),
);

jobRouter.post(
  "/retry-failed",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(retryFailedJobsSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await retryFailedJobs(req.project!, req.body, req.auth!));
  }),
);

jobRouter.post(
  "/dismiss-failed",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(dismissFailedJobsSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await dismissFailedJobs(req.project!, req.body, req.auth!));
  }),
);

jobRouter.post(
  "/restore-dismissed",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(restoreDismissedJobsSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await restoreDismissedJobs(req.project!, req.body, req.auth!));
  }),
);

jobRouter.post(
  "/reschedule",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(rescheduleQueuedJobsSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await rescheduleQueuedJobs(req.project!, req.body, req.auth!));
  }),
);

jobRouter.post(
  "/move",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(moveQueuedJobsSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await moveQueuedJobs(req.project!, req.body, req.auth!));
  }),
);

jobRouter.post(
  "/priority",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(updateQueuedPrioritySchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await updateQueuedPriorities(req.project!, req.body, req.auth!));
  }),
);

jobRouter.post(
  "/promote-delayed",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(promoteDelayedJobsSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await promoteDelayedJobs(req.project!, req.body, req.auth!));
  }),
);

jobRouter.post(
  "/cancel-queued",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(cancelQueuedJobsSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await cancelQueuedJobs(req.project!, req.body, req.auth!));
  }),
);

jobRouter.post(
  "/replay",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(replayJobsSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await replayFinishedJobs(req.project!, req.body, req.auth!));
  }),
);

jobRouter.get(
  "/:jobId",
  requireScope("jobs:read"),
  asyncHandler(async (req, res) => {
    sendOk(res, toJob(await getJob(req.project!, String(req.params.jobId))));
  }),
);

jobRouter.get(
  "/:jobId/attempts",
  requireScope("jobs:read"),
  asyncHandler(async (req, res) => {
    sendOk(res, await listAttempts(req.project!, String(req.params.jobId)));
  }),
);

jobRouter.post(
  "/:jobId/retry",
  writeLimiter,
  requireScope("jobs:write"),
  asyncHandler(async (req, res) => {
    sendOk(res, toJob(await retryJob(req.project!, String(req.params.jobId), req.auth!)));
  }),
);

jobRouter.post(
  "/:jobId/replay",
  writeLimiter,
  requireScope("jobs:write"),
  asyncHandler(async (req, res) => {
    sendCreated(res, toJob(await replayJob(req.project!, String(req.params.jobId), req.auth!)));
  }),
);

jobRouter.post(
  "/:jobId/promote",
  writeLimiter,
  requireScope("jobs:write"),
  asyncHandler(async (req, res) => {
    sendOk(res, toJob(await promoteJob(req.project!, String(req.params.jobId), req.auth!)));
  }),
);

jobRouter.post(
  "/:jobId/reschedule",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(rescheduleJobSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, toJob(await rescheduleJob(req.project!, String(req.params.jobId), req.body, req.auth!)));
  }),
);

jobRouter.post(
  "/:jobId/priority",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(updateJobPrioritySchema),
  asyncHandler(async (req, res) => {
    sendOk(res, toJob(await updateJobPriority(req.project!, String(req.params.jobId), req.body, req.auth!)));
  }),
);

jobRouter.post(
  "/:jobId/queue",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(moveJobSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, toJob(await moveJob(req.project!, String(req.params.jobId), req.body, req.auth!)));
  }),
);

jobRouter.post(
  "/:jobId/dismiss",
  writeLimiter,
  requireScope("jobs:write"),
  asyncHandler(async (req, res) => {
    sendOk(res, toJob(await dismissJob(req.project!, String(req.params.jobId), req.auth!)));
  }),
);

jobRouter.post(
  "/:jobId/restore",
  writeLimiter,
  requireScope("jobs:write"),
  asyncHandler(async (req, res) => {
    sendOk(res, toJob(await restoreJob(req.project!, String(req.params.jobId), req.auth!)));
  }),
);

jobRouter.post(
  "/:jobId/cancel",
  writeLimiter,
  requireScope("jobs:write"),
  asyncHandler(async (req, res) => {
    sendOk(res, toJob(await cancelJob(req.project!, String(req.params.jobId), req.auth!)));
  }),
);

jobRouter.delete(
  "/:jobId",
  writeLimiter,
  requireScope("jobs:write"),
  asyncHandler(async (req, res) => {
    sendOk(res, toJob(await removeJob(req.project!, String(req.params.jobId), req.auth!)));
  }),
);
