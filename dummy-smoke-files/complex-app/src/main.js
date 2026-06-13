import { createRouter } from "./router.js";
import { loadConfig } from "./utils/config.js";
import orders from "./routes/orders.js";
import users from "./routes/users.js";

export function bootstrap() {
  const config = loadConfig("config/app.json");
  const router = createRouter();
  router.use("/orders", orders);
  router.use("/users", users);
  return {
    name: config.service,
    marker: "bootstrap",
    router
  };
}

