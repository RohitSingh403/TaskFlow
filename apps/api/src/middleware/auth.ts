import { ApiKey, sha256, User } from "@taskflow/server";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config.js";
import { AppError } from "../errors.js";
import { Project } from "@taskflow/server";

interface AccessClaims {
  sub: string;
  typ?: string;
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.get("authorization");
    if (!header?.startsWith("Bearer ")) {
      throw new AppError(401, "UNAUTHORIZED", "Authentication is required");
    }
    const token = header.slice("Bearer ".length).trim();
    if (token.startsWith("tf_live_")) {
      req.auth = await authenticateApiKey(token);
    } else {
      req.auth = await authenticateAccessToken(token);
    }
    next();
  } catch (error) {
    next(error);
  }
}

async function authenticateAccessToken(token: string) {
  let claims: AccessClaims;
  try {
    claims = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessClaims;
  } catch {
    throw new AppError(401, "UNAUTHORIZED", "Access token is invalid or expired");
  }
  if (claims.typ !== "access" || !claims.sub) {
    throw new AppError(401, "UNAUTHORIZED", "Access token is invalid or expired");
  }
  const user = await User.findOne({ publicId: claims.sub });
  if (!user) throw new AppError(401, "UNAUTHORIZED", "Access token is invalid or expired");
  return {
    type: "user" as const,
    userPublicId: user.publicId,
    userObjectId: String(user._id),
    scopes: ["*"],
    label: user.name,
  };
}

async function authenticateApiKey(secret: string) {
  const key = await ApiKey.findOne({ keyHash: sha256(secret) }).select("+keyHash");
  if (!key || key.revokedAt) throw new AppError(401, "UNAUTHORIZED", "API key is invalid or revoked");
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) {
    throw new AppError(401, "API_KEY_EXPIRED", "API key has expired");
  }
  const project = await Project.findOne({ _id: key.projectId, deletedAt: null });
  if (!project) throw new AppError(401, "UNAUTHORIZED", "API key is invalid or revoked");
  const owner = await User.findById(project.ownerId);
  if (!owner) throw new AppError(401, "UNAUTHORIZED", "API key is invalid or revoked");
  if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 60_000) {
    key.lastUsedAt = new Date();
    await key.save();
  }
  return {
    type: "api_key" as const,
    userPublicId: owner.publicId,
    userObjectId: String(owner._id),
    scopes: key.scopes,
    label: key.name,
    apiKeyId: key.publicId,
    projectPublicId: project.publicId,
  };
}

export function verifyAccessToken(token: string) {
  return authenticateAccessToken(token);
}
