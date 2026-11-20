import { existsSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

const candidates = [path.resolve(process.cwd(), ".env"), path.resolve(process.cwd(), "../../.env")];
for (const file of candidates) {
  if (existsSync(file)) {
    dotenv.config({ path: file });
    break;
  }
}

const schema = z.object({
  MONGODB_URI: z.string().min(1),
  REDIS_URL: z.string().min(1),
  BULL_PREFIX: z.string().min(1).default("taskflow"),
  SCHEDULER_POLL_MS: z.coerce.number().int().min(1000).max(60_000).default(5_000),
});

export const env = schema.parse(process.env);
