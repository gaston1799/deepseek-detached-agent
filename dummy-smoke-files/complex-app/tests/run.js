import { testListOrders, testCreateOrder } from "./orders.spec.js";
import { testListUsers } from "./users.spec.js";

let passed = 0;
let failed = 0;

function run(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

console.log("Running smoke tests...\n");

run("listOrders", testListOrders);
run("createOrder", testCreateOrder);
run("listUsers", testListUsers);

console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) process.exit(1);
