/** Response DTOs shared by the route handlers and the client. Only these shapes leave the server. */
import type { memberRole } from "@/db/schema";

export type UserRole = (typeof memberRole.enumValues)[number];

export type CurrentUser = {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
};

export type Workspace = {
  id: string;
  name: string;
  plan: string;
  timezone: string;
};

/** The signed-in user and their workspace; returned by register, login and GET /workspaces/me. */
export type Me = {
  user: CurrentUser;
  workspace: Workspace;
};
