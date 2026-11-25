import { ApiKey, AuditLog, createApiKeySecret, createId, type ProjectDoc } from "@taskflow/server";
import { API_SCOPES, EXTEND_API_KEYS_LIMIT, REVOKE_API_KEYS_LIMIT, SET_API_KEY_SCOPES_LIMIT, type ApiScope } from "@taskflow/shared";
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

export async function updateApiKey(
  project: ProjectDoc,
  keyId: string,
  input: { name?: string; description?: string; scopes?: ApiScope[]; expiresInDays?: number | null },
  actorId: string,
) {
  const key = await ApiKey.findOne({ projectId: project._id, publicId: keyId });
  if (!key) throw new AppError(404, "API_KEY_NOT_FOUND", "API key not found");
  if (key.revokedAt) throw new AppError(409, "API_KEY_REVOKED", "A revoked key cannot be changed");
  const previousName = key.name;
  const previousScopes = [...key.scopes];
  const previousExpiresAt = key.expiresAt?.toISOString() ?? null;
  if (input.name) key.name = input.name.trim();
  if (typeof input.description === "string") key.description = input.description.trim();
  if (input.scopes) {
    const selected = new Set(input.scopes);
    key.scopes = API_SCOPES.filter((scope) => selected.has(scope));
  }
  if (input.expiresInDays === null) {
    key.set("expiresAt", null);
  } else if (typeof input.expiresInDays === "number") {
    key.expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);
  }
  await key.save();
  await AuditLog.create({
    projectId: project._id,
    actorType: "user",
    actorId,
    action: "api_key.updated",
    targetType: "api_key",
    targetId: key.publicId,
    metadata: {
      name: key.name,
      previousName,
      ...(input.scopes ? { scopes: key.scopes, previousScopes } : {}),
      ...(input.expiresInDays !== undefined ? { expiresAt: key.expiresAt?.toISOString() ?? null, previousExpiresAt } : {}),
    },
  });
  return key;
}

export async function extendApiKeys(project: ProjectDoc, input: { expiresInDays: number; limit?: number }, actorId: string) {
  const limit = Math.min(input.limit ?? 20, EXTEND_API_KEYS_LIMIT);
  const selected = await ApiKey.find({
    projectId: project._id,
    revokedAt: null,
    expiresAt: { $exists: true, $ne: null },
  })
    .sort({ createdAt: 1 })
    .limit(limit);
  const keyIds: string[] = [];
  let skipped = 0;
  for (const key of selected) {
    try {
      const current = await ApiKey.findOne({ projectId: project._id, publicId: key.publicId, revokedAt: null });
      if (!current?.expiresAt) {
        skipped += 1;
        continue;
      }
      await updateApiKey(project, current.publicId, { expiresInDays: input.expiresInDays }, actorId);
      keyIds.push(current.publicId);
    } catch (error) {
      if (error instanceof AppError && (error.status === 404 || error.status === 409)) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }
  return { extended: keyIds.length, skipped, keyIds };
}

function orderedScopes(scopes: readonly string[]) {
  const selected = new Set(scopes);
  return API_SCOPES.filter((scope) => selected.has(scope));
}

function sameScopes(current: readonly string[], next: readonly string[]) {
  return current.length === next.length && current.every((scope, index) => scope === next[index]);
}

export async function setApiKeyScopes(project: ProjectDoc, input: { scopes: ApiScope[]; limit?: number }, actorId: string) {
  const limit = Math.min(input.limit ?? 20, SET_API_KEY_SCOPES_LIMIT);
  const next = orderedScopes(input.scopes);
  const selected = await ApiKey.find({
    projectId: project._id,
    revokedAt: null,
  })
    .sort({ createdAt: 1 })
    .limit(limit);
  const keyIds: string[] = [];
  let skipped = 0;
  for (const key of selected) {
    try {
      const current = await ApiKey.findOne({ projectId: project._id, publicId: key.publicId, revokedAt: null });
      if (!current) {
        skipped += 1;
        continue;
      }
      if (sameScopes(current.scopes, next)) {
        skipped += 1;
        continue;
      }
      await updateApiKey(project, current.publicId, { scopes: next }, actorId);
      keyIds.push(current.publicId);
    } catch (error) {
      if (error instanceof AppError && (error.status === 404 || error.status === 409)) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }
  return { updated: keyIds.length, skipped, keyIds };
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

export async function revokeApiKeys(project: ProjectDoc, input: { limit?: number }, actorId: string) {
  const limit = Math.min(input.limit ?? 20, REVOKE_API_KEYS_LIMIT);
  const selected = await ApiKey.find({
    projectId: project._id,
    revokedAt: null,
  })
    .sort({ createdAt: 1 })
    .limit(limit);
  const keyIds: string[] = [];
  let skipped = 0;
  for (const key of selected) {
    const current = await ApiKey.findOne({ projectId: project._id, publicId: key.publicId, revokedAt: null });
    if (!current) {
      skipped += 1;
      continue;
    }
    await revokeApiKey(project, current.publicId, actorId);
    keyIds.push(current.publicId);
  }
  return { revoked: keyIds.length, skipped, keyIds };
}
