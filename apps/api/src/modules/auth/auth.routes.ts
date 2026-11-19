import { Router } from "express";
import { changePasswordSchema, loginSchema, registerSchema, updateProfileSchema } from "@taskflow/shared";
import { toUser } from "../../dto.js";
import { sendCreated, sendOk } from "../../http.js";
import { asyncHandler, requireScope, validateBody } from "../../middleware/common.js";
import { requireAuth } from "../../middleware/auth.js";
import { authLimiter, refreshLimiter } from "../../rate-limit.js";
import { changePassword, loginUser, registerUser, revokeRefreshToken, rotateRefreshToken, updateProfile } from "./auth.service.js";

export const authRouter = Router();
const COOKIE = "tf_refresh";

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/api/v1/auth",
    maxAge: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 7) * 24 * 60 * 60 * 1000,
  };
}

function meta(req: { get(name: string): string | undefined; ip?: string }) {
  return { userAgent: req.get("user-agent"), ip: req.ip };
}

authRouter.post(
  "/register",
  authLimiter,
  validateBody(registerSchema),
  asyncHandler(async (req, res) => {
    const session = await registerUser(req.body, meta(req));
    res.cookie(COOKIE, session.refreshToken, cookieOptions());
    sendCreated(res, { user: toUser(session.user), accessToken: session.accessToken });
  }),
);

authRouter.post(
  "/login",
  authLimiter,
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const session = await loginUser(req.body, meta(req));
    res.cookie(COOKIE, session.refreshToken, cookieOptions());
    sendOk(res, { user: toUser(session.user), accessToken: session.accessToken });
  }),
);

authRouter.post(
  "/refresh",
  refreshLimiter,
  asyncHandler(async (req, res) => {
    const session = await rotateRefreshToken(req.cookies?.[COOKIE], meta(req));
    res.cookie(COOKIE, session.refreshToken, cookieOptions());
    sendOk(res, { user: toUser(session.user), accessToken: session.accessToken });
  }),
);

authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    await revokeRefreshToken(req.cookies?.[COOKIE]);
    res.clearCookie(COOKIE, { path: "/api/v1/auth" });
    sendOk(res, { loggedOut: true });
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { User } = await import("@taskflow/server");
    const user = await User.findOne({ publicId: req.auth!.userPublicId });
    if (!user) {
      res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Account not found" }, meta: { requestId: res.locals.requestId } });
      return;
    }
    sendOk(res, toUser(user));
  }),
);

authRouter.patch(
  "/me",
  requireAuth,
  requireScope("*"),
  validateBody(updateProfileSchema),
  asyncHandler(async (req, res) => {
    if (req.auth?.type !== "user") {
      res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Profile updates require a user session" }, meta: { requestId: res.locals.requestId } });
      return;
    }
    const user = await updateProfile(req.auth.userPublicId, req.body.name);
    sendOk(res, toUser(user));
  }),
);

authRouter.post(
  "/change-password",
  requireAuth,
  validateBody(changePasswordSchema),
  asyncHandler(async (req, res) => {
    if (req.auth?.type !== "user") {
      res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Password changes require a user session" }, meta: { requestId: res.locals.requestId } });
      return;
    }
    await changePassword(req.auth.userPublicId, req.body.currentPassword, req.body.newPassword);
    res.clearCookie(COOKIE, { path: "/api/v1/auth" });
    sendOk(res, { passwordUpdated: true });
  }),
);
