import { listJobsQuerySchema, retryFailedJobsSchema, submitJobSchema } from "@taskflow/shared";
import { Router } from "express";
import { toJob } from "../../dto.js";
import { sendCreated, sendOk } from "../../http.js";
import { requireAuth } from "../../middleware/auth.js";
import { asyncHandler, readQuery, requireScope, validateBody, validateQuery } from "../../middleware/common.js";
import { loadProject } from "../../middleware/project.js";
import { readLimiter, writeLimiter } from "../../rate-limit.js";
import { cancelJob, getJob, listAttempts, listJobs, removeJob, retryFailedJobs, retryJob, submitJob } from "./jobs.service.js";
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
