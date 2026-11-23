import { pauseQueuesSchema, queueSchema, updateQueueSchema } from "@taskflow/shared";
import { Router } from "express";
import { toQueue } from "../../dto.js";
import { sendCreated, sendOk } from "../../http.js";
import { requireAuth } from "../../middleware/auth.js";
import { asyncHandler, requireScope, validateBody } from "../../middleware/common.js";
import { loadProject } from "../../middleware/project.js";
import { readLimiter, writeLimiter } from "../../rate-limit.js";
import { createQueue, deleteQueue, findQueue, listQueues, pauseQueues, queueStats, setQueuePaused, updateQueue } from "./queues.service.js";

export const queueRouter = Router({ mergeParams: true });

queueRouter.use(requireAuth, loadProject, readLimiter);

queueRouter.get(
  "/",
  requireScope("queues:read"),
  asyncHandler(async (req, res) => {
    const queues = await listQueues(req.project!);
    const withStats = await Promise.all(
      queues.map(async (queue) => ({ ...toQueue(queue), stats: await queueStats(queue) })),
    );
    sendOk(res, withStats);
  }),
);

queueRouter.post(
  "/",
  writeLimiter,
  requireScope("queues:write"),
  validateBody(queueSchema),
  asyncHandler(async (req, res) => {
    const queue = await createQueue(req.project!, req.body, req.auth!.userPublicId);
    sendCreated(res, { ...toQueue(queue), stats: await queueStats(queue) });
  }),
);

queueRouter.post(
  "/pause",
  writeLimiter,
  requireScope("queues:write"),
  validateBody(pauseQueuesSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await pauseQueues(req.project!, req.body, req.auth!.userPublicId));
  }),
);

queueRouter.get(
  "/:queueId",
  requireScope("queues:read"),
  asyncHandler(async (req, res) => {
    const queue = await findQueue(req.project!, String(req.params.queueId));
    sendOk(res, { ...toQueue(queue), stats: await queueStats(queue) });
  }),
);

queueRouter.get(
  "/:queueId/stats",
  requireScope("queues:read"),
  asyncHandler(async (req, res) => {
    const queue = await findQueue(req.project!, String(req.params.queueId));
    sendOk(res, await queueStats(queue));
  }),
);

queueRouter.patch(
  "/:queueId",
  writeLimiter,
  requireScope("queues:write"),
  validateBody(updateQueueSchema),
  asyncHandler(async (req, res) => {
    const queue = await findQueue(req.project!, String(req.params.queueId));
    const updated = await updateQueue(req.project!, queue, req.body, req.auth!.userPublicId);
    sendOk(res, { ...toQueue(updated), stats: await queueStats(updated) });
  }),
);

queueRouter.post(
  "/:queueId/pause",
  writeLimiter,
  requireScope("queues:write"),
  asyncHandler(async (req, res) => {
    const queue = await findQueue(req.project!, String(req.params.queueId));
    const updated = await setQueuePaused(req.project!, queue, true, req.auth!.userPublicId);
    sendOk(res, toQueue(updated));
  }),
);

queueRouter.post(
  "/:queueId/resume",
  writeLimiter,
  requireScope("queues:write"),
  asyncHandler(async (req, res) => {
    const queue = await findQueue(req.project!, String(req.params.queueId));
    const updated = await setQueuePaused(req.project!, queue, false, req.auth!.userPublicId);
    sendOk(res, toQueue(updated));
  }),
);

queueRouter.delete(
  "/:queueId",
  writeLimiter,
  requireScope("queues:write"),
  asyncHandler(async (req, res) => {
    const queue = await findQueue(req.project!, String(req.params.queueId));
    await deleteQueue(req.project!, queue, req.auth!.userPublicId);
    sendOk(res, { id: queue.publicId, deleted: true });
  }),
);
