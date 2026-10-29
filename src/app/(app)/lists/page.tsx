import type { Metadata } from "next";
import { ListsView } from "@/components/lists/lists-view";

export const metadata: Metadata = { title: "Lists · LeadGenAI" };

export default function ListsPage() {
  return <ListsView />;
}
