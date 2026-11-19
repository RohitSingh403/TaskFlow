import { z } from "zod";

export const HANDLERS = {
  "send-email": {
    title: "Send email",
    description: "Deliver a transactional email. A side-effect record keeps a retry from sending it twice after a crash.",
    suggestedQueue: "emails",
  },
  "generate-report": {
    title: "Generate report",
    description: "Build a report document and return its location.",
    suggestedQueue: "reports",
  },
  "process-records": {
    title: "Process records",
    description: "Walk a bounded record set. The count is data, not executable code.",
    suggestedQueue: "reports",
  },
  "send-notification": {
    title: "Send notification",
    description: "Deliver an in-app, push, or email notification through the trusted handler.",
    suggestedQueue: "notifications",
  },
} as const;

export type HandlerName = keyof typeof HANDLERS;

export function isHandlerName(value: string): value is HandlerName {
  return Object.prototype.hasOwnProperty.call(HANDLERS, value);
}

export const simulateSchema = z
  .object({
    delayMs: z.number().int().min(0).max(10_000).optional(),
    failUntilAttempt: z.number().int().min(1).max(10).optional(),
    errorMessage: z.string().max(300).optional(),
  })
  .strict();

export type Simulation = z.infer<typeof simulateSchema>;

const sendEmailPayload = z
  .object({
    to: z.string().email(),
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(10_000),
    userId: z.string().trim().min(1).max(100).optional(),
    _simulate: simulateSchema.optional(),
  })
  .strict();

const generateReportPayload = z
  .object({
    reportType: z.enum(["sales", "activity", "inventory"]),
    format: z.enum(["pdf", "csv"]),
    rangeDays: z.number().int().min(1).max(365),
    _simulate: simulateSchema.optional(),
  })
  .strict();

const processRecordsPayload = z
  .object({
    source: z.string().trim().min(1).max(200),
    count: z.number().int().min(1).max(100_000),
    _simulate: simulateSchema.optional(),
  })
  .strict();

const sendNotificationPayload = z
  .object({
    channel: z.enum(["email", "push", "in-app"]),
    recipientId: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(500),
    _simulate: simulateSchema.optional(),
  })
  .strict();

export const handlerSchemas = {
  "send-email": sendEmailPayload,
  "generate-report": generateReportPayload,
  "process-records": processRecordsPayload,
  "send-notification": sendNotificationPayload,
} as const;

export type HandlerPayload<T extends HandlerName> = z.infer<(typeof handlerSchemas)[T]>;

export const HANDLER_EXAMPLES: { [K in HandlerName]: z.infer<(typeof handlerSchemas)[K]> } = {
  "send-email": {
    to: "user@example.com",
    subject: "Welcome to TaskFlow",
    body: "Your workspace is ready.",
    userId: "user_123",
  },
  "generate-report": {
    reportType: "sales",
    format: "pdf",
    rangeDays: 7,
  },
  "process-records": {
    source: "imports/orders.csv",
    count: 250,
  },
  "send-notification": {
    channel: "in-app",
    recipientId: "user_123",
    message: "Your report is ready.",
  },
};

export function simulationDecision(
  environment: "development" | "production",
  payload: { _simulate?: unknown },
): { ok: true } | { ok: false; message: string } {
  if (payload._simulate && environment !== "development") {
    return {
      ok: false,
      message: "Failure simulation is available only on development projects.",
    };
  }
  return { ok: true };
}
