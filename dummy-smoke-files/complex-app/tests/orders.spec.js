import { createOrder, listOrders } from "../src/services/orderService.js";

export function testListOrders() {
  const orders = listOrders();
  if (!orders.length) throw new Error("expected seeded orders");
}

export function testCreateOrder() {
  const order = createOrder({ total: 12, note: "test" });
  if (!order.id.startsWith("order-")) throw new Error("expected generated id");
  if (order.status !== "pending") throw new Error("expected pending status");
}
