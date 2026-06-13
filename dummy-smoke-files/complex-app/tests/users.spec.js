import { listUsers } from "../src/services/userService.js";

export function testListUsers() {
  const users = listUsers();
  if (users.length !== 2) throw new Error("expected two users");
}

