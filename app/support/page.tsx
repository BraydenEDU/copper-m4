import type { Metadata } from "next";
import { AskCopper } from "@/components/copper/ask-copper";
import { SiteHeader } from "@/components/copper/site-header";
import { isAiConfigured } from "@/lib/ai/call";

export const metadata: Metadata = {
  title: "Support",
  robots: { index: false, follow: false },
};

// Module 4: the support team's Refund Console. The console itself is still
// empty; Ask Copper from Module 3 sits beside it on the right.
export default function SupportPage() {
  return (
    <>
      <SiteHeader />
      <div className="grid flex-1 lg:grid-cols-[1fr_28rem]">
        <main className="p-6">
          <h1 className="text-2xl font-bold">Refund Console</h1>
        </main>
        <aside
          aria-label="Ask Copper"
          className="h-[70dvh] border-t lg:sticky lg:top-0 lg:h-[calc(100dvh-4rem)] lg:border-t-0 lg:border-l"
        >
          <AskCopper aiConfigured={isAiConfigured()} inline />
        </aside>
      </div>
    </>
  );
}
