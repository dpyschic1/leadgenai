import type { Metadata } from "next";
import { Schibsted_Grotesk } from "next/font/google";
import { AppProviders } from "@/providers/app-providers";
import "./globals.css";

const schibsted = Schibsted_Grotesk({
  variable: "--font-schibsted",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "LeadGenAI",
  description: "Evidence-backed B2B opportunity intelligence",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${schibsted.variable} h-full antialiased`}>
      <body className="min-h-full">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
