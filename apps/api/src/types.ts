import type { ProjectDoc } from "@taskflow/server";

export interface AuthContext {
  type: "user" | "api_key";
  userPublicId: string;
  userObjectId: string;
  scopes: string[];
  label: string;
  apiKeyId?: string;
  projectPublicId?: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      project?: ProjectDoc;
      projectRole?: "owner" | "member";
    }
    interface Locals {
      requestId?: string;
    }
  }
}

export {};
