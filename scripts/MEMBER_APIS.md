# Member APIs — reference

This document matches `member_apis.xlsx` and the implementation in `src/routes/member.routes.ts`.

## Authentication

All routes under `/member` require:

| Requirement | Details |
|-------------|---------|
| Header | `Authorization: Bearer <access_token>` — Supabase JWT validated via `supabase.auth.getUser(token)` |
| Profile | Row in `profiles` with `id` = auth user id and `role` = `member` |

Missing or invalid token → **401**. Wrong role → **403**.

## Base URL

Replace `{{BASE}}` with your server origin (e.g. `http://localhost:3000`).

---

## Endpoints

### 1. GET `/member/booking-context`

**Purpose:** Aggregated context for the signed-in member: membership (if active), token rows, bookings, and `locationId` from profile.

**Query / body:** None.

**Sample response (200):**

```json
{
  "ok": true,
  "data": {
    "member": {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "locationId": "11111111-2222-3333-4444-555555555555"
    },
    "membership": {
      "id": "22222222-3333-4444-5555-666666666666",
      "member_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "mode": "inperson",
      "status": "active",
      "start_date": "2026-01-01T00:00:00.000Z",
      "end_date": "2027-01-01T00:00:00.000Z"
    },
    "tokens": [
      {
        "id": "33333333-4444-5555-6666-777777777777",
        "member_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "token_type_id": "44444444-5555-6666-7777-888888888888",
        "quantity": 2,
        "week_start": "2026-03-30T00:00:00.000Z",
        "expiry_at": "2026-04-13T00:00:00.000Z",
        "source": "weekly"
      }
    ],
    "upcomingBookings": []
  }
}
```

---

### 2. GET `/member/sessions/available`

**Purpose:** Sessions the member can see (from `now` onward, optional filters), enriched with `booked_count`, `status` (`open` | `full` | `booked`), `isBookedByMe`, `isOnWaitlist`.

**Query parameters (all optional):**

| Param | Description |
|-------|-------------|
| `from` | ISO timestamp — default behaviour uses current time if omitted |
| `to` | ISO upper bound on `start_at` |
| `sessionTypeId` | Filter by session type |
| `locationId` | Overrides member’s `profiles.location_id` for filtering |

**Example:** `GET {{BASE}}/member/sessions/available?from=2026-04-01T00:00:00.000Z&locationId=11111111-2222-3333-4444-555555555555`

**Sample response (200):**

```json
{
  "ok": true,
  "data": [
    {
      "id": "55555555-6666-7777-8888-999999999999",
      "session_type_id": "66666666-7777-8888-9999-aaaaaaaaaaaa",
      "token_type_id": "44444444-5555-6666-7777-888888888888",
      "coach_user_id": "77777777-8888-9999-aaaa-bbbbbbbbbbbb",
      "location_id": "11111111-2222-3333-4444-555555555555",
      "start_at": "2026-04-02T10:00:00.000Z",
      "end_at": "2026-04-02T11:00:00.000Z",
      "capacity": 12,
      "coach_name": "Jane Coach",
      "booked_count": 3,
      "status": "open",
      "isBookedByMe": false,
      "isOnWaitlist": false
    }
  ]
}
```

---

### 3. GET `/member/sessions/:sessionId`

**Purpose:** Single session with nested `session_types` and coach display name as `coach_name`.

**Path:** `sessionId` — UUID of a row in `sessions`.

**Sample response (200):**

```json
{
  "ok": true,
  "data": {
    "id": "55555555-6666-7777-8888-999999999999",
    "session_type_id": "66666666-7777-8888-9999-aaaaaaaaaaaa",
    "start_at": "2026-04-02T10:00:00.000Z",
    "end_at": "2026-04-02T11:00:00.000Z",
    "capacity": 12,
    "coach_name": "Jane Coach"
  }
}
```

---

### 4. GET `/member/bookings`

**Purpose:** Member’s bookings with nested `sessions` (and session types).

**Query parameters:**

| Param | Description |
|-------|-------------|
| `status` | `upcoming` → only `status = booked`; `past` → not `booked`; omit → all |

**Example:** `GET {{BASE}}/member/bookings?status=upcoming`

**Sample response (200):**

```json
{
  "ok": true,
  "data": [
    {
      "id": "88888888-9999-aaaa-bbbb-cccccccccccc",
      "member_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "session_id": "55555555-6666-7777-8888-999999999999",
      "status": "booked",
      "booked_at": "2026-03-28T12:00:00.000Z",
      "sessions": {
        "id": "55555555-6666-7777-8888-999999999999",
        "start_at": "2026-04-02T10:00:00.000Z"
      }
    }
  ]
}
```

---

### 5. POST `/member/bookings`

**Purpose:** Create a booking via RPC `clm_create_booking` (token deduction, audit, notifications).

**Request body (JSON):**

```json
{
  "membershipId": "22222222-3333-4444-5555-666666666666",
  "sessionId": "55555555-6666-7777-8888-999999999999"
}
```

**Sample success response (200)** — shape returned by RPC:

```json
{
  "ok": true,
  "bookingId": "88888888-9999-aaaa-bbbb-cccccccccccc",
  "sessionId": "55555555-6666-7777-8888-999999999999",
  "tokenId": "33333333-4444-5555-6666-777777777777",
  "tokenWeekStart": "2026-03-30T00:00:00.000Z"
}
```

---

### 6. POST `/member/bookings/:bookingId/cancel`

**Purpose:** Cancel booking via `clm_cancel_booking` (refund token if ≥12h before session start; may process waitlist).

**Path:** `bookingId` — UUID.

**Body:** None.

**Sample response (200):**

```json
{
  "ok": true,
  "bookingId": "88888888-9999-aaaa-bbbb-cccccccccccc",
  "refundApplied": true,
  "waitlist": {
    "ok": true,
    "mode": "notify_only"
  }
}
```

---

### 7. GET `/member/waitlist`

**Purpose:** All waitlist entries for this member with nested session and session type.

**Sample response (200):**

```json
{
  "ok": true,
  "data": [
    {
      "id": "99999999-aaaa-bbbb-cccc-dddddddddddd",
      "session_id": "55555555-6666-7777-8888-999999999999",
      "member_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "joined_at": "2026-03-29T09:00:00.000Z",
      "sessions": {
        "id": "55555555-6666-7777-8888-999999999999",
        "start_at": "2026-04-02T10:00:00.000Z"
      }
    }
  ]
}
```

---

### 8. POST `/member/waitlist`

**Purpose:** Join waitlist via `clm_join_waitlist` (session must be full; member must have a valid token for that session’s token type).

**Request body:**

```json
{
  "membershipId": "22222222-3333-4444-5555-666666666666",
  "sessionId": "55555555-6666-7777-8888-999999999999"
}
```

**Sample response (200):**

```json
{
  "ok": true,
  "waitlistPosition": 2
}
```

---

### 9. GET `/member/tokens`

**Purpose:** Token wallet — all `tokens` rows for the member.

**Sample response (200):**

```json
{
  "ok": true,
  "data": [
    {
      "id": "33333333-4444-5555-6666-777777777777",
      "member_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "token_type_id": "44444444-5555-6666-7777-888888888888",
      "quantity": 2,
      "expiry_at": "2026-04-13T00:00:00.000Z",
      "source": "weekly"
    }
  ]
}
```

---

### 10. GET `/member/tokens/additional-summary`

**Purpose:** Summary for **purchased** tokens (`source = purchase`) still valid: totals and remaining sessions after deductions.

**Sample response (200):**

```json
{
  "ok": true,
  "data": {
    "totalPurchased": 8,
    "totalUsed": 3,
    "sessionsRemaining": 5,
    "startsAt": "2026-03-01T10:00:00.000Z",
    "expiresAt": "2026-05-01T00:00:00.000Z"
  }
}
```

If there are no qualifying purchase tokens, counts are zero and dates may be `null`.

---

### 11. GET `/member/tokens/purchase/options`

**Purpose:** Active `session_types` that map to priced names (`Elite`, `Group`, `Octave`, `1:1`) with `unitAmountMinorCents` / `unitPrice` and expiry policy metadata.

**Sample response (200):**

```json
{
  "ok": true,
  "data": [
    {
      "id": "66666666-7777-8888-9999-aaaaaaaaaaaa",
      "name": "Group",
      "tokenTypeId": "44444444-5555-6666-7777-888888888888",
      "color": "#10B981",
      "icon": "👥",
      "unitAmountMinorCents": 1500,
      "unitPrice": 15,
      "expiryPolicy": {
        "bands": [
          { "minQty": 1, "maxQty": 4, "expiryWeeks": 4, "label": "4 weeks" },
          { "minQty": 5, "maxQty": 8, "expiryWeeks": 8, "label": "8 weeks" },
          { "minQty": 9, "maxQty": 12, "expiryWeeks": 12, "label": "12 weeks" }
        ]
      }
    }
  ]
}
```

---

### 12. POST `/member/tokens/purchase/checkout`

**Purpose:** Create a Stripe Checkout Session; returns hosted payment URL. Requires `STRIPE_SECRET_KEY` and a `session_types` row whose `token_type_id` matches and `name` is one of the priced types.

**Request body:**

```json
{
  "membershipId": "22222222-3333-4444-5555-666666666666",
  "tokenTypeId": "44444444-5555-6666-7777-888888888888",
  "quantity": 4
}
```

`quantity` must be an integer **1–12**.

**Sample response (200):**

```json
{
  "ok": true,
  "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_test_a1b2c3..."
}
```

---

### 13. GET `/member/locations`

**Purpose:** List all locations (alphabetical by name).

**Sample response (200):**

```json
{
  "ok": true,
  "data": [
    {
      "id": "11111111-2222-3333-4444-555555555555",
      "name": "London Studio",
      "created_at": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

---

### 14. GET `/member/meetings/types`

**Purpose:** Active meeting types for booking UI.

**Sample response (200):**

```json
{
  "ok": true,
  "data": [
    {
      "id": "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
      "name": "Intro Session",
      "code": "INTRO",
      "duration_mins": 30,
      "description": "First meeting",
      "color": "#3B82F6",
      "icon": "🟦",
      "display_order": 1,
      "is_active": true
    }
  ]
}
```

---

### 15. GET `/member/meetings/availability`

**Purpose:** Slots for a meeting type on a given calendar day at the member’s location (or `locationId` query override).

**Query parameters (required unless noted):**

| Param | Required | Description |
|-------|----------|-------------|
| `meetingTypeId` | Yes | UUID |
| `date` | Yes | `YYYY-MM-DD` (interpreted as UTC day window) |
| `locationId` | No | If omitted, uses `profiles.location_id`; if both missing, **400** |

**Example:** `GET {{BASE}}/member/meetings/availability?meetingTypeId=bbbbbbbb-cccc-dddd-eeee-ffffffffffff&date=2026-04-01`

**Sample response (200):**

```json
{
  "ok": true,
  "data": {
    "meetingType": {
      "id": "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
      "name": "Intro Session",
      "duration_mins": 30
    },
    "locationId": "11111111-2222-3333-4444-555555555555",
    "date": "2026-04-01",
    "slots": [
      {
        "id": "cccccccc-dddd-eeee-ffff-000000000001",
        "meeting_type_id": "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        "location_id": "11111111-2222-3333-4444-555555555555",
        "slot_start": "2026-04-01T10:00:00.000Z",
        "slot_end": "2026-04-01T10:30:00.000Z",
        "capacity": 1,
        "bookedCount": 0,
        "status": "open"
      }
    ]
  }
}
```

**Error example (400)** if `meetingTypeId` or `date` missing:

```json
{
  "ok": false,
  "error": "meetingTypeId and date are required"
}
```

---

### 16. GET `/member/meetings/eligibility`

**Purpose:** Placeholder eligibility flags plus meeting history from `track_meetings`.

**Sample response (200):**

```json
{
  "ok": true,
  "data": {
    "performance": { "eligible": true, "nextEligibleDate": null },
    "pace": { "eligible": true, "nextEligibleDate": null },
    "structure": { "eligible": true, "nextEligibleDate": null },
    "history": []
  }
}
```

---

### 17. POST `/member/meetings`

**Purpose:** Book a meeting when `meetingStart` exactly matches an active `meeting_slots.slot_start` for that type and location, and capacity allows.

**Request body:**

```json
{
  "meetingTypeId": "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
  "locationId": "11111111-2222-3333-4444-555555555555",
  "meetingStart": "2026-04-01T10:00:00.000Z"
}
```

`locationId` is optional if the member profile has `location_id`. `meetingStart` must be a string that parses as a datetime (Zod `datetime()`).

**Sample response (200):**

```json
{
  "ok": true,
  "data": {
    "id": "dddddddd-eeee-ffff-0000-111111111111",
    "member_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "meeting_type_id": "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
    "location_id": "11111111-2222-3333-4444-555555555555",
    "meeting_start": "2026-04-01T10:00:00.000Z",
    "meeting_end": "2026-04-01T10:30:00.000Z",
    "status": "booked"
  }
}
```

---

## Quick reference (same as spreadsheet)

| Method | Path | Purpose | Query / path / body |
|--------|------|---------|---------------------|
| GET | `/member/booking-context` | Booking context | — |
| GET | `/member/sessions/available` | Available sessions | `from`, `to`, `sessionTypeId`, `locationId` |
| GET | `/member/sessions/:sessionId` | Session detail | path: `sessionId` |
| GET | `/member/bookings` | List bookings | `status` |
| POST | `/member/bookings` | Create booking | body: `membershipId`, `sessionId` |
| POST | `/member/bookings/:bookingId/cancel` | Cancel booking | path: `bookingId` |
| GET | `/member/waitlist` | Waitlist entries | — |
| POST | `/member/waitlist` | Join waitlist | body: `membershipId`, `sessionId` |
| GET | `/member/tokens` | Token wallet | — |
| GET | `/member/tokens/additional-summary` | Purchase summary | — |
| GET | `/member/tokens/purchase/options` | Purchase options | — |
| POST | `/member/tokens/purchase/checkout` | Stripe checkout | body: `membershipId`, `tokenTypeId`, `quantity` |
| GET | `/member/locations` | Locations | — |
| GET | `/member/meetings/types` | Meeting types | — |
| GET | `/member/meetings/availability` | Slot availability | `meetingTypeId`, `date`, `locationId?` |
| GET | `/member/meetings/eligibility` | Eligibility + history | — |
| POST | `/member/meetings` | Book meeting | body: `meetingTypeId`, `locationId?`, `meetingStart` |

---

*UUIDs and timestamps in examples are illustrative. Real responses depend on your Supabase data and RPC behaviour.*
