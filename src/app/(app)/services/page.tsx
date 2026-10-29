import type { Metadata } from "next";
import { ServicesView } from "@/components/services/services-view";

export const metadata: Metadata = { title: "Services & ICP · LeadGenAI" };

export default function ServicesPage() {
  return <ServicesView />;
}
