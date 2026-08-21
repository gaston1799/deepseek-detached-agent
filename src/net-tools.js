import { getArtifact } from "./artifacts.js";
import { sandboxExecute } from "./sandbox.js";

function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

async function pcapCommand({ cwd, taskId, artifact, command }) {
  const found = await getArtifact({ cwd, taskId, artifact });
  const relativeArtifact = found.record.path.replaceAll("\\", "/");
  const fullCommand = `tshark -r ${quote(`/workspace/${relativeArtifact}`)} ${command}`;
  return sandboxExecute({ cwd, taskId, environment: "network-analysis", command: fullCommand, timeoutMs: 120000, networkPolicy: "none" });
}

export async function netListInterfaces({ cwd = process.cwd(), taskId }) {
  return sandboxExecute({ cwd, taskId, environment: "network-analysis", command: "tshark -D", timeoutMs: 30000, networkPolicy: "none" });
}

export async function netProtocolSummary(options) { return pcapCommand({ ...options, command: "-q -z io,phs -c 10000" }); }
export async function netConversations(options) { return pcapCommand({ ...options, command: "-q -z conv,ip -c 10000" }); }
export async function netQueryPcap({ filter, fields, ...options }) {
  const display = filter ? `-Y ${quote(filter)}` : "";
  const projection = Array.isArray(fields) && fields.length ? `-T fields ${fields.map((field) => `-e ${quote(field)}`).join(" ")}` : "-T fields -e frame.number -e frame.protocols";
  return pcapCommand({ ...options, command: `${display} ${projection} -c 500` });
}
export async function netStreamSummary(options) { return pcapCommand({ ...options, command: "-q -z conv,tcp -c 10000" }); }
export async function netExtractFields(options) { return netQueryPcap(options); }
