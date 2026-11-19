import { analyticsQuerySchema, resolveTimeRange } from "@taskflow/shared";
import { Router } from "express";
import { AppError } from "../../errors.js";
import { sendOk } from "../../http.js";
import { requireAuth } from "../../middleware/auth.js";
import { asyncHandler, readQuery, requireScope, validateQuery } from "../../middleware/common.js";
import { loadProject } from "../../middleware/project.js";
import { readLimiter } from "../../rate-limit.js";
import { analyticsOverview, failureBreakdown, latencySeries, throughput } from "./analytics.service.js";

export const analyticsRouter = Router({ mergeParams: true });

analyticsRouter.use(requireAuth, loadProject, readLimiter, requireScope("analytics:read"));

function rangeFrom(req: Parameters<typeof readQuery<{ range?: string; from?: string; to?: string }>>[0]) {
  try {
    return resolveTimeRange(readQuery(req));
  } catch {
    throw new AppError(400, "VALIDATION_ERROR", "The requested time range is invalid");
  }
}

analyticsRouter.get(
  "/overview",
  validateQuery(analyticsQuerySchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await analyticsOverview(req.project!, rangeFrom(req)));
  }),
);

analyticsRouter.get(
  "/throughput",
  validateQuery(analyticsQuerySchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await throughput(req.project!, rangeFrom(req)));
  }),
);

analyticsRouter.get(
  "/latency",
  validateQuery(analyticsQuerySchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await latencySeries(req.project!, rangeFrom(req)));
  }),
);

analyticsRouter.get(
  "/failures",
  validateQuery(analyticsQuerySchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await failureBreakdown(req.project!, rangeFrom(req)));
  }),
);
