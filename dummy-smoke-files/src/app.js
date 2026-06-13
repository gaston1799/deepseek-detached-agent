import { formatMessage } from "./util.js";
const data = require("./data.json");

export function runSmoke() {
  const message = formatMessage(data.name);
  return `SMOKE_TARGET app ${message}`;
}

console.log(runSmoke());

