import { Project, User } from "@taskflow/server";
import type { NextFunction, Request, Response } from "express";
import { AppError } from "../errors.js";

export async function loadProject(req: Request, _res: Response, next: NextFunction) {
  try {
    if (!req.auth) throw new AppError(401, "UNAUTHORIZED", "Authentication is required");
    const projectId = req.params.projectId;
    if (!projectId || Array.isArray(projectId)) {
      throw new AppError(400, "VALIDATION_ERROR", "Project id is required");
    }
    const project = await Project.findOne({ publicId: projectId, deletedAt: null });
    if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
    if (req.auth.type === "api_key") {
      if (req.auth.projectPublicId !== project.publicId) {
        throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
      }
    } else {
      const user = await User.findOne({ publicId: req.auth.userPublicId });
      if (!user || String(project.ownerId) !== String(user._id)) {
        throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
      }
    }
    req.project = project;
    next();
  } catch (error) {
    next(error);
  }
}
