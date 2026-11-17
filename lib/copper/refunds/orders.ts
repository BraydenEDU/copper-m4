// Module 4: the refund rules. Everything that decides whether money moves
// lives here, in plain code. The AI agent can only *ask* for a refund; this
// file decides. So "a supervisor already approved it" in the chat changes
// nothing, a second request for the same order is caught, and a limit of $0
// sends every refund to a human.

export type Order = {
  id: string;
  item: string;
  amountUsd: number;
};

/** The demo customer and her orders (fictional). */
export const CUSTOMER = "Maya Reyes";

export const ORDERS: Order[] = [
  { id: "1001", item: "Copper Plus, monthly", amountUsd: 7.99 },
  { id: "1002", item: "Copper Plus, annual", amountUsd: 79 },
  { id: "1003", item: "Copper Notes", amountUsd: 129 },
  { id: "1004", item: "Copper Home", amountUsd: 149 },
];

export const DEFAULT_LIMIT_USD = 50;

export type RefundStatus = "refunded" | "pending" | "rejected";

/** What the Refund Console knows: the limit and each order's refund, if any. */
export type RefundState = {
  limitUsd: number;
  refunds: Partial<Record<string, RefundStatus>>;
};

export type RefundDecision =
  | { status: "refunded"; orderId: string; item: string; amountUsd: number }
  | {
      status: "pending";
      orderId: string;
      item: string;
      amountUsd: number;
      limitUsd: number;
    }
  | {
      status: "already_refunded" | "already_pending" | "already_rejected";
      orderId: string;
      item: string;
      amountUsd: number;
    }
  | { status: "not_found"; orderId: string };

export function findOrder(orderId: string): Order | undefined {
  const id = orderId.replace(/\D/g, "");
  return ORDERS.find((order) => order.id === id);
}

/** A limit the console accepts: a number of dollars, never below 0. */
export function cleanLimit(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
}

/**
 * Decides one refund request and records it in `state` (so a second request
 * in the same conversation is caught too). The amount is always the order's
 * full amount: the agent can't choose it.
 */
export function decideRefund(
  state: RefundState,
  orderId: string,
): RefundDecision {
  const order = findOrder(orderId);
  if (!order) return { status: "not_found", orderId };
  const base = {
    orderId: order.id,
    item: order.item,
    amountUsd: order.amountUsd,
  };
  const earlier = state.refunds[order.id];
  if (earlier) return { status: `already_${earlier}`, ...base };

  const limitUsd = cleanLimit(state.limitUsd);
  if (order.amountUsd <= limitUsd) {
    state.refunds[order.id] = "refunded";
    return { status: "refunded", ...base };
  }
  state.refunds[order.id] = "pending";
  return { status: "pending", ...base, limitUsd };
}
