import type { Metadata } from "next";
import { Newsreader, Schibsted_Grotesk } from "next/font/google";
import { AppProviders } from "@/providers/app-providers";
import "./globals.css";

const schibsted = Schibsted_Grotesk({
  variable: "--font-schibsted",
  subsets: ["latin"],
});

/** The buyer's own words (an opportunity's evidence) are set in a reading serif, apart from the interface. */
const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "LeadGenAI",
  description: "Evidence-backed B2B opportunity intelligence",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${schibsted.variable} ${newsreader.variable} h-full antialiased`}>
      <body className="min-h-full">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
