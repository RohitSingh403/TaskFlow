import { Router } from "express";
import { toWorker } from "../../dto.js";
import { sendOk } from "../../http.js";
import { requireAuth } from "../../middleware/auth.js";
import { asyncHandler, requireScope } from "../../middleware/common.js";
import { loadProject } from "../../middleware/project.js";
import { readLimiter } from "../../rate-limit.js";
import { getWorker, listWorkers, workerJobs } from "./workers.service.js";

export const workerRouter = Router({ mergeParams: true });

workerRouter.use(requireAuth, loadProject, readLimiter, requireScope("workers:read"));

workerRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const workers = await listWorkers(req.project!);
    sendOk(res, workers.map((worker) => toWorker(worker, req.project!.publicId)));
  }),
);

workerRouter.get(
  "/:workerId",
  asyncHandler(async (req, res) => {
    const worker = await getWorker(req.project!, String(req.params.workerId));
    sendOk(res, toWorker(worker, req.project!.publicId));
  }),
);

workerRouter.get(
  "/:workerId/jobs",
  asyncHandler(async (req, res) => {
    sendOk(res, await workerJobs(req.project!, String(req.params.workerId)));
  }),
);
