import type { Metadata } from "next";
import { RefundConsole } from "@/components/copper/refund-console";
import { SiteHeader } from "@/components/copper/site-header";
import { isAiConfigured } from "@/lib/ai/call";

export const metadata: Metadata = {
  title: "Support",
  robots: { index: false, follow: false },
};

// Module 4: the support team's Refund Console, with Ask Copper on the right.
export default function SupportPage() {
  return (
    <>
      <SiteHeader />
      <RefundConsole aiConfigured={isAiConfigured()} />
    </>
  );
}
