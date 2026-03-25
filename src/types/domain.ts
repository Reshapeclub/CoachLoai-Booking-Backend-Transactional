export type Role = "member" | "coach" | "admin";
export type RefundMode = "refund" | "charge";
export type MeetingTier = "performance" | "pace" | "structure";

export interface RequestUser {
  id: string;
  role?: Role;
  email?: string;
}
