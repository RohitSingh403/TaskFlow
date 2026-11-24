import { deleteWebhooksSchema, pauseWebhooksSchema, redeliverFailedWebhooksSchema, resumeWebhooksSchema, rotateWebhooksSchema, testWebhooksSchema, updateWebhookSchema, webhookSchema } from "@taskflow/shared";
import { Router } from "express";
import { toWebhook, toWebhookDelivery } from "../../dto.js";
import { sendCreated, sendOk } from "../../http.js";
import { requireAuth } from "../../middleware/auth.js";
import { asyncHandler, requireScope, validateBody } from "../../middleware/common.js";
import { loadProject } from "../../middleware/project.js";
import { readLimiter, writeLimiter } from "../../rate-limit.js";
import {
  createWebhook,
  deleteWebhook,
  deleteWebhooks,
  listWebhookDeliveries,
  listWebhooks,
  pauseWebhooks,
  redeliverFailedWebhooks,
  resumeWebhooks,
  redeliverWebhook,
  rotateWebhookSecret,
  rotateWebhookSecrets,
  sendTestWebhook,
  sendTestWebhooks,
  updateWebhook,
} from "./webhooks.service.js";

export const webhookRouter = Router({ mergeParams: true });

webhookRouter.use(requireAuth, loadProject, readLimiter);

webhookRouter.get(
  "/",
  requireScope("jobs:read"),
  asyncHandler(async (req, res) => {
    const [hooks, deliveries] = await Promise.all([
      listWebhooks(req.project!),
      listWebhookDeliveries(req.project!),
    ]);
    sendOk(res, { webhooks: hooks.map(toWebhook), deliveries: deliveries.map(toWebhookDelivery) });
  }),
);

webhookRouter.post(
  "/",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(webhookSchema),
  asyncHandler(async (req, res) => {
    const created = await createWebhook(req.project!, req.body, req.auth!);
    sendCreated(res, { ...toWebhook(created.webhook), secret: created.secret });
  }),
);

webhookRouter.post(
  "/pause",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(pauseWebhooksSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await pauseWebhooks(req.project!, req.body, req.auth!));
  }),
);

webhookRouter.post(
  "/resume",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(resumeWebhooksSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await resumeWebhooks(req.project!, req.body, req.auth!));
  }),
);

webhookRouter.post(
  "/test",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(testWebhooksSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await sendTestWebhooks(req.project!, req.body, req.auth!));
  }),
);

webhookRouter.post(
  "/rotate",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(rotateWebhooksSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await rotateWebhookSecrets(req.project!, req.body, req.auth!));
  }),
);

webhookRouter.post(
  "/delete",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(deleteWebhooksSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await deleteWebhooks(req.project!, req.body, req.auth!));
  }),
);

webhookRouter.patch(
  "/:webhookId",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(updateWebhookSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, toWebhook(await updateWebhook(req.project!, String(req.params.webhookId), req.body, req.auth!)));
  }),
);

webhookRouter.post(
  "/redeliver-failed",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(redeliverFailedWebhooksSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await redeliverFailedWebhooks(req.project!, req.body, req.auth!));
  }),
);

webhookRouter.post(
  "/:webhookId/rotate",
  writeLimiter,
  requireScope("jobs:write"),
  asyncHandler(async (req, res) => {
    const rotated = await rotateWebhookSecret(req.project!, String(req.params.webhookId), req.auth!);
    sendOk(res, { ...toWebhook(rotated.webhook), secret: rotated.secret });
  }),
);

webhookRouter.post(
  "/:webhookId/test",
  writeLimiter,
  requireScope("jobs:write"),
  asyncHandler(async (req, res) => {
    const delivery = await sendTestWebhook(req.project!, String(req.params.webhookId), req.auth!);
    sendCreated(res, toWebhookDelivery(delivery));
  }),
);

webhookRouter.delete(
  "/:webhookId",
  writeLimiter,
  requireScope("jobs:write"),
  asyncHandler(async (req, res) => {
    await deleteWebhook(req.project!, String(req.params.webhookId), req.auth!);
    sendOk(res, { deleted: true });
  }),
);

webhookRouter.post(
  "/:webhookId/deliveries/:deliveryId/redeliver",
  writeLimiter,
  requireScope("jobs:write"),
  asyncHandler(async (req, res) => {
    const delivery = await redeliverWebhook(req.project!, String(req.params.webhookId), String(req.params.deliveryId), req.auth!);
    sendOk(res, toWebhookDelivery(delivery));
  }),
);

webhookRouter.get(
  "/:webhookId/deliveries",
  requireScope("jobs:read"),
  asyncHandler(async (req, res) => {
    const deliveries = await listWebhookDeliveries(req.project!, String(req.params.webhookId));
    sendOk(res, deliveries.map(toWebhookDelivery));
  }),
);
