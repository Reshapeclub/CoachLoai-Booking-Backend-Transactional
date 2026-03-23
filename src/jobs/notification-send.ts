import { processUnsentEmailNotifications } from "../services/notification-service.js";

export async function runNotificationSend() {
  const sent = await processUnsentEmailNotifications();
  if (sent > 0) {
    console.log(`[cron] Notification send: ${sent} email(s) sent`);
  }
  return sent;
}
