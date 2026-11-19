import { createId } from "@taskflow/server";
import type { NextFunction, Request, Response } from "express";
import type { ZodSchema } from "zod";
import { ZodError } from "zod";
import { AppError } from "../errors.js";

export function asyncHandler<T extends Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: T, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function requestContext(req: Request, res: Response, next: NextFunction) {
  const incoming = req.get("x-request-id");
  const requestId = incoming && /^[A-Za-z0-9._:-]{6,80}$/.test(incoming) ? incoming : createId("req");
  res.locals.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  next();
}

export function zodDetails(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "body",
    message: issue.message,
  }));
}

export function validateBody(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      next(new AppError(400, "VALIDATION_ERROR", "Request validation failed", zodDetails(parsed.error)));
      return;
    }
    req.body = parsed.data;
    next();
  };
}

export function validateQuery(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      next(new AppError(400, "VALIDATION_ERROR", "Query validation failed", zodDetails(parsed.error)));
      return;
    }
    resLocalsQuery(req, parsed.data);
    next();
  };
}

const queryStore = new WeakMap<Request, unknown>();

function resLocalsQuery(req: Request, data: unknown) {
  queryStore.set(req, data);
}

export function readQuery<T>(req: Request): T {
  return queryStore.get(req) as T;
}

export function requireScope(scope: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) {
      next(new AppError(401, "UNAUTHORIZED", "Authentication is required"));
      return;
    }
    if (req.auth.scopes.includes("*") || req.auth.scopes.includes(scope)) {
      next();
      return;
    }
    next(new AppError(403, "FORBIDDEN", `Missing required scope: ${scope}`));
  };
}
