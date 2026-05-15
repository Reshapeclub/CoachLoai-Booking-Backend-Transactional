import { Request, Response, NextFunction } from "express";
import { HttpError } from "../lib/http-error.js";
import type { Role } from "../types/domain.js";
import { supabaseAdmin } from "../db/supabase.js";

function isCoachLikeAdminRole(role: string): boolean {
  const normalized = role.trim().toLowerCase().replace(/\s+/g, "");
  return normalized === "coach" || normalized === "headcoach";
}

/** GET /admin/staff (optional ?includeStats=1) — team directory for coaches and admins. */
function isStaffDirectoryListRequest(req: Request): boolean {
  return req.method === "GET" && (req.path === "/staff" || req.path === "/staff/");
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, "Authentication required"));
    if (!req.user.role || !roles.includes(req.user.role)) return next(new HttpError(403, "Forbidden"));
    next();
  };
}

export function requireProfileRole(...roles: Role[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, "Authentication required"));

    const { data, error } = await supabaseAdmin
      .from("profiles")
      .select("role")
      .eq("id", req.user.id)
      .maybeSingle();

    if (error) return next(new HttpError(500, "Failed to verify role", error));

    const dbRole = typeof data?.role === "string" ? (data.role.toLowerCase() as Role) : undefined;
    if (!dbRole || !roles.includes(dbRole)) return next(new HttpError(403, "Forbidden"));

    req.user.role = dbRole;
    return next();
  };
}

export function requireAdminTableAccess() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, "Authentication required"));

    const { id, email } = req.user;
    let adminRecord: { role?: unknown } | null = null;

    const byId = await supabaseAdmin.from("admins").select("id, role").eq("id", id).maybeSingle();
    if (byId.error) return next(new HttpError(500, "Failed to verify admin access", byId.error));
    adminRecord = byId.data;

    if (!adminRecord && email) {
      const byEmail = await supabaseAdmin.from("admins").select("id, role").eq("email", email).maybeSingle();
      if (byEmail.error) return next(new HttpError(500, "Failed to verify admin access", byEmail.error));
      adminRecord = byEmail.data;
    }

    if (!adminRecord) return next(new HttpError(403, "Forbidden"));

    const role = typeof adminRecord.role === "string" ? adminRecord.role.toLowerCase() : "admin";

    if (role === "admin") {
      req.user.role = "admin";
      return next();
    }

    if (isStaffDirectoryListRequest(req) && isCoachLikeAdminRole(role)) {
      req.user.role = "coach";
      return next();
    }

    return next(new HttpError(403, "Forbidden"));
  };
}
