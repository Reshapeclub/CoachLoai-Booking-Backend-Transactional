import nodemailer from "nodemailer";

export type SmtpConfig = {
  host: string;
  port: number;
  user: string;
  pass: string;
};

let cachedTransporter: nodemailer.Transporter | null = null;
let cachedConfigKey = "";

export function getSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  if (!host || !user || !pass) return null;
  return {
    host,
    port: Number(process.env.SMTP_PORT) || 587,
    user,
    pass,
  };
}

export function isSmtpConfigured(): boolean {
  return getSmtpConfig() !== null;
}

function getTransporter(cfg: SmtpConfig): nodemailer.Transporter {
  const key = `${cfg.host}:${cfg.port}:${cfg.user}`;
  if (cachedTransporter && cachedConfigKey === key) {
    return cachedTransporter;
  }
  cachedConfigKey = key;
  cachedTransporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: {
      user: cfg.user,
      pass: cfg.pass,
    },
  });
  return cachedTransporter;
}

/** Default From for transactional mail (Gmail requires the authenticated mailbox). */
export function defaultSmtpFrom(cfg: SmtpConfig, displayName = "CoachLoai"): string {
  const customFrom = process.env.EMAIL_FROM?.trim();
  if (customFrom && customFrom !== "noreply@example.com") {
    return customFrom.includes("<") ? customFrom : `"${displayName}" <${customFrom}>`;
  }
  return `"${displayName}" <${cfg.user}>`;
}

export type SendSmtpMailOptions = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from?: string;
};

export async function sendSmtpMail(options: SendSmtpMailOptions): Promise<boolean> {
  const cfg = getSmtpConfig();
  if (!cfg) return false;

  try {
    await getTransporter(cfg).sendMail({
      from: options.from ?? defaultSmtpFrom(cfg),
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html ?? options.text.replace(/\n/g, "<br>"),
    });
    return true;
  } catch (err) {
    console.error("[smtp-mail] Send failed:", err);
    return false;
  }
}
