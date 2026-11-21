import { ApiKey, AuditLog, createApiKeySecret, createId, type ProjectDoc } from "@taskflow/server";
import type { ApiScope } from "@taskflow/shared";
import { AppError } from "../../errors.js";

export async function listApiKeys(project: ProjectDoc) {
  return ApiKey.find({ projectId: project._id }).sort({ createdAt: -1 });
}

export async function createApiKey(
  project: ProjectDoc,
  input: { name: string; description?: string; scopes: ApiScope[]; expiresInDays?: number },
  actorId: string,
) {
  const secret = createApiKeySecret();
  const key = await ApiKey.create({
    publicId: createId("key"),
    projectId: project._id,
    name: input.name,
    description: input.description ?? "",
    prefix: secret.prefix,
    keyHash: secret.hash,
    scopes: input.scopes,
    expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : undefined,
    createdBy: actorId,
  });
  await AuditLog.create({
    projectId: project._id,
    actorType: "user",
    actorId,
    action: "api_key.created",
    targetType: "api_key",
    targetId: key.publicId,
    metadata: { name: key.name, scopes: key.scopes, expiresAt: key.expiresAt?.toISOString() ?? null },
  });
  return { key, secret: secret.secret };
}

export async function revokeApiKey(project: ProjectDoc, keyId: string, actorId: string) {
  const key = await ApiKey.findOne({ projectId: project._id, publicId: keyId });
  if (!key) throw new AppError(404, "API_KEY_NOT_FOUND", "API key not found");
  if (!key.revokedAt) {
    key.revokedAt = new Date();
    await key.save();
    await AuditLog.create({
      projectId: project._id,
      actorType: "user",
      actorId,
      action: "api_key.revoked",
      targetType: "api_key",
      targetId: key.publicId,
      metadata: { name: key.name },
    });
  }
  return key;
}
