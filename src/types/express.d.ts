import type { RequestUser } from "./domain.js";

declare global {
  namespace Express {
    interface Request { user?: RequestUser; }
  }
}

export {};
