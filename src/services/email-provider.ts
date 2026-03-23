import nodemailer from "nodemailer";
import { env } from "../config/env.js";

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (!env.EMAIL_PROVIDER_API_KEY) return null;
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: "smtp.sendgrid.net",
    port: 587,
    secure: false,
    auth: {
      user: "apikey",
      pass: env.EMAIL_PROVIDER_API_KEY,
    },
  });
  return transporter;
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(options: SendEmailOptions): Promise<boolean> {
  const transport = getTransporter();
  if (!transport) return false;

  try {
    await transport.sendMail({
      from: env.EMAIL_FROM,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html ?? options.text.replace(/\n/g, "<br>"),
    });
    return true;
  } catch (err) {
    console.error("[email-provider] Send failed:", err);
    return false;
  }
}

export function isEmailConfigured(): boolean {
  return !!env.EMAIL_PROVIDER_API_KEY;
}
