import { supabaseAdmin } from "../db/supabase.js";
import { sendEmail, isEmailConfigured } from "./email-provider.js";

type NotificationType =
  | "booking_confirmed"
  | "booking_cancelled"
  | "waitlist_space_available";

function buildEmailContent(
  type: NotificationType,
  payload: Record<string, unknown>,
  fullName?: string | null
): { subject: string; text: string } {
  const name = typeof fullName === "string" && fullName.trim() ? fullName.trim() : "there";
  const greeting = `Hi ${name},\n\n`;
  let body: string;
  switch (type) {
    case "booking_confirmed":
      body = `Your booking has been confirmed.\n\nBooking ID: ${payload.bookingId ?? "—"}\nSession ID: ${payload.sessionId ?? "—"}`;
      break;
    case "booking_cancelled":
      body = `Your booking has been cancelled.\n\nBooking ID: ${payload.bookingId ?? "—"}\nRefund applied: ${payload.refundApplied === true ? "Yes" : "No"}${payload.reason ? `\nReason: ${payload.reason}` : ""}`;
      break;
    case "waitlist_space_available":
      body = `A space has opened up for a session you were waiting for.\n\nSession ID: ${payload.sessionId ?? "—"}\n\nLog in to book your spot.`;
      break;
    default:
      body = JSON.stringify(payload);
  }
  return {
    subject: type === "booking_confirmed" ? "Booking confirmed" : type === "booking_cancelled" ? "Booking cancelled" : type === "waitlist_space_available" ? "Space available on waitlist" : "Notification",
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
