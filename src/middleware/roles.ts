import { Request, Response, NextFunction } from "express";
import { HttpError } from "../lib/http-error.js";
import type { Role } from "../types/domain.js";

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, "Authentication required"));
    if (!roles.includes(req.user.role)) return next(new HttpError(403, "Forbidden"));
    next();
  };
}
