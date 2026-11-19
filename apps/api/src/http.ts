import type { Response } from "express";

export function sendOk<T>(res: Response, data: T, meta: Record<string, unknown> = {}) {
  res.json({
    success: true,
    data,
    meta: { requestId: res.locals.requestId, ...meta },
  });
}

export function sendCreated<T>(res: Response, data: T, meta: Record<string, unknown> = {}) {
  res.status(201);
  sendOk(res, data, meta);
}
