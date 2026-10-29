import { z } from "zod";
import { ASSIGNABLE_ROLES } from "@/lib/domain/members";
import { email, newPassword, personName } from "./auth";

/** Shared by the team settings, the invitation page and the route handlers. */

const assignableRole = z.enum(ASSIGNABLE_ROLES, "Pick a role");

export const inviteMemberSchema = z.object({ email, role: assignableRole });

export const updateMemberSchema = z.object({ role: assignableRole });

/** Accepting as someone new: the invitation fixes the email, they choose their name and password. */
export const acceptAsNewUserSchema = z.object({ name: personName("Your name"), password: newPassword });

/** Accepting with an account that already exists elsewhere: proving it's theirs is enough. */
export const acceptAsExistingUserSchema = z.object({ password: z.string().min(1, "Password is required").max(128) });

/** What the accept endpoint parses before it knows which of the two cases applies. */
export const acceptInvitationSchema = z.object({
  name: z.string().optional(),
  password: z.string().max(128),
});

export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
export type AcceptAsNewUserInput = z.infer<typeof acceptAsNewUserSchema>;
export type AcceptAsExistingUserInput = z.infer<typeof acceptAsExistingUserSchema>;
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
