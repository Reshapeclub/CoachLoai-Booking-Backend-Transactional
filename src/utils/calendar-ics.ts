function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toUtcIcsDate(input: string): string {
  const d = new Date(input);
  return (
    `${d.getUTCFullYear()}` +
    `${pad(d.getUTCMonth() + 1)}` +
    `${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

export function buildBookingIcs(params: {
  bookingId: string;
  startAt: string;
  endAt: string;
  title: string;
  description?: string;
}): string {
  const stamp = toUtcIcsDate(new Date().toISOString());
  const start = toUtcIcsDate(params.startAt);
  const end = toUtcIcsDate(params.endAt);
  const uid = `booking-${params.bookingId}@clm.local`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//CLM//Booking Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${escapeIcsText(params.title)}`,
    `DESCRIPTION:${escapeIcsText(params.description ?? "")}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].filter(Boolean);
  return lines.join("\r\n");
}
