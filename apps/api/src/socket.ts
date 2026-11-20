import { Project, projectRole } from "@taskflow/server";
import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { corsOrigins } from "./config.js";
import { startEventBridge } from "./infrastructure.js";
import { verifyAccessToken } from "./middleware/auth.js";

export function attachSocket(server: HttpServer) {
  const io = new Server(server, {
    cors: { origin: corsOrigins, credentials: true },
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== "string" || token.length < 10) {
        next(new Error("UNAUTHORIZED"));
        return;
      }
      socket.data.auth = await verifyAccessToken(token);
      next();
    } catch {
      next(new Error("UNAUTHORIZED"));
    }
  });

  io.on("connection", (socket) => {
    socket.on("project:join", async (projectId: unknown) => {
      if (typeof projectId !== "string") return;
      const auth = socket.data.auth as { userObjectId?: string } | undefined;
      const project = await Project.findOne({ publicId: projectId, deletedAt: null });
      const role = project && auth?.userObjectId ? await projectRole(auth.userObjectId, project) : null;
      if (!project || !role) {
        socket.emit("project:error", { message: "Project not found" });
        return;
      }
      for (const room of socket.rooms) {
        if (room.startsWith("project:")) socket.leave(room);
      }
      await socket.join(`project:${project.publicId}`);
      socket.emit("project:joined", { projectId: project.publicId });
    });
  });

  startEventBridge(io);
  return io;
}
