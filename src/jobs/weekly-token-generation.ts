import { TokenService } from "../services/token-service.js";

function getCurrentWeekStartIso(now = new Date()): string {
  const d = new Date(now);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export async function runWeeklyTokenGeneration() {
  const service = new TokenService();
  return service.generateWeeklyTokens(getCurrentWeekStartIso());
}
