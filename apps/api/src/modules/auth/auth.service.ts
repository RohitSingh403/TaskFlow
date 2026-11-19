import { createId, randomToken, RefreshToken, sha256, User } from "@taskflow/server";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { env } from "../../config.js";
import { AppError } from "../../errors.js";

let dummyHash = "";

export async function prepareAuth() {
  dummyHash = await argon2.hash("taskflow-timing-placeholder", { type: argon2.argon2id });
}

function signAccessToken(userPublicId: string) {
  return jwt.sign({ sub: userPublicId, typ: "access" }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions["expiresIn"],
  });
}

async function issueRefreshToken(userId: unknown, meta: { userAgent?: string; ip?: string }) {
  const token = `rfr_${randomToken(32)}`;
  await RefreshToken.create({
    userId,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
    userAgent: meta.userAgent?.slice(0, 300),
    ip: meta.ip?.slice(0, 80),
  });
  return token;
}

export async function registerUser(input: { name: string; email: string; password: string }, meta: { userAgent?: string; ip?: string }) {
  const email = input.email.toLowerCase();
  const existing = await User.findOne({ email });
  if (existing) throw new AppError(409, "EMAIL_IN_USE", "An account with that email already exists");
  const user = await User.create({
    publicId: createId("user"),
    name: input.name,
    email,
    passwordHash: await argon2.hash(input.password, { type: argon2.argon2id }),
  });
  return {
    user,
    accessToken: signAccessToken(user.publicId),
    refreshToken: await issueRefreshToken(user._id, meta),
  };
}

export async function loginUser(input: { email: string; password: string }, meta: { userAgent?: string; ip?: string }) {
  const user = await User.findOne({ email: input.email.toLowerCase() }).select("+passwordHash");
  const valid = await argon2.verify(user?.passwordHash || dummyHash, input.password);
  if (!user || !valid) throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
  return {
    user,
    accessToken: signAccessToken(user.publicId),
    refreshToken: await issueRefreshToken(user._id, meta),
  };
}

const REFRESH_REUSE_GRACE_MS = 15_000;
const refreshRotations = new Map<string, Promise<{ user: InstanceType<typeof User>; accessToken: string; refreshToken: string }>>();

export function rotateRefreshToken(raw: string | undefined, meta: { userAgent?: string; ip?: string }) {
  if (!raw) throw new AppError(401, "UNAUTHORIZED", "Refresh token is missing");
  const tokenHash = sha256(raw);
  const pending = refreshRotations.get(tokenHash);
  if (pending) return pending;
  const rotation = rotateRefreshTokenOnce(tokenHash, meta).finally(() => {
    if (refreshRotations.get(tokenHash) === rotation) refreshRotations.delete(tokenHash);
  });
  refreshRotations.set(tokenHash, rotation);
  return rotation;
}

async function rotateRefreshTokenOnce(tokenHash: string, meta: { userAgent?: string; ip?: string }) {
  const current = await RefreshToken.findOne({ tokenHash });
  if (!current || current.expiresAt.getTime() <= Date.now()) {
    throw new AppError(401, "UNAUTHORIZED", "Refresh token is invalid or expired");
  }
  if (current.revokedAt) {
    const recentlyRotated = current.replacedByHash && Date.now() - current.revokedAt.getTime() < REFRESH_REUSE_GRACE_MS;
    if (!recentlyRotated) {
      await RefreshToken.updateMany({ userId: current.userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
    }
    throw new AppError(401, "REFRESH_REUSED", "Refresh token reuse was detected. Sign in again.");
  }
  const user = await User.findById(current.userId);
  if (!user) throw new AppError(401, "UNAUTHORIZED", "Refresh token is invalid or expired");
  current.revokedAt = new Date();
  const refreshToken = await issueRefreshToken(user._id, meta);
  current.replacedByHash = sha256(refreshToken);
  await current.save();
  return { user, accessToken: signAccessToken(user.publicId), refreshToken };
}

export async function revokeRefreshToken(raw: string | undefined) {
  if (!raw) return;
  await RefreshToken.updateOne({ tokenHash: sha256(raw), revokedAt: null }, { $set: { revokedAt: new Date() } });
}

export async function updateProfile(userPublicId: string, name: string) {
  const user = await User.findOneAndUpdate({ publicId: userPublicId }, { name }, { new: true });
  if (!user) throw new AppError(401, "UNAUTHORIZED", "Account not found");
  return user;
}

export async function changePassword(userPublicId: string, currentPassword: string, newPassword: string) {
  const user = await User.findOne({ publicId: userPublicId }).select("+passwordHash");
  if (!user) throw new AppError(401, "UNAUTHORIZED", "Account not found");
  const valid = await argon2.verify(user.passwordHash, currentPassword);
  if (!valid) throw new AppError(400, "INVALID_CREDENTIALS", "Current password is incorrect");
  user.passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
  await user.save();
  await RefreshToken.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
}
