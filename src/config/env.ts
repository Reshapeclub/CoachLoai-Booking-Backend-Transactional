import dotenv from "dotenv";
dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export const env = {
  PORT: Number(process.env.PORT ?? 3001),
  NODE_ENV: process.env.NODE_ENV ?? "development",
  APP_BASE_URL: process.env.APP_BASE_URL ?? "http://localhost:3001",
  SUPABASE_URL: required("SUPABASE_URL"),
  SUPABASE_SERVICE_ROLE_KEY: required("SUPABASE_SERVICE_ROLE_KEY"),
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ?? "",
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ?? "",
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ?? "",
  EMAIL_PROVIDER_API_KEY: process.env.EMAIL_PROVIDER_API_KEY ?? "",
  PUSH_PROVIDER_API_KEY: process.env.PUSH_PROVIDER_API_KEY ?? "",
  JWT_SECRET: process.env.JWT_SECRET ?? "",
} as const;
