import { DateTime } from "luxon";
import { UK_BOOKING_TIMEZONE } from "../lib/uk-booking-time.js";

/** Parse DB timestamptz (UTC instant) the same way as booking emails / admin schedule. */
function parseStoredInstant(iso: string): DateTime {
  const dt = DateTime.fromISO(iso, { setZone: true });
  if (!dt.isValid) throw new Error(`Invalid datetime: ${iso}`);
  return dt.toUTC();
}

function toUtcIcsStamp(dt: DateTime): string {
  return `${dt.toUTC().toFormat("yyyyMMdd'T'HHmmss")}Z`;
}

/** Wall-clock date/time in Europe/London for DTSTART/DTEND;TZID=… */
function toLondonIcsLocal(dt: DateTime): string {
  return dt.setZone(UK_BOOKING_TIMEZONE).toFormat("yyyyMMdd'T'HHmmss");
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function buildIcsEvent(params: {
  uid: string;
  prodId: string;
  startAt: string;
  endAt: string;
  title: string;
  description?: string;
}): string {
  const startDt = parseStoredInstant(params.startAt);
  const endDt = parseStoredInstant(params.endAt);
  const stamp = toUtcIcsStamp(DateTime.utc());
  const start = toLondonIcsLocal(startDt);
  const end = toLondonIcsLocal(endDt);
  const uid = params.uid;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${params.prodId}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-TIMEZONE:${UK_BOOKING_TIMEZONE}`,
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;TZID=${UK_BOOKING_TIMEZONE}:${start}`,
    `DTEND;TZID=${UK_BOOKING_TIMEZONE}:${end}`,
    `SUMMARY:${escapeIcsText(params.title)}`,
    `DESCRIPTION:${escapeIcsText(params.description ?? "")}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].filter(Boolean);
  return lines.join("\r\n");
}

export function buildBookingIcs(params: {
  bookingId: string;
  startAt: string;
  endAt: string;
  title: string;
  description?: string;
}): string {
  return buildIcsEvent({
    uid: `booking-${params.bookingId}@clm.local`,
    prodId: "-//CLM//Booking Calendar//EN",
    startAt: params.startAt,
    endAt: params.endAt,
    title: params.title,
    description: params.description,
  });
}

export function buildMeetingIcs(params: {
  meetingId: string;
  startAt: string;
  endAt: string;
  title: string;
  description?: string;
}): string {
  return buildIcsEvent({
    uid: `meeting-${params.meetingId}@clm.local`,
    prodId: "-//CLM//Meeting Calendar//EN",
    startAt: params.startAt,
    endAt: params.endAt,
    title: params.title,
    description: params.description,
  });
}
