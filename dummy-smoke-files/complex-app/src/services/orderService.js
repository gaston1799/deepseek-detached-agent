import { money } from "../utils/format.js";
import seedOrders from "../data/orders.json" with { type: "json" };

export function listOrders() {
  return seedOrders.map((order) => ({
    ...order,
    displayTotal: money(order.total)
  }));
}

export function createOrder(payload) {
  return {
    id: `order-${Date.now()}`,
    status: "pending",
    note: payload.note || "new order",
    total: payload.total || 0
  };
}
