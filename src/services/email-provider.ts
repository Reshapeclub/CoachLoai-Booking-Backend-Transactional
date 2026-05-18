import { isSmtpConfigured, sendSmtpMail } from "./smtp-mail.js";

export interface SendEmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(options: SendEmailOptions): Promise<boolean> {
  if (!isSmtpConfigured()) {
    console.warn("[email-provider] SMTP not configured — skipping email to", options.to);
    return false;
  }
  return sendSmtpMail(options);
}

export function isEmailConfigured(): boolean {
  return isSmtpConfigured();
}
