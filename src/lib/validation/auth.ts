import { z } from "zod";

/** Shared by the client forms and the route handlers, so both validate identically. */

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Enter a valid email address").max(254));

export const personName = (label: string) =>
  z.string().trim().min(1, `${label} is required`).max(100, `${label} is too long`);

export const newPassword = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must be at most 128 characters");

export const registerSchema = z.object({
  name: personName("Name"),
  email,
  password: newPassword,
  workspaceName: personName("Workspace name"),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1, "Password is required").max(128),
});

export const updateWorkspaceSchema = z.object({
  name: personName("Workspace name"),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;
