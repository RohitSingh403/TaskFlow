import {
  ApiKey,
  AuditLog,
  bullQueueName,
  createId,
  getBullQueue,
  JobRecord,
  Project,
  ProjectMember,
  QueueConfig,
  type ProjectDoc,
} from "@taskflow/server";
import { DEFAULT_JOB_SETTINGS, DEFAULT_QUEUES } from "@taskflow/shared";
import { AppError } from "../../errors.js";
import { publish } from "../../infrastructure.js";

interface Actor {
  type: "user" | "api_key";
  id: string;
}

export async function listProjects(userObjectId: string) {
  const memberships = await ProjectMember.find({ userId: userObjectId, deletedAt: null }).select("projectId");
  const projects = await Project.find({
    deletedAt: null,
    $or: [{ ownerId: userObjectId }, { _id: { $in: memberships.map((member) => member.projectId) } }],
  }).sort({ createdAt: -1 });
  return projects.map((project) => ({
    project,
    role: String(project.ownerId) === String(userObjectId) ? ("owner" as const) : ("member" as const),
  }));
}

export async function createProject(
  ownerObjectId: string,
  input: { name: string; description?: string; environment: "development" | "production" },
  actor: Actor,
) {
  const project = await Project.create({
    publicId: createId("proj"),
    ownerId: ownerObjectId,
    name: input.name,
    description: input.description ?? "",
    environment: input.environment,
    defaultJobSettings: { ...DEFAULT_JOB_SETTINGS },
  });
  await Promise.all(
    DEFAULT_QUEUES.map((queue) =>
      QueueConfig.create({
        publicId: createId("queue"),
        projectId: project._id,
        projectPublicId: project.publicId,
        name: queue.name,
        description: queue.description,
        concurrency: queue.concurrency,
        maxWaiting: 10_000,
        bullQueueName: bullQueueName(project.publicId, queue.name),
        isPaused: false,
      }),
    ),
  );
  await AuditLog.create({
    projectId: project._id,
    actorType: actor.type,
    actorId: actor.id,
    action: "project.created",
    targetType: "project",
    targetId: project.publicId,
    metadata: { name: project.name, environment: project.environment },
  });
  return project;
}

export async function updateProject(project: ProjectDoc, input: Record<string, unknown>, actor: Actor) {
  if (typeof input.name === "string") project.name = input.name;
  if (typeof input.description === "string") project.description = input.description;
  if (input.environment === "development" || input.environment === "production") {
    project.environment = input.environment;
  }
  if (input.defaultJobSettings && typeof input.defaultJobSettings === "object") {
    project.defaultJobSettings = input.defaultJobSettings as ProjectDoc["defaultJobSettings"];
  }
  await project.save();
  await AuditLog.create({
    projectId: project._id,
    actorType: actor.type,
    actorId: actor.id,
    action: "project.updated",
    targetType: "project",
    targetId: project.publicId,
    metadata: { fields: Object.keys(input) },
  });
  return project;
}

export async function deleteProject(project: ProjectDoc, actor: Actor) {
  project.deletedAt = new Date();
  await project.save();
  const queues = await QueueConfig.find({ projectId: project._id, deletedAt: null });
  for (const queue of queues) {
    queue.isPaused = true;
    queue.deletedAt = new Date();
    await queue.save();
    await getBullQueue(queue.bullQueueName).pause();
  }
  await AuditLog.create({
    projectId: project._id,
    actorType: actor.type,
    actorId: actor.id,
    action: "project.deleted",
    targetType: "project",
    targetId: project.publicId,
    metadata: {},
  });
  await publish({
    type: "queue.updated",
    projectId: project.publicId,
    data: { queueId: "*", isPaused: true },
  });
}

export async function projectUsage(project: ProjectDoc) {
  const [queues, jobs, failedJobs, activeKeys] = await Promise.all([
    QueueConfig.countDocuments({ projectId: project._id, deletedAt: null }),
    JobRecord.countDocuments({ projectId: project._id }),
    JobRecord.countDocuments({ projectId: project._id, status: "failed" }),
    ApiKey.countDocuments({ projectId: project._id, revokedAt: null }),
  ]);
  return { queues, jobs, failedJobs, activeKeys };
}

export async function listAudit(project: ProjectDoc, limit = 20) {
  return AuditLog.find({ projectId: project._id }).sort({ createdAt: -1 }).limit(limit).lean();
}

export function assertProjectOwner(project: ProjectDoc, ownerObjectId: string) {
  if (String(project.ownerId) !== ownerObjectId) {
    throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
  }
}
