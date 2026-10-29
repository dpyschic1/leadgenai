import { z } from "zod";

/** Shared by the list dialogs and the route handlers. */

export const listSchema = z.object({
  name: z.string().trim().min(1, "List name is required").max(60, "Keep the name under 60 characters"),
});

export type ListInput = z.input<typeof listSchema>;
export type ListValues = z.output<typeof listSchema>;
