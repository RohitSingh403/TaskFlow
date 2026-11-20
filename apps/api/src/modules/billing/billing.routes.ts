import { updateBillingSchema } from "@taskflow/shared";
import { Router } from "express";
import { sendOk } from "../../http.js";
import { requireAuth } from "../../middleware/auth.js";
import { asyncHandler, requireScope, validateBody } from "../../middleware/common.js";
import { loadProject, requireOwner } from "../../middleware/project.js";
import { readLimiter, writeLimiter } from "../../rate-limit.js";
import { getBilling, updateBilling } from "./billing.service.js";

export const billingRouter = Router({ mergeParams: true });

billingRouter.use(requireAuth, loadProject, readLimiter);

billingRouter.get(
  "/",
  requireScope("jobs:read"),
  asyncHandler(async (req, res) => {
    sendOk(res, await getBilling(req.project!));
  }),
);

billingRouter.patch(
  "/",
  writeLimiter,
  requireScope("jobs:write"),
  requireOwner,
  validateBody(updateBillingSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await updateBilling(req.project!, req.body.plan, req.auth!));
  }),
);
