import { Request, Response, NextFunction } from "express";
import { HttpError } from "../lib/http-error.js";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.statusCode).json({ ok: false, error: err.message, details: err.details ?? null });
  }
  console.error(err);
  return res.status(500).json({ ok: false, error: "Internal server error" });
}
