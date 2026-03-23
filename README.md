# CLM Booking Backend — Transactional Build

This package wires the CLM booking scaffold into a transactional backend foundation using Node.js, TypeScript, Express, Supabase, and PostgreSQL RPC functions.

Implemented:
- transactional booking creation
- transactional booking cancellation
- transactional waitlist join
- transactional admin remove-member
- transactional admin cancel-session
- weekly token generation RPC
- session availability endpoint
- token wallet endpoint
- meeting eligibility + booking endpoints
- audit log writes inside transactional flows
- notification queue writes inside transactional flows

Still needed before live production:
- real Supabase JWT verification
- raw-body Stripe webhook verification
- production notification provider integration
- test coverage and load testing
- exact UI payload refinements if your app differs
