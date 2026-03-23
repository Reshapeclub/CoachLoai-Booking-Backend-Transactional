import { Request, Response, NextFunction } from "express";
import { jwtVerify } from "jose";
import { HttpError } from "../lib/http-error.js";
import { env } from "../config/env.js";
import type { Role, RequestUser } from "../types/domain.js";

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.header("authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice("bearer ".length).trim();
    if (!token) return next(new HttpError(401, "Authentication required"));
    if (!env.JWT_SECRET) return next(new HttpError(500, "JWT not configured"));

    (async () => {
      try {
        const secret = new TextEncoder().encode(env.JWT_SECRET);
        const { payload } = await jwtVerify(token, secret, {
          algorithms: ["HS256"],
        });

        const rawId = (payload as { sub?: string; id?: unknown }).id ?? (payload as { sub?: string }).sub;
        const id =
          typeof rawId === "string"
            ? rawId
            : typeof rawId === "number"
              ? String(rawId)
              : undefined;
        const roleCandidate =
          typeof payload.role === "string"
            ? payload.role
            : typeof payload.user_role === "string"
              ? payload.user_role
              : undefined;

        const role = (roleCandidate?.toLowerCase() as Role | undefined) ?? undefined;

        if (!id || !role) throw new HttpError(401, "Authentication required");

        const email =
          typeof payload.email === "string"
            ? payload.email
            : typeof payload.user_email === "string"
              ? payload.user_email
              : undefined;

        const user: RequestUser = { id, role, ...(email ? { email } : {}) };
        req.user = user;
        next();
      } catch (err) {
        const httpErr = err instanceof HttpError ? err : new HttpError(401, "Invalid token");
        next(httpErr);
      }
    })();
    return;
  }

  const userId = req.header("x-user-id");
  const role = req.header("x-user-role") as "member" | "coach" | "admin" | undefined;
  if (!userId || !role) return next(new HttpError(401, "Authentication required"));
  req.user = { id: userId, role };
  next();
}
