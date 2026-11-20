// Module 4: the Refund Console. When a person clicks Approve or Reject, the
// order changes and the chat tells the customer. The AI is mocked: every
// question comes back as a refund request the app put on hold.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLive } from "@/lib/ai/live";
import type { Progress } from "@/lib/copper/assistant/progress";

let heldOrder = "1003";

vi.mock("@/lib/copper/assistant/ask", () => ({
  askCopper: async () => {
    const { live, done } = createLive<Progress>();
    const amounts: Record<string, [string, number]> = {
      "1003": ["Copper Notes", 129],
      "1004": ["Copper Home", 149],
    };
    const [item, amountUsd] = amounts[heldOrder];
    done({
      status: "done",
      reply: "It's over the limit, so the support team will review it.",
      steps: [
        { type: "handoff", to: "Refund agent" },
        {
          type: "tool",
          id: `call-${heldOrder}`,
          name: "request_refund",
          state: "done",
          input: { orderId: heldOrder },
          output: {
            status: "pending",
            orderId: heldOrder,
            item,
            amountUsd,
            limitUsd: 50,
          },
        },
      ],
    });
    return { progress: live };
  },
}));

const { RefundConsole } = await import("@/components/copper/refund-console");

async function askFor(orderId: string) {
  heldOrder = orderId;
  fireEvent.change(screen.getByLabelText("Your question"), {
    target: { value: `Refund order ${orderId}` },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByTestId("pending-refund");
}

const orderRow = (id: string) =>
  screen.getAllByTestId("order").find((row) => row.textContent?.includes(id))!;

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("Refund Console decisions", () => {
  it("Approve refunds the order and the chat tells the customer", async () => {
    render(<RefundConsole aiConfigured />);
    await askFor("1003");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(within(orderRow("1003")).getByText("Refunded")).toBeTruthy(),
    );
    expect(screen.getByTestId("chat-notice").textContent).toMatch(
      /approved your refund for order #1003/,
    );
  });

  it("Reject keeps the money and the chat tells the customer", async () => {
    render(<RefundConsole aiConfigured />);
    await askFor("1004");
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() =>
      expect(
        within(orderRow("1004")).getByText("Refund rejected"),
      ).toBeTruthy(),
    );
    expect(screen.queryByTestId("pending-refund")).toBeNull();
    expect(screen.getByTestId("chat-notice").textContent).toMatch(
      /order #1004 .* rejected it, so it won't be refunded/,
    );
  });
});
