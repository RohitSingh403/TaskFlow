import { createServer } from "node:http";
import { closeBullQueues, logger } from "@taskflow/server";
import { createApp } from "./app.js";
import { env } from "./config.js";
import { connectInfrastructure, disconnectInfrastructure } from "./infrastructure.js";
import { prepareAuth } from "./modules/auth/auth.service.js";
import { attachSocket } from "./socket.js";

const app = createApp();
const server = createServer(app);
attachSocket(server);

await connectInfrastructure();
await prepareAuth();

server.listen(env.PORT, env.HOST, () => {
  logger.info({ host: env.HOST, port: env.PORT }, "TaskFlow API listening");
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "API shutting down");
  server.close(async () => {
    await closeBullQueues();
    await disconnectInfrastructure();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
