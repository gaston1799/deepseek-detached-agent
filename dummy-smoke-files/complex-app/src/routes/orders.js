import { createOrder, listOrders } from "../services/orderService.js";
import { requireAuth } from "../utils/auth.js";

export default {
  list(context) {
    requireAuth(context);
    return listOrders();
  },
  create(context, payload) {
    requireAuth(context);
    return createOrder(payload);
  }
};

