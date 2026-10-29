import type { Metadata } from "next";
import { CompaniesView } from "@/components/companies/companies-view";

export const metadata: Metadata = { title: "Companies · LeadGenAI" };

export default function CompaniesPage() {
  return <CompaniesView />;
}
