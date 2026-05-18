# Booking Readiness Checklist (Admin)

Use this checklist before testing member booking (`clm_create_booking`).

## 1) Member + Coach Setup

- [ ] Member exists in `profiles` (`role='member'`)
- [ ] Coach exists in `profiles` (`role='coach'`)
- [ ] Coach exists in `coaches` (`coaches.user_id = coach profile id`)

## 2) Session Type Setup

- [ ] Session type exists in `session_types`
- [ ] Session type has a valid `token_type_id`
- [ ] Session type is active (`is_active=true`)

## 3) Membership Setup (Member Perspective)

- [ ] Active membership exists in `member_memberships` for the member
- [ ] Membership dates are valid (`now()` within `start_date` and `end_date`)
- [ ] Membership is not paused for the current/session week (`membership_pause_weeks`)
- [ ] Membership not terminated (`termination_date` is null or in future)

## 4) Access Control Setup (Must Have Both)

- [ ] Membership-level access exists in `membership_allowed_session_types`  
      (`membership_id` + `session_type_id`)
- [ ] Member-level access exists in `member_session_tags`  
      (`member_id` + `session_type_id`)

## 5) Token / Allowance Setup

- [ ] Allowance exists in `membership_session_allowances` for matching `token_type_id`
- [ ] `weekly_allowance > 0`
- [ ] Member has available tokens in `tokens` for the same `token_type_id`
- [ ] Token is unexpired (`expiry_at > now()`)

## 6) Session Setup (Created by Admin/Coach)

- [ ] Session exists in `sessions`
- [ ] `sessions.coach_user_id` points to a valid coach (`coaches.user_id`)
- [ ] Session is in future and within booking horizon (<= 28 days)
- [ ] Session is not cancelled (`is_cancelled=false`)
- [ ] Capacity available (`booked < capacity`)

## 7) Location Rule (Important)

- [ ] Member and session location match (`profiles.location_id = sessions.location_id`)  
      (or both null; otherwise RPC throws `Location mismatch`)

## 8) Duplicate Booking Guard

- [ ] Member does not already have a `booked` booking at the same `start_at`

---

## Admin APIs that typically set these

- Membership allow list:  
  `POST /admin/memberships/:membershipId/session-types/:sessionTypeId`
- Membership allowance:  
  `POST /admin/memberships/:membershipId/session-allowances`
- Member session tags:  
  `POST /admin/members/:memberId/session-types/:sessionTypeId`
- Session creation:  
  `POST /admin/sessions`
- Token issuing (if needed):  
  `POST /admin/tokens/issue`

---

## Quick rule summary

Booking works only when:

`membership active` AND `session type allowed by membership` AND `session type tagged for member` AND `valid token available` AND `location matches` AND `session has capacity`.
