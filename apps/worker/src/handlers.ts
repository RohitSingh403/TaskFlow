import { commitSideEffect, createId } from "@taskflow/server";
import { isHandlerName } from "@taskflow/shared";
import mongoose from "mongoose";

export interface WorkerJobData {
  publicId: string;
  projectObjectId: string;
  projectPublicId: string;
  queueName: string;
  handler: string;
  payload: {
    _simulate?: { delayMs?: number; failUntilAttempt?: number; errorMessage?: string };
    [key: string]: unknown;
  };
  timeoutMs: number;
  traceId: string;
  allowSimulation: boolean;
}

function sleep(ms: number, signal: AbortSignal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("Job exceeded its timeout"), { code: "JOB_TIMEOUT" }));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runHandler(data: WorkerJobData, attempt: number, signal: AbortSignal) {
  const simulation = data.allowSimulation ? data.payload._simulate : undefined;
  if (simulation?.failUntilAttempt && attempt <= simulation.failUntilAttempt) {
    throw Object.assign(new Error(simulation.errorMessage || `Simulated failure on attempt ${attempt}`), {
      code: "SIMULATED_FAILURE",
    });
  }
  if (simulation?.delayMs) await sleep(simulation.delayMs, signal);
  if (signal.aborted) throw Object.assign(new Error("Job exceeded its timeout"), { code: "JOB_TIMEOUT" });
  if (!isHandlerName(data.handler)) {
    throw Object.assign(new Error(`No trusted handler is registered for "${data.handler}"`), { code: "HANDLER_NOT_FOUND" });
  }

  const projectId = new mongoose.Types.ObjectId(data.projectObjectId);
  if (data.handler === "send-email") {
    const to = String(data.payload.to ?? "");
    const subject = String(data.payload.subject ?? "");
    const effect = await commitSideEffect({
      key: `send-email:${data.publicId}`,
      projectId,
      handler: data.handler,
      propose: () => ({
        delivered: true,
        to,
        subject,
        messageId: createId("msg"),
        acceptedAt: new Date().toISOString(),
      }),
    });
    return { ...effect.result, idempotentReplay: effect.reused };
  }

  if (data.handler === "generate-report") {
    const effect = await commitSideEffect({
      key: `generate-report:${data.publicId}`,
      projectId,
      handler: data.handler,
      propose: () => ({
        reportId: createId("rpt"),
        reportType: data.payload.reportType,
        format: data.payload.format,
        rangeDays: data.payload.rangeDays,
        url: `https://files.taskflow.local/reports/${data.publicId}.${data.payload.format === "csv" ? "csv" : "pdf"}`,
        generatedAt: new Date().toISOString(),
      }),
    });
    return { ...effect.result, idempotentReplay: effect.reused };
  }

  if (data.handler === "process-records") {
    const count = Number(data.payload.count ?? 0);
    const effect = await commitSideEffect({
      key: `process-records:${data.publicId}`,
      projectId,
      handler: data.handler,
      propose: () => ({
        source: data.payload.source,
        processed: count,
        batchId: createId("batch"),
        finishedAt: new Date().toISOString(),
      }),
    });
    return { ...effect.result, idempotentReplay: effect.reused };
  }

  const effect = await commitSideEffect({
    key: `send-notification:${data.publicId}`,
    projectId,
    handler: data.handler,
    propose: () => ({
      delivered: true,
      channel: data.payload.channel,
      recipientId: data.payload.recipientId,
      notificationId: createId("ntf"),
      sentAt: new Date().toISOString(),
    }),
  });
  return { ...effect.result, idempotentReplay: effect.reused };
}

export async function runHandlerWithTimeout(data: WorkerJobData, attempt: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), data.timeoutMs);
  try {
    return await runHandler(data, attempt, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
