import { inviteMemberSchema, removeMembersSchema, transferOwnershipSchema } from "@taskflow/shared";
import { Router } from "express";
import { AppError } from "../../errors.js";
import { sendCreated, sendOk } from "../../http.js";
import { requireAuth } from "../../middleware/auth.js";
import { asyncHandler, requireScope, validateBody } from "../../middleware/common.js";
import { loadProject, requireOwner } from "../../middleware/project.js";
import { readLimiter, writeLimiter } from "../../rate-limit.js";
import { inviteMember, leaveProject, listMembers, removeMember, removeMembers, transferOwnership } from "./members.service.js";

export const memberRouter = Router({ mergeParams: true });

memberRouter.use(requireAuth, loadProject, readLimiter);

memberRouter.get(
  "/",
  requireScope("jobs:read"),
  asyncHandler(async (req, res) => {
    sendOk(res, { role: req.projectRole, members: await listMembers(req.project!) });
  }),
);

memberRouter.post(
  "/",
  writeLimiter,
  requireScope("jobs:write"),
  requireOwner,
  validateBody(inviteMemberSchema),
  asyncHandler(async (req, res) => {
    sendCreated(res, await inviteMember(req.project!, req.body.email, req.auth!));
  }),
);

memberRouter.post(
  "/transfer",
  writeLimiter,
  requireScope("jobs:write"),
  requireOwner,
  validateBody(transferOwnershipSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await transferOwnership(req.project!, req.body.memberId, req.auth!));
  }),
);

memberRouter.post(
  "/leave",
  writeLimiter,
  requireScope("jobs:write"),
  asyncHandler(async (req, res) => {
    if (req.auth?.type !== "user") {
      throw new AppError(403, "OWNER_REQUIRED", "Only a signed-in member can leave a project");
    }
    await leaveProject(req.project!, req.auth);
    sendOk(res, { left: true });
  }),
);

memberRouter.post(
  "/remove",
  writeLimiter,
  requireScope("jobs:write"),
  requireOwner,
  validateBody(removeMembersSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await removeMembers(req.project!, req.body, req.auth!));
  }),
);

memberRouter.delete(
  "/:memberId",
  writeLimiter,
  requireScope("jobs:write"),
  requireOwner,
  asyncHandler(async (req, res) => {
    await removeMember(req.project!, String(req.params.memberId), req.auth!);
    sendOk(res, { deleted: true });
  }),
);
