import { LogEntry } from "@taskflow/server";
import { listLogsQuerySchema } from "@taskflow/shared";
import { Router } from "express";
import { sendOk } from "../../http.js";
import { requireAuth } from "../../middleware/auth.js";
import { asyncHandler, readQuery, requireScope, validateQuery } from "../../middleware/common.js";
import { loadProject } from "../../middleware/project.js";
import { readLimiter } from "../../rate-limit.js";

export const logRouter = Router({ mergeParams: true });

logRouter.use(requireAuth, loadProject, readLimiter, requireScope("logs:read"));

logRouter.get(
  "/",
  validateQuery(listLogsQuerySchema),
  asyncHandler(async (req, res) => {
    const query = readQuery<{
      level?: string;
      jobId?: string;
      q?: string;
      from?: string;
      to?: string;
      page: number;
      limit: number;
    }>(req);
    const filter: Record<string, unknown> = { projectId: req.project!._id };
    if (query.level) filter.level = query.level;
    if (query.jobId) filter.jobPublicId = query.jobId;
    if (query.from || query.to) {
      filter.timestamp = {
        ...(query.from ? { $gte: new Date(query.from) } : {}),
        ...(query.to ? { $lte: new Date(query.to) } : {}),
      };
    }
    if (query.q) {
      const escaped = query.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.message = new RegExp(escaped, "i");
    }
    const skip = (query.page - 1) * query.limit;
    const [logs, total] = await Promise.all([
      LogEntry.find(filter).sort({ timestamp: -1 }).skip(skip).limit(query.limit).lean(),
      LogEntry.countDocuments(filter),
    ]);
    sendOk(
      res,
      logs.map((log) => ({
        id: String(log._id),
        timestamp: new Date(log.timestamp).toISOString(),
        level: log.level,
        message: log.message,
        jobId: log.jobPublicId ?? null,
        workerId: log.workerId ?? null,
        traceId: log.traceId ?? null,
        durationMs: log.durationMs ?? null,
      })),
      { page: query.page, limit: query.limit, total, totalPages: Math.max(1, Math.ceil(total / query.limit)) },
    );
  }),
);
