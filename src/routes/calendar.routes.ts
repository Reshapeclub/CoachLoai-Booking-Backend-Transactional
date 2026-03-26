import { Router } from "express";
import { supabaseAdmin } from "../db/supabase.js";
import { buildBookingIcs } from "../utils/calendar-ics.js";

const router = Router();

router.get("/booking/:bookingId.ics", async (req, res, next) => {
  try {
    const bookingId = req.params.bookingId;
    const { data, error } = await supabaseAdmin
      .from("bookings")
      .select("id, session_id, sessions(start_at, end_at, session_types(name), location_id)")
      .eq("id", bookingId)
      .maybeSingle();

    if (error) throw error;
    if (!data || !data.sessions) {
      return res.status(404).json({ ok: false, message: "Booking not found" });
    }

    const session = data.sessions as {
      start_at?: string;
      end_at?: string;
      location_id?: string | null;
      session_types?: { name?: string | null } | null;
    };

    if (!session.start_at || !session.end_at) {
      return res.status(422).json({ ok: false, message: "Session timing missing" });
    }

    const title = session.session_types?.name?.trim() || "CLM Booking";
    const text = buildBookingIcs({
      bookingId,
      startAt: session.start_at,
      endAt: session.end_at,
      title,
      description: `Your booking is confirmed.\nBooking ID: ${bookingId}\nSession ID: ${data.session_id ?? "—"}`,
    });

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="booking-${bookingId}.ics"`);
    res.status(200).send(text);
  } catch (e) {
    next(e);
  }
});

export default router;
