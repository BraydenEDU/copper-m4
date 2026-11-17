import { describe, expect, it } from "vitest";
import { refundTools } from "@/lib/copper/refunds/agent";
import { decideRefund, type RefundState } from "@/lib/copper/refunds/orders";

const fresh = (limitUsd: number): RefundState => ({ limitUsd, refunds: {} });

describe("refund rules", () => {
  it("refunds at or under the limit and holds anything over it", () => {
    const state = fresh(79);
    expect(decideRefund(state, "1002").status).toBe("refunded");
    expect(decideRefund(state, "1003").status).toBe("pending");
  });

  it("catches the same refund asked for twice", () => {
    const state = fresh(50);
    expect(decideRefund(state, "#1001").status).toBe("refunded");
    expect(decideRefund(state, "1001").status).toBe("already_refunded");
    expect(decideRefund(state, "1004").status).toBe("pending");
    expect(decideRefund(state, "1004").status).toBe("already_pending");
  });

  it("sends every refund to a person when the limit is 0", () => {
    const state = fresh(0);
    expect(decideRefund(state, "1001").status).toBe("pending");
    expect(decideRefund(fresh(-5), "1001").status).toBe("pending");
  });

  it("gives the agent no way to approve or pick an amount", () => {
    const input = refundTools(fresh(0)).request_refund.inputSchema;
    const parsed = (input as { parse: (v: unknown) => unknown }).parse({
      orderId: "1003",
      approved: true,
      amountUsd: 1,
    });
    expect(parsed).toEqual({ orderId: "1003" });
  });
});
