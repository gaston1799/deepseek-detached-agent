import { listUsers } from "../services/userService.js";
import { requireAuth } from "../utils/auth.js";

export default {
  list(context) {
    requireAuth(context);
    return listUsers();
  }
};

