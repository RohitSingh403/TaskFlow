import { createApiKeySchema, updateApiKeySchema } from "@taskflow/shared";
import { Router } from "express";
import { toApiKey } from "../../dto.js";
import { AppError } from "../../errors.js";
import { sendCreated, sendOk } from "../../http.js";
import { requireAuth } from "../../middleware/auth.js";
import { asyncHandler, requireScope, validateBody } from "../../middleware/common.js";
import { loadProject, requireOwner } from "../../middleware/project.js";
import { readLimiter, writeLimiter } from "../../rate-limit.js";
import { createApiKey, listApiKeys, revokeApiKey, updateApiKey } from "./api-keys.service.js";

export const apiKeyRouter = Router({ mergeParams: true });

apiKeyRouter.use(requireAuth, loadProject, readLimiter, requireOwner);

apiKeyRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    if (req.auth?.type !== "user") throw new AppError(403, "FORBIDDEN", "API keys are managed from a user session");
    const keys = await listApiKeys(req.project!);
    sendOk(res, keys.map((key) => toApiKey(key)));
  }),
);

apiKeyRouter.post(
  "/",
  writeLimiter,
  requireScope("*"),
  validateBody(createApiKeySchema),
  asyncHandler(async (req, res) => {
    if (req.auth?.type !== "user") throw new AppError(403, "FORBIDDEN", "API keys are managed from a user session");
    const created = await createApiKey(req.project!, req.body, req.auth.userPublicId);
    sendCreated(res, { ...toApiKey(created.key), secret: created.secret });
  }),
);

apiKeyRouter.patch(
  "/:keyId",
  writeLimiter,
  requireScope("*"),
  validateBody(updateApiKeySchema),
  asyncHandler(async (req, res) => {
    if (req.auth?.type !== "user") throw new AppError(403, "FORBIDDEN", "API keys are managed from a user session");
    const key = await updateApiKey(req.project!, String(req.params.keyId), req.body, req.auth.userPublicId);
    sendOk(res, toApiKey(key));
  }),
);

apiKeyRouter.post(
  "/:keyId/revoke",
  writeLimiter,
  requireScope("*"),
  asyncHandler(async (req, res) => {
    if (req.auth?.type !== "user") throw new AppError(403, "FORBIDDEN", "API keys are managed from a user session");
    const key = await revokeApiKey(req.project!, String(req.params.keyId), req.auth.userPublicId);
    sendOk(res, toApiKey(key));
  }),
);
