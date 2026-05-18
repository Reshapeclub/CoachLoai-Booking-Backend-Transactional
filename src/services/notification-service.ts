import { DateTime } from "luxon";
import { supabaseAdmin } from "../db/supabase.js";
import { sendEmail, isEmailConfigured } from "./email-provider.js";
import { env } from "../config/env.js";

type NotificationType =
  | "booking_confirmed"
  | "booking_cancelled"
  | "waitlist_space_available"
  | "meeting_confirmed";

/** Display stored UTC instants in UK local time (GMT/BST), same zone as admin meeting slots. */
function formatMeetingWhenLondon(startIso: unknown, endIso?: unknown): string {
  if (typeof startIso !== "string" || !startIso.trim()) return "—";
  const start = DateTime.fromISO(startIso, { setZone: true }).setZone("Europe/London");
  if (!start.isValid) return "—";
  const tzLabel = start.offsetNameShort || "UK";
  const datePart = start.toFormat("EEE d MMM yyyy");
  const timePart = start.toFormat("HH:mm");
  if (typeof endIso === "string" && endIso.trim()) {
    const end = DateTime.fromISO(endIso, { setZone: true }).setZone("Europe/London");
    if (end.isValid) {
      return `${datePart} · ${timePart}–${end.toFormat("HH:mm")} (${tzLabel})`;
    }
  }
  return `${datePart} · ${timePart} (${tzLabel})`;
}

function buildEmailContent(
  type: NotificationType,
  payload: Record<string, unknown>,
  fullName?: string | null
): { subject: string; text: string } {
  const name = typeof fullName === "string" && fullName.trim() ? fullName.trim() : "there";
  const greeting = `Hi ${name},\n\n`;
  const bookingId = typeof payload.bookingId === "string" && payload.bookingId.trim() ? payload.bookingId.trim() : "";
  const addToCalendarUrl =
    typeof payload.addToCalendarUrl === "string" && payload.addToCalendarUrl.trim()
      ? payload.addToCalendarUrl.trim()
      : bookingId
        ? `${env.APP_BASE_URL.replace(/\/$/, "")}/calendar/booking/${encodeURIComponent(bookingId)}.ics`
        : "";
  let body: string;
  switch (type) {
    case "booking_confirmed":
      body = `Your booking has been confirmed.\n\nBooking ID: ${payload.bookingId ?? "—"}\nSession ID: ${payload.sessionId ?? "—"}${
        addToCalendarUrl
          ? `\n\nAdd to calendar: ${addToCalendarUrl}`
          : ""
      }`;
      break;
    case "booking_cancelled":
      body = `Your booking has been cancelled.\n\nBooking ID: ${payload.bookingId ?? "—"}\nRefund applied: ${payload.refundApplied === true ? "Yes" : "No"}${payload.reason ? `\nReason: ${payload.reason}` : ""}`;
      break;
    case "waitlist_space_available":
      body = `A space has opened up for a session you were waiting for.\n\nSession ID: ${payload.sessionId ?? "—"}\n\nLog in to book your spot.`;
      break;
    case "meeting_confirmed": {
      const meetingName =
        typeof payload.meetingTypeName === "string" && payload.meetingTypeName.trim()
          ? payload.meetingTypeName.trim()
          : "Meeting";
      const when = formatMeetingWhenLondon(payload.meetingStart, payload.meetingEnd);
      const locationName =
        typeof payload.locationName === "string" && payload.locationName.trim()
          ? payload.locationName.trim()
          : "";
      body = `Your ${meetingName} has been booked.\n\nWhen: ${when}${
        locationName ? `\nLocation: ${locationName}` : ""
      }\n\nReference: ${payload.meetingId ?? "—"}`;
      break;
    }
    default:
      body = JSON.stringify(payload);
  }
  const subjectByType: Record<NotificationType, string> = {
    booking_confirmed: "Booking confirmed",
    booking_cancelled: "Booking cancelled",
    waitlist_space_available: "Space available on waitlist",
    meeting_confirmed: "Meeting booked",
  };
  return {
    subject: subjectByType[type as NotificationType] ?? "Notification",
    text: greeting + body,
  };
}

export async function processUnsentEmailNotifications(): Promise<number> {
  if (!isEmailConfigured()) return 0;

  const { data: notifications, error: fetchError } = await supabaseAdmin
    .from("notifications")
    .select("id, member_id, type, payload")
    .eq("channel", "email")
    .is("sent_at", null)
    .order("created_at", { ascending: true })
    .limit(50);

  if (fetchError) {
    console.error("[notification-service] Fetch error:", fetchError);
    return 0;
  }
  if (!notifications?.length) return 0;

  const memberIds = [...new Set(notifications.map((n) => n.member_id))];
  const { data: profiles } = await supabaseAdmin
    .from("profiles")
    .select("id, email, full_name")
    .in("id", memberIds);

  const profileByMemberId = new Map(
    (profiles ?? []).map((p) => [p.id, p])
  );

  let sentCount = 0;
  for (const n of notifications) {
    const profile = profileByMemberId.get(n.member_id);
    const email = profile?.email;
    if (!email || typeof email !== "string" || !email.trim()) {
      await supabaseAdmin
        .from("notifications")
        .update({ sent_at: new Date().toISOString() })
        .eq("id", n.id);
      continue;
    }

    const { subject, text } = buildEmailContent(
      n.type as NotificationType,
      (n.payload as Record<string, unknown>) ?? {},
      profile?.full_name
    );

    const ok = await sendEmail({ to: email, subject, text });
    if (ok) {
      await supabaseAdmin
        .from("notifications")
        .update({ sent_at: new Date().toISOString() })
        .eq("id", n.id);
      sentCount++;
    }
  }

  return sentCount;
}
