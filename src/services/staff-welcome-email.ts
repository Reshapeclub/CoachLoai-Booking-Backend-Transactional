import { defaultSmtpFrom, getSmtpConfig, isSmtpConfigured, sendSmtpMail } from "./smtp-mail.js";

export function isStaffWelcomeEmailConfigured(): boolean {
  return isSmtpConfigured();
}

export async function sendStaffWelcomeEmail(
  email: string,
  name: string,
  password: string,
  role: string,
): Promise<boolean> {
  const cfg = getSmtpConfig();
  if (!cfg) {
    console.warn("[staff-welcome-email] SMTP not configured — skipping welcome email for", email);
    return false;
  }

  const roleLabel =
    role === "HEADCOACH" || role === "Head Coach"
      ? "Head Coach"
      : role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();

  const subject = "Welcome to CoachLo — Your Account Details";
  const text = [
    `Hi ${name || "Team Member"},`,
    "",
    `Welcome to the CoachLo team! Your account has been created with the role of ${roleLabel}.`,
    "",
    "Here are your login credentials:",
    "",
    `  Email:    ${email}`,
    `  Password: ${password}`,
    "",
    "Please log in and change your password as soon as possible.",
    "",
    "Best regards,",
    "The CoachLo Admin Team",
  ].join("\n");

  const html = `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; background: #f8fafc; border-radius: 12px;">
        <h2 style="color: #1e293b; margin-bottom: 16px;">Welcome to CoachLo!</h2>
        <p style="color: #334155;">Hi <strong>${name || "Team Member"}</strong>,</p>
        <p style="color: #334155;">Your account has been created with the role of <strong>${roleLabel}</strong>.</p>
        <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
          <p style="margin: 0 0 8px; color: #64748b; font-size: 13px; font-weight: 600;">YOUR LOGIN CREDENTIALS</p>
          <p style="margin: 4px 0; color: #1e293b;"><strong>Email:</strong> ${email}</p>
          <p style="margin: 4px 0; color: #1e293b;"><strong>Password:</strong> <code style="background: #f1f5f9; padding: 2px 8px; border-radius: 4px; font-size: 14px;">${password}</code></p>
        </div>
        <p style="color: #ef4444; font-size: 13px;">⚠️ Please log in and change your password as soon as possible.</p>
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
        <p style="color: #94a3b8; font-size: 12px; margin: 0;">Best regards, The CoachLo Admin Team</p>
      </div>
    `;

  return sendSmtpMail({
    from: defaultSmtpFrom(cfg, "CoachLo Admin"),
    to: email,
    subject,
    text,
    html,
  });
}
