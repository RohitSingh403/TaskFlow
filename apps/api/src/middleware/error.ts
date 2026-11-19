import { logger } from "@taskflow/server";
import type { NextFunction, Request, Response } from "express";
import { AppError } from "../errors.js";

export function notFound(_req: Request, res: Response) {
  res.status(404).json({
    success: false,
    error: { code: "NOT_FOUND", message: "Route not found" },
    meta: { requestId: res.locals.requestId },
  });
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof AppError) {
    res.status(error.status).json({
      success: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
      meta: { requestId: res.locals.requestId },
    });
    return;
  }

  if (error instanceof SyntaxError && "body" in (error as { body?: unknown })) {
    res.status(400).json({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "Request body must be valid JSON" },
      meta: { requestId: res.locals.requestId },
    });
    return;
  }

  logger.error({ err: error, requestId: res.locals.requestId }, "Unhandled API error");
  res.status(500).json({
    success: false,
    error: { code: "INTERNAL_ERROR", message: "Something went wrong while handling the request" },
    meta: { requestId: res.locals.requestId },
  });
}
