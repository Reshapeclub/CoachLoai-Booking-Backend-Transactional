export function calendarTodayYmd(iso = new Date().toISOString()): string {
  return iso.slice(0, 10);
}

/** Calendar day immediately after `ymd` (UTC). */
export function calendarDayAfter(ymd: string): string {
  const base = String(ymd ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) return "";
  const [y, m, d] = base.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** Queued plan starts the day after the membership current window ends (natural rollover). */
export function queuedPlanIsImmediateSuccessor(
  membership: Record<string, unknown>,
  queuedStartYmd: string,
): boolean {
  const endYmd = membership.end_date ? String(membership.end_date).slice(0, 10) : "";
  const queuedStart = String(queuedStartYmd ?? "").slice(0, 10);
  if (!endYmd || !queuedStart) return false;
  return queuedStart === calendarDayAfter(endYmd);
}

/** True when the membership row covers the given calendar day (live plan). */
export function membershipCoversToday(
  membership: Record<string, unknown>,
  options?: { todayYmd?: string; nowMs?: number },
): boolean {
  const status = String(membership.status ?? "active").trim().toLowerCase();
  if (status === "terminated" || status === "ended") return false;

  const nowMs = options?.nowMs ?? Date.now();
  const termMs = membership.termination_date
    ? new Date(String(membership.termination_date)).getTime()
    : NaN;
  if (Number.isFinite(termMs) && termMs <= nowMs) return false;

  const today = (options?.todayYmd ?? calendarTodayYmd()).slice(0, 10);
  const startYmd = membership.start_date
    ? String(membership.start_date).slice(0, 10)
    : "";
  const endYmd = membership.end_date ? String(membership.end_date).slice(0, 10) : "";
  if (!startYmd || startYmd > today) return false;
  if (endYmd && endYmd < today) return false;
  return true;
}

/**
 * Safe to copy a queued plan onto `member_memberships`.
 */
export function shouldSyncQueuedPlanToMembership(
  membership: Record<string, unknown>,
  queuedStartYmd: string,
  options?: { todayYmd?: string; nowMs?: number },
): boolean {
  const today = (options?.todayYmd ?? calendarTodayYmd()).slice(0, 10);
  const queuedStart = queuedStartYmd.slice(0, 10);
  if (!queuedStart) return false;

  if (
    membershipAdminRetainsPastCurrentPlan(membership, {
      ...options,
      queuedStartYmd: queuedStart,
    })
  ) {
    return false;
  }

  if (queuedStart > today) return false;

  if (membershipCoversToday(membership, options)) {
    const endYmd = membership.end_date ? String(membership.end_date).slice(0, 10) : "";
    return Boolean(endYmd && endYmd < queuedStart);
  }

  return true;
}

/**
 * Admin set an explicit current plan on `member_memberships` that no longer covers today
 * (e.g. shortened to 18–24 May while today is later). Do not auto-promote queued plans onto MM.
 */
export function membershipAdminRetainsPastCurrentPlan(
  membership: Record<string, unknown>,
  options?: { todayYmd?: string; nowMs?: number; queuedStartYmd?: string },
): boolean {
  if (membershipCoversToday(membership, options)) return false;

  const queuedStart = options?.queuedStartYmd
    ? String(options.queuedStartYmd).slice(0, 10)
    : "";
  if (queuedStart && queuedPlanIsImmediateSuccessor(membership, queuedStart)) {
    return false;
  }

  const endYmd = membership.end_date ? String(membership.end_date).slice(0, 10) : "";
  if (!endYmd) return false;

  const today = (options?.todayYmd ?? calendarTodayYmd()).slice(0, 10);
  if (endYmd >= today) return false;

  const updatedAt = membership.updated_at ? String(membership.updated_at).trim() : "";
  if (!updatedAt) return false;

  const endMs = new Date(`${endYmd}T23:59:59.999Z`).getTime();
  const updatedMs = new Date(updatedAt).getTime();
  if (!Number.isFinite(endMs) || !Number.isFinite(updatedMs)) return false;

  return updatedMs > endMs;
}

/** After applying to MM, mark training plan row active when start is today or in the past. */
export function shouldPromoteQueuedTrainingPlanToday(
  queuedStartYmd: string,
  todayYmd?: string,
): boolean {
  const start = String(queuedStartYmd ?? "").slice(0, 10);
  const today = (todayYmd ?? calendarTodayYmd()).slice(0, 10);
  return Boolean(start && start <= today);
}
