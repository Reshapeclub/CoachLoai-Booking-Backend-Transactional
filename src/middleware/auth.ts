import { Request, Response, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";
import { jwtVerify } from "jose";
import { HttpError } from "../lib/http-error.js";
import { env } from "../config/env.js";
import type { RequestUser } from "../types/domain.js";

const supabaseAuth = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function getBearerToken(req: Request): string {
  const authHeader = req.header("authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    throw new HttpError(401, "Authentication required");
  }

  const token = authHeader.slice("bearer ".length).trim();
  if (!token) throw new HttpError(401, "Authentication required");
  return token;
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!env.SUPABASE_ANON_KEY) {
    return next(new HttpError(500, "Supabase auth is not configured"));
  }

  try {
    const token = getBearerToken(req);
    // Supabase validates token signature, issuer, and expiry on its side.
    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error || !data.user) throw new HttpError(401, "Invalid token");

    const id = data.user.id;
    const email = typeof data.user.email === "string" ? data.user.email : undefined;

    const user: RequestUser = { id, ...(email ? { email } : {}) };
    req.user = user;
    return next();
  } catch (err) {
    const httpErr = err instanceof HttpError ? err : new HttpError(401, "Invalid token");
    return next(httpErr);
  }
}

export async function requireAdminAuth(req: Request, _res: Response, next: NextFunction) {
  if (!env.JWT_SECRET) {
    return next(new HttpError(500, "Admin auth is not configured"));
  }

  try {
    const token = getBearerToken(req);
    //console.log("token", token);
    const secret = new TextEncoder().encode(env.JWT_SECRET);
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    //console.log("payload", payload);
    const rawId = (payload as { id?: unknown; sub?: unknown }).id ?? (payload as { sub?: unknown }).sub;
    const id =
      typeof rawId === "string"
        ? rawId
        : typeof rawId === "number"
          ? String(rawId)
          : undefined;
    if (!id) throw new HttpError(401, "Invalid token");

    const email =
      typeof (payload as { email?: unknown }).email === "string"
        ? ((payload as { email?: unknown }).email as string)
        : undefined;
    //console.log("email", email);
    const role =
      typeof (payload as { role?: unknown }).role === "string"
        ? ((payload as { role?: string }).role?.toLowerCase() === "admin" ? "admin" : undefined)
        : undefined;
    //console.log("role", role);
    const user: RequestUser = { id, ...(email ? { email } : {}), ...(role ? { role } : {}) };
    //console.log("user", user);
    req.user = user;
    return next();
  } catch (err) {
    const httpErr = err instanceof HttpError ? err : new HttpError(401, "Invalid token");
    return next(httpErr);
  }
}
