import type { PageMeta } from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

type TokenAccess = {
  get(): string | null;
  set(token: string | null): void;
  clear(): void;
};

let auth: TokenAccess = {
  get: () => null,
  set: () => undefined,
  clear: () => undefined,
};

export function bindAuth(access: TokenAccess) {
  auth = access;
}

let refreshing: Promise<string | null> | null = null;
let restoring: Promise<{ data: { accessToken: string }; meta: PageMeta }> | null = null;

export function restoreSession() {
  if (!restoring) {
    restoring = api<{ accessToken: string }>("/auth/refresh", { method: "POST" }, false).finally(() => {
      restoring = null;
    });
  }
  return restoring;
}

async function refreshAccessToken() {
  if (!refreshing) {
    refreshing = fetch("/api/v1/auth/refresh", { method: "POST", credentials: "include" })
      .then(async (response) => {
        if (!response.ok) return null;
        const body = await response.json();
        return (body.data?.accessToken as string | undefined) ?? null;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

export async function api<T>(path: string, init: RequestInit = {}, retry = true): Promise<{ data: T; meta: PageMeta }> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const token = auth.get();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`/api/v1${path}`, { ...init, headers, credentials: "include" });
  if (response.status === 401 && retry && !path.startsWith("/auth/login") && !path.startsWith("/auth/register")) {
    const next = await refreshAccessToken();
    if (next) {
      auth.set(next);
      return api<T>(path, init, false);
    }
    auth.clear();
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    throw new ApiError(
      response.status,
      body?.error?.code ?? "REQUEST_FAILED",
      body?.error?.message ?? "Request failed",
      body?.error?.details,
    );
  }
  return { data: body.data as T, meta: body.meta ?? {} };
}
