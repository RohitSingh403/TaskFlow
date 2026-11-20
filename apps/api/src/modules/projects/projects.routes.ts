import { Project, projectRole } from "@taskflow/server";
import { projectSchema, updateProjectSchema } from "@taskflow/shared";
import { Router } from "express";
import { toProject } from "../../dto.js";
import { AppError } from "../../errors.js";
import { sendCreated, sendOk } from "../../http.js";
import { requireAuth } from "../../middleware/auth.js";
import { asyncHandler, requireScope, validateBody } from "../../middleware/common.js";
import { readLimiter, writeLimiter } from "../../rate-limit.js";
import { createProject, deleteProject, listAudit, listProjects, projectUsage, updateProject } from "./projects.service.js";

export const projectRouter = Router();

projectRouter.use(requireAuth, readLimiter);

projectRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    if (req.auth?.type === "api_key") {
      const project = await Project.findOne({ publicId: req.auth.projectPublicId, deletedAt: null });
      sendOk(res, project ? [{ ...toProject(project), role: "owner" }] : []);
      return;
    }
    const projects = await listProjects(req.auth!.userObjectId);
    sendOk(res, projects.map((row) => ({ ...toProject(row.project), role: row.role })));
  }),
);

projectRouter.post(
  "/",
  writeLimiter,
  requireScope("*"),
  validateBody(projectSchema),
  asyncHandler(async (req, res) => {
    if (req.auth?.type !== "user") {
      throw new AppError(403, "FORBIDDEN", "Projects are created from a user session");
    }
    const project = await createProject(req.auth.userObjectId, req.body, {
      type: "user",
      id: req.auth.userPublicId,
    });
    sendCreated(res, toProject(project));
  }),
);

projectRouter.get(
  "/:projectId",
  asyncHandler(async (req, res) => {
    const projectId = String(req.params.projectId);
    const project = await Project.findOne({ publicId: projectId, deletedAt: null });
    if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
    if (req.auth?.type === "api_key" && req.auth.projectPublicId !== project.publicId) {
      throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
    }
    const role = req.auth?.type === "api_key" ? "owner" : await projectRole(req.auth!.userObjectId, project);
    if (!role) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
    const usage = await projectUsage(project);
    sendOk(res, { ...toProject(project), usage, role });
  }),
);

projectRouter.patch(
  "/:projectId",
  writeLimiter,
  requireScope("*"),
  validateBody(updateProjectSchema),
  asyncHandler(async (req, res) => {
    const project = await ownedProject(req.auth!.userObjectId, String(req.params.projectId), req.auth?.type);
    const updated = await updateProject(project, req.body, { type: "user", id: req.auth!.userPublicId });
    sendOk(res, toProject(updated));
  }),
);

projectRouter.delete(
  "/:projectId",
  writeLimiter,
  requireScope("*"),
  asyncHandler(async (req, res) => {
    const project = await ownedProject(req.auth!.userObjectId, String(req.params.projectId), req.auth?.type);
    await deleteProject(project, { type: "user", id: req.auth!.userPublicId });
    sendOk(res, { id: project.publicId, deleted: true });
  }),
);

projectRouter.get(
  "/:projectId/audit",
  asyncHandler(async (req, res) => {
    const project = await ownedProject(req.auth!.userObjectId, String(req.params.projectId), req.auth?.type, req.auth?.projectPublicId);
    const entries = await listAudit(project);
    sendOk(
      res,
      entries.map((entry) => ({
        id: String(entry._id),
        action: entry.action,
        actorType: entry.actorType,
        actorId: entry.actorId,
        targetType: entry.targetType,
        targetId: entry.targetId,
        metadata: entry.metadata ?? {},
        createdAt: entry.createdAt?.toISOString?.() ?? new Date(entry.createdAt).toISOString(),
      })),
    );
  }),
);

async function ownedProject(userObjectId: string, projectId: string, authType?: string, apiProjectId?: string) {
  const project = await Project.findOne({ publicId: projectId, deletedAt: null });
  if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
  if (authType === "api_key") throw new AppError(403, "FORBIDDEN", "This action requires a user session");
  if (apiProjectId && apiProjectId !== project.publicId) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
  const role = await projectRole(userObjectId, project);
  if (!role) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
  if (role !== "owner") throw new AppError(403, "OWNER_REQUIRED", "Only the project owner can do that");
  return project;
}
