import { HANDLER_EXAMPLES, HANDLERS } from "@taskflow/shared";
import { logger } from "@taskflow/server";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import mongoose from "mongoose";
import { corsOrigins } from "./config.js";
import { sendOk } from "./http.js";
import { getPublisher } from "./infrastructure.js";
import { errorHandler, notFound } from "./middleware/error.js";
import { requestContext } from "./middleware/common.js";
import { requireAuth } from "./middleware/auth.js";
import { apiKeyRouter } from "./modules/api-keys/api-keys.routes.js";
import { analyticsRouter } from "./modules/analytics/analytics.routes.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { jobRouter } from "./modules/jobs/jobs.routes.js";
import { logRouter } from "./modules/logs/logs.routes.js";
import { projectRouter } from "./modules/projects/projects.routes.js";
import { queueRouter } from "./modules/queues/queues.routes.js";
import { scheduleRouter } from "./modules/schedules/schedules.routes.js";
import { workerRouter } from "./modules/workers/workers.routes.js";
import { workflowRouter } from "./modules/workflows/workflows.routes.js";
import { alertRouter } from "./modules/alerts/alerts.routes.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors({ origin: corsOrigins, credentials: true }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(requestContext);
  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      logger.info({
        requestId: res.locals.requestId,
        method: req.method,
        path: req.originalUrl.split("?")[0],
        status: res.statusCode,
        durationMs: Date.now() - started,
      });
    });
    next();
  });

  app.get("/health", async (_req, res) => {
    const mongo = mongoose.connection.readyState === 1;
    let redis = false;
    try {
      redis = (await getPublisher().ping()) === "PONG";
    } catch {
      redis = false;
    }
    const ok = mongo && redis;
    res.status(ok ? 200 : 503).json({
      success: ok,
      data: { mongo, redis },
      meta: { requestId: res.locals.requestId },
    });
  });

  const api = express.Router();
  api.use("/auth", authRouter);
  api.get("/meta/handlers", requireAuth, (_req, res) => {
    sendOk(
      res,
      Object.entries(HANDLERS).map(([name, handler]) => ({
        name,
        title: handler.title,
        description: handler.description,
        suggestedQueue: handler.suggestedQueue,
        example: HANDLER_EXAMPLES[name as keyof typeof HANDLER_EXAMPLES],
      })),
    );
  });

  const projects = express.Router();
  projects.use("/:projectId/queues", queueRouter);
  projects.use("/:projectId/jobs", jobRouter);
  projects.use("/:projectId/schedules", scheduleRouter);
  projects.use("/:projectId/workflows", workflowRouter);
  projects.use("/:projectId/alerts", alertRouter);
  projects.use("/:projectId/workers", workerRouter);
  projects.use("/:projectId/api-keys", apiKeyRouter);
  projects.use("/:projectId/analytics", analyticsRouter);
  projects.use("/:projectId/logs", logRouter);
  projects.use("/", projectRouter);
  api.use("/projects", projects);

  app.use("/api/v1", api);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
