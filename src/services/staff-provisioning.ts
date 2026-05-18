import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { supabaseAdmin } from "../db/supabase.js";
import { HttpError } from "../lib/http-error.js";

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function generateStaffTemporaryPassword(length = 14): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

function authRoleFromStaffRole(role: string | null | undefined): string {
  const raw = String(role ?? "Coach").trim();
  const compact = raw.toLowerCase().replace(/\s+/g, "");
  if (compact === "headcoach") return "HEADCOACH";
  if (compact === "admin") return "ADMIN";
  if (compact === "finance") return "FINANCE";
  if (compact === "nutritionist") return "NUTRITIONIST";
  if (compact === "support") return "SUPPORT";
  return "COACH";
}

async function findAuthUserByEmail(email: string) {
  let page = 1;
  const perPage = 1000;
  const normalized = normalizeEmail(email);

  while (page <= 100) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;

    const user = data.users.find(
      (u) => u.email?.toLowerCase() === normalized,
    );
    if (user) return user;

    if (!data.nextPage) break;
    page = data.nextPage;
  }
  return null;
}

export type ProvisionStaffAuthInput = {
  email: string;
  name: string;
  role?: string | null;
};

/** Creates Supabase Auth user + returns bcrypt hash for public.admins.password */
export async function provisionStaffAuthAccount(input: ProvisionStaffAuthInput): Promise<{
  plainPassword: string;
  passwordHash: string;
  authUserId: string;
}> {
  const normalizedEmail = normalizeEmail(input.email);
  const plainPassword = generateStaffTemporaryPassword();
  const passwordHash = await bcrypt.hash(plainPassword, 10);
  const authRole = authRoleFromStaffRole(input.role);
  const displayName = input.name.trim() || "Team Member";

  const { data: existingAdmin, error: existingAdminErr } = await supabaseAdmin
    .from("admins")
    .select("id, email")
    .eq("email", normalizedEmail)
    .maybeSingle();
  if (existingAdminErr) {
    throw new HttpError(500, "Failed to verify staff email", existingAdminErr);
  }
  if (existingAdmin) {
    throw new HttpError(409, "A staff member with this email already exists");
  }

  let authUserId: string | null = null;
  let createdNewAuthUser = false;

  try {
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: normalizedEmail,
      password: plainPassword,
      email_confirm: true,
      app_metadata: { role: authRole },
      user_metadata: { name: displayName },
    });

    if (createErr) {
      const msg = createErr.message?.toLowerCase() ?? "";
      const duplicate =
        msg.includes("already") || msg.includes("registered") || msg.includes("exists");
      if (!duplicate) {
        throw new HttpError(500, "Failed to create login account for staff member", createErr);
      }

      const existingAuth = await findAuthUserByEmail(normalizedEmail);
      if (!existingAuth) {
        throw new HttpError(
          500,
          `Auth account exists but could not be loaded for ${normalizedEmail}`,
          createErr,
        );
      }

      authUserId = existingAuth.id;
      const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(authUserId, {
        password: plainPassword,
        email_confirm: true,
        app_metadata: { ...existingAuth.app_metadata, role: authRole },
        user_metadata: { ...existingAuth.user_metadata, name: displayName },
      });
      if (updErr) {
        throw new HttpError(500, "Failed to update existing login account", updErr);
      }
    } else if (created?.user) {
      authUserId = created.user.id;
      createdNewAuthUser = true;
    } else {
      throw new HttpError(500, "Failed to create login account for staff member");
    }

    if (!authUserId) {
      throw new HttpError(500, "Failed to create login account for staff member");
    }
    return { plainPassword, passwordHash, authUserId };
  } catch (e) {
    if (createdNewAuthUser && authUserId) {
      const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(authUserId);
      if (delErr) {
        console.error("[staff-provisioning] Rollback delete auth user failed:", delErr.message);
      }
    }
    throw e;
  }
}

export async function rollbackStaffAuthAccount(authUserId: string) {
  const { error } = await supabaseAdmin.auth.admin.deleteUser(authUserId);
  if (error) {
    console.error("[staff-provisioning] Rollback delete auth user failed:", error.message);
  }
}
