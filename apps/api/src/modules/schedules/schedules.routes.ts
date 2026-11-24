import { pauseSchedulesSchema, resumeSchedulesSchema, runSchedulesSchema, scheduleSchema, updateScheduleSchema } from "@taskflow/shared";
import { Router } from "express";
import { toJob, toSchedule } from "../../dto.js";
import { sendCreated, sendOk } from "../../http.js";
import { requireAuth } from "../../middleware/auth.js";
import { asyncHandler, requireScope, validateBody } from "../../middleware/common.js";
import { loadProject } from "../../middleware/project.js";
import { readLimiter, writeLimiter } from "../../rate-limit.js";
import { createSchedule, deleteSchedule, getSchedule, listSchedules, pauseSchedules, resumeSchedules, runSchedules, setSchedulePaused, triggerSchedule, updateSchedule } from "./schedules.service.js";

export const scheduleRouter = Router({ mergeParams: true });

scheduleRouter.use(requireAuth, loadProject, readLimiter);

scheduleRouter.get(
  "/",
  requireScope("jobs:read"),
  asyncHandler(async (req, res) => {
    sendOk(res, (await listSchedules(req.project!)).map(toSchedule));
  }),
);

scheduleRouter.post(
  "/",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(scheduleSchema),
  asyncHandler(async (req, res) => {
    const schedule = await createSchedule(req.project!, req.body, req.auth!);
    sendCreated(res, toSchedule(schedule));
  }),
);

scheduleRouter.post(
  "/pause",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(pauseSchedulesSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await pauseSchedules(req.project!, req.body, req.auth!));
  }),
);

scheduleRouter.post(
  "/resume",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(resumeSchedulesSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await resumeSchedules(req.project!, req.body, req.auth!));
  }),
);

scheduleRouter.post(
  "/run",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(runSchedulesSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await runSchedules(req.project!, req.body, req.auth!));
  }),
);

scheduleRouter.get(
  "/:scheduleId",
  requireScope("jobs:read"),
  asyncHandler(async (req, res) => {
    sendOk(res, toSchedule(await getSchedule(req.project!, String(req.params.scheduleId))));
  }),
);

scheduleRouter.patch(
  "/:scheduleId",
  writeLimiter,
  requireScope("jobs:write"),
  validateBody(updateScheduleSchema),
  asyncHandler(async (req, res) => {
    const schedule = await getSchedule(req.project!, String(req.params.scheduleId));
    sendOk(res, toSchedule(await updateSchedule(req.project!, schedule, req.body, req.auth!)));
  }),
);

scheduleRouter.post(
  "/:scheduleId/run",
  writeLimiter,
  requireScope("jobs:write"),
  asyncHandler(async (req, res) => {
    const schedule = await getSchedule(req.project!, String(req.params.scheduleId));
    const job = await triggerSchedule(req.project!, schedule, req.auth!);
    sendCreated(res, toJob(job));
  }),
);

scheduleRouter.post(
  "/:scheduleId/pause",
  writeLimiter,
  requireScope("jobs:write"),
  asyncHandler(async (req, res) => {
    const schedule = await getSchedule(req.project!, String(req.params.scheduleId));
    sendOk(res, toSchedule(await setSchedulePaused(req.project!, schedule, true, req.auth!)));
  }),
);

scheduleRouter.post(
  "/:scheduleId/resume",
  writeLimiter,
  requireScope("jobs:write"),
  asyncHandler(async (req, res) => {
    const schedule = await getSchedule(req.project!, String(req.params.scheduleId));
    sendOk(res, toSchedule(await setSchedulePaused(req.project!, schedule, false, req.auth!)));
  }),
);

scheduleRouter.delete(
  "/:scheduleId",
  writeLimiter,
  requireScope("jobs:write"),
  asyncHandler(async (req, res) => {
    const schedule = await getSchedule(req.project!, String(req.params.scheduleId));
    await deleteSchedule(req.project!, schedule, req.auth!);
    sendOk(res, { id: schedule.publicId, deleted: true });
  }),
);
