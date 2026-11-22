import { alertRuleSchema, listAlertsQuerySchema, resolveOpenAlertsSchema, silenceAlertSchema, updateAlertRuleSchema } from "@taskflow/shared";
import { Router } from "express";
import { toAlert, toAlertRule } from "../../dto.js";
import { sendCreated, sendOk } from "../../http.js";
import { requireAuth } from "../../middleware/auth.js";
import { asyncHandler, readQuery, requireScope, validateBody, validateQuery } from "../../middleware/common.js";
import { loadProject } from "../../middleware/project.js";
import { readLimiter, writeLimiter } from "../../rate-limit.js";
import { createAlertRule, deleteAlertRule, listAlertRules, listAlerts, resolveAlert, resolveOpenAlerts, silenceAlertRule, unsilenceAlertRule, updateAlertRule } from "./alerts.service.js";

export const alertRouter = Router({ mergeParams: true });

alertRouter.use(requireAuth, loadProject, readLimiter);

alertRouter.get(
  "/rules",
  requireScope("analytics:read"),
  asyncHandler(async (req, res) => {
    sendOk(res, (await listAlertRules(req.project!)).map(toAlertRule));
  }),
);

alertRouter.post(
  "/rules",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(alertRuleSchema),
  asyncHandler(async (req, res) => {
    sendCreated(res, toAlertRule(await createAlertRule(req.project!, req.body, req.auth!)));
  }),
);

alertRouter.patch(
  "/rules/:ruleId",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(updateAlertRuleSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, toAlertRule(await updateAlertRule(req.project!, String(req.params.ruleId), req.body, req.auth!)));
  }),
);

alertRouter.post(
  "/rules/:ruleId/silence",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(silenceAlertSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, toAlertRule(await silenceAlertRule(req.project!, String(req.params.ruleId), req.body.durationMs, req.auth!)));
  }),
);

alertRouter.post(
  "/rules/:ruleId/unsilence",
  writeLimiter,
  requireScope("jobs:write"),
  asyncHandler(async (req, res) => {
    sendOk(res, toAlertRule(await unsilenceAlertRule(req.project!, String(req.params.ruleId), req.auth!)));
  }),
);

alertRouter.delete(
  "/rules/:ruleId",
  writeLimiter,
  requireScope("jobs:write"),
  asyncHandler(async (req, res) => {
    await deleteAlertRule(req.project!, String(req.params.ruleId), req.auth!);
    sendOk(res, { deleted: true });
  }),
);

alertRouter.get(
  "/",
  requireScope("analytics:read"),
  validateQuery(listAlertsQuerySchema),
  asyncHandler(async (req, res) => {
    const query = readQuery<{ status?: string; limit: number }>(req);
    sendOk(res, (await listAlerts(req.project!, query)).map(toAlert));
  }),
);

alertRouter.post(
  "/resolve-open",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(resolveOpenAlertsSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await resolveOpenAlerts(req.project!, req.body, req.auth!));
  }),
);

alertRouter.post(
  "/:alertId/resolve",
  writeLimiter,
  requireScope("jobs:write"),
  asyncHandler(async (req, res) => {
    sendOk(res, toAlert(await resolveAlert(req.project!, String(req.params.alertId), req.auth!)));
  }),
);
