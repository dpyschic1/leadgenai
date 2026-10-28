import type { LoginInput, RegisterInput } from "@/lib/validation/auth";
import { apiRequest } from "./client";
import type { Me } from "./types";

export const authApi = {
  register: (input: RegisterInput) => apiRequest<Me>("/auth/register", { method: "POST", body: input }),
  login: (input: LoginInput) => apiRequest<Me>("/auth/login", { method: "POST", body: input }),
  logout: () => apiRequest<void>("/auth/logout", { method: "POST" }),
};
