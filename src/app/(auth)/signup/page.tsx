import type { Metadata } from "next";
import { SignupForm } from "@/components/auth/signup-form";

export const metadata: Metadata = { title: "Create workspace · LeadGenAI" };

export default function SignupPage() {
  return <SignupForm />;
}
