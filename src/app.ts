import cron from "node-cron";
import express from "express";
import cors from "cors";
import routes from "./routes/index.js";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/error-handler.js";
import { runActivateDueQueuedPlans } from "./jobs/activate-due-queued-plans.js";
import { runWeeklyTokenGeneration } from "./jobs/weekly-token-generation.js";
import { runNotificationSend } from "./jobs/notification-send.js";

const app = express();
app.use(cors());
// Stripe webhooks require the raw body for signature verification.
// We only use `express.raw` for POST /webhooks/stripe, and normal JSON elsewhere.
app.use((req, res, next) => {
  if (req.path === "/webhooks/stripe" && req.method === "POST") {
    return express.raw({ type: "application/json" })(req, res, next);
  }
  return express.json({ limit: "5mb" })(req, res, next);
});
app.get('/health', (_req, res) => res.json({ ok: true, service: 'clm-booking-backend-transactional' }));
app.use(routes);
app.use(errorHandler);

// Weekly token generation: every Monday at 02:00 UK time
cron.schedule("0 2 * * 1", async () => {
  try {
    await runWeeklyTokenGeneration();
    console.log("[cron] Weekly token generation completed");
  } catch (err) {
    console.error("[cron] Weekly token generation failed:", err);
  }
}, { timezone: "Europe/London" });

// Queued membership plans: daily at 01:05 UK time
cron.schedule("5 1 * * *", async () => {
  try {
    const result = await runActivateDueQueuedPlans();
    console.log(
      `[cron] Queued plan activation: scanned=${result.scanned} training=${result.trainingActivated} nutrition=${result.nutritionActivated}`,
    );
  } catch (err) {
    console.error("[cron] Queued plan activation failed:", err);
  }
}, { timezone: "Europe/London" });

// Notification send: every 30 seconds (email queue)
cron.schedule("*/30 * * * * *", async () => {
  try {
    await runNotificationSend();
    //console.log("[cron] Notification send completed");
  } catch (err) {
    console.error("[cron] Notification send failed:", err);
  }
});

app.listen(env.PORT, () => console.log(`CLM Booking Backend Transactional running on port ${env.PORT}`));
