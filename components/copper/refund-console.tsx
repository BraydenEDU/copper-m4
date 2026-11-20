"use client";

// Module 4: the Refund Console. The support team sets the auto-refund limit
// here and approves or rejects refunds over it. Ask Copper sits on the right;
// its Refund agent asks the app for refunds, and the app's answers land here.
import { useEffect, useState } from "react";
import { AskCopper, type ChatNotice } from "@/components/copper/ask-copper";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatUsd } from "@/lib/copper/catalog";
import {
  cleanLimit,
  CUSTOMER,
  DEFAULT_LIMIT_USD,
  ORDERS,
  type RefundDecision,
  type RefundState,
  type RefundStatus,
} from "@/lib/copper/refunds/orders";

const STORAGE_KEY = "copper-refund-console";
const START: RefundState = { limitUsd: DEFAULT_LIMIT_USD, refunds: {} };

const BADGE: Record<RefundStatus | "paid", string> = {
  paid: "Paid",
  refunded: "Refunded",
  pending: "Waiting for approval",
  rejected: "Refund rejected",
};

export function RefundConsole({ aiConfigured }: { aiConfigured: boolean }) {
  const [state, setState] = useState<RefundState>(START);
  const [limitText, setLimitText] = useState(String(DEFAULT_LIMIT_USD));
  const [notices, setNotices] = useState<ChatNotice[]>([]);

  // Remember the console across reloads, in this browser only.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
      if (saved?.refunds) {
        const limitUsd = cleanLimit(saved.limitUsd);
        // Read after the first render so the server and browser HTML match.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setState({ limitUsd, refunds: saved.refunds });
        setLimitText(String(limitUsd));
      }
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {}
  }, [state]);

  const setStatus = (orderId: string, status: RefundStatus) =>
    setState((s) => ({ ...s, refunds: { ...s.refunds, [orderId]: status } }));

  /** A person approves or rejects a waiting refund; the chat tells the customer. */
  function decide(orderId: string, status: "refunded" | "rejected") {
    const order = ORDERS.find((o) => o.id === orderId);
    if (!order || state.refunds[orderId] !== "pending") return;
    setStatus(orderId, status);
    const what = `order #${order.id} (${order.item}, ${formatUsd(order.amountUsd)})`;
    const text =
      status === "refunded"
        ? `Good news: the support team approved your refund for ${what}. It has been refunded.`
        : `The support team reviewed your refund request for ${what} and rejected it, so it won't be refunded. If you have questions, contact the Copper Crew in the Copper app (Settings > Help).`;
    setNotices((all) => [
      ...all,
      { id: `${orderId}-${status}-${all.length}`, text },
    ]);
  }

  function onDecision(decision: RefundDecision) {
    if (decision.status === "refunded" || decision.status === "pending")
      setStatus(decision.orderId, decision.status);
  }

  const pending = ORDERS.filter((o) => state.refunds[o.id] === "pending");

  return (
    <div className="grid flex-1 lg:grid-cols-[1fr_28rem]">
      <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold">Refund Console</h1>
          <p className="text-muted-foreground text-sm">
            Ask for a refund in the chat as the customer. Copper hands you to
            the Refund agent, which asks the app for the refund. The app checks
            the amount against your limit: at or under it, the refund goes
            through; over it, it waits here for you.
          </p>
        </div>

        <section className="space-y-2 rounded-xl border p-4">
          <label htmlFor="limit" className="text-sm font-semibold">
            Auto-refund limit
          </label>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">$</span>
            <Input
              id="limit"
              data-testid="refund-limit"
              inputMode="decimal"
              value={limitText}
              onChange={(e) => {
                setLimitText(e.target.value);
                setState((s) => ({
                  ...s,
                  limitUsd: cleanLimit(e.target.value),
                }));
              }}
              className="w-28"
            />
          </div>
          <p className="text-muted-foreground text-xs">
            {state.limitUsd === 0
              ? "Every refund needs your approval."
              : `Refunds up to ${formatUsd(state.limitUsd)} go through on their own. Anything larger needs your approval.`}
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">Waiting for your approval</h2>
          {pending.length === 0 ? (
            <p className="text-muted-foreground rounded-xl border p-4 text-sm">
              Nothing is waiting. Refunds over the limit will stop here.
            </p>
          ) : (
            <ul className="divide-y rounded-xl border">
              {pending.map((order) => (
                <li
                  key={order.id}
                  data-testid="pending-refund"
                  className="flex flex-wrap items-center gap-3 p-3 text-sm"
                >
                  <span className="font-mono">#{order.id}</span>
                  <span className="flex-1">{order.item}</span>
                  <span className="font-mono">
                    {formatUsd(order.amountUsd)}
                  </span>
                  <Button
                    size="sm"
                    onClick={() => decide(order.id, "refunded")}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => decide(order.id, "rejected")}
                  >
                    Reject
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">{CUSTOMER}&apos;s orders</h2>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setState(START);
                setLimitText(String(DEFAULT_LIMIT_USD));
              }}
            >
              Reset demo
            </Button>
          </div>
          <ul className="divide-y rounded-xl border">
            {ORDERS.map((order) => {
              const status: RefundStatus | "paid" =
                (state.refunds[order.id] as RefundStatus | undefined) ?? "paid";
              return (
                <li
                  key={order.id}
                  data-testid="order"
                  className="flex items-center gap-3 p-3 text-sm"
                >
                  <span className="font-mono">#{order.id}</span>
                  <span className="flex-1">{order.item}</span>
                  <Badge variant={status === "paid" ? "outline" : "secondary"}>
                    {BADGE[status]}
                  </Badge>
                  <span className="w-16 text-right font-mono">
                    {formatUsd(order.amountUsd)}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      </main>
      <aside
        aria-label="Ask Copper"
        className="h-[70dvh] border-t lg:sticky lg:top-0 lg:h-[calc(100dvh-4rem)] lg:border-t-0 lg:border-l"
      >
        <AskCopper
          aiConfigured={aiConfigured}
          inline
          refunds={state}
          onRefundDecision={onDecision}
          notices={notices}
        />
      </aside>
    </div>
  );
}
