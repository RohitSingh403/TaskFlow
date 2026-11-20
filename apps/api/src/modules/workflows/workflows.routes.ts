import { updateWorkflowSchema, workflowSchema } from "@taskflow/shared";
import { Router } from "express";
import { toWorkflow, toWorkflowRun } from "../../dto.js";
import { sendCreated, sendOk } from "../../http.js";
import { requireAuth } from "../../middleware/auth.js";
import { asyncHandler, requireScope, validateBody } from "../../middleware/common.js";
import { loadProject } from "../../middleware/project.js";
import { readLimiter, writeLimiter } from "../../rate-limit.js";
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  getWorkflowRun,
  listWorkflowRuns,
  listWorkflows,
  startWorkflowRun,
  updateWorkflow,
} from "./workflows.service.js";

export const workflowRouter = Router({ mergeParams: true });

workflowRouter.use(requireAuth, loadProject, readLimiter);

workflowRouter.get(
  "/",
  requireScope("jobs:read"),
  asyncHandler(async (req, res) => {
    const rows = await listWorkflows(req.project!);
    sendOk(res, rows.map((row) => toWorkflow(row.workflow, { runCount: row.runCount, lastRun: row.lastRun })));
  }),
);

workflowRouter.post(
  "/",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(workflowSchema),
  asyncHandler(async (req, res) => {
    const workflow = await createWorkflow(req.project!, req.body, req.auth!);
    sendCreated(res, toWorkflow(workflow));
  }),
);

workflowRouter.get(
  "/:workflowId",
  requireScope("jobs:read"),
  asyncHandler(async (req, res) => {
    const row = await getWorkflow(req.project!, String(req.params.workflowId));
    sendOk(res, {
      ...toWorkflow(row.workflow, { runCount: row.runCount, lastRun: row.lastRun }),
      runs: row.runs.map((run) => toWorkflowRun(run)),
    });
  }),
);

workflowRouter.patch(
  "/:workflowId",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(updateWorkflowSchema),
  asyncHandler(async (req, res) => {
    const workflow = await updateWorkflow(req.project!, String(req.params.workflowId), req.body, req.auth!);
    sendOk(res, toWorkflow(workflow));
  }),
);

workflowRouter.delete(
  "/:workflowId",
  writeLimiter,
  requireScope("jobs:write"),
  asyncHandler(async (req, res) => {
    await deleteWorkflow(req.project!, String(req.params.workflowId), req.auth!);
    sendOk(res, { deleted: true });
  }),
);

workflowRouter.post(
  "/:workflowId/runs",
  writeLimiter,
  requireScope("jobs:write"),
  asyncHandler(async (req, res) => {
    const started = await startWorkflowRun(req.project!, String(req.params.workflowId), req.auth!);
    sendCreated(res, toWorkflowRun(started.run, started.jobs));
  }),
);

workflowRouter.get(
  "/:workflowId/runs",
  requireScope("jobs:read"),
  asyncHandler(async (req, res) => {
    const runs = await listWorkflowRuns(req.project!, String(req.params.workflowId));
    sendOk(res, runs.map((run) => toWorkflowRun(run)));
  }),
);

workflowRouter.get(
  "/:workflowId/runs/:runId",
  requireScope("jobs:read"),
  asyncHandler(async (req, res) => {
    const row = await getWorkflowRun(req.project!, String(req.params.workflowId), String(req.params.runId));
    sendOk(res, toWorkflowRun(row.run, row.jobs));
  }),
);
