const { app, BrowserWindow, ipcMain } = require("electron");
const { createServer } = require("node:http");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const workspace = process.env.DEEPSEEK_UI_WORKSPACE || process.cwd();
const cliExe = process.env.DEEPSEEK_UI_CLI_EXE || "d";
const cliScript = process.env.DEEPSEEK_UI_CLI_SCRIPT || "";
const controlPort = Number.parseInt(process.env.DEEPSEEK_UI_PORT || "17891", 10);
const cdpPort = Number.parseInt(process.env.DEEPSEEK_UI_CDP_PORT || "9223", 10);
const runs = new Map();

let mainWindow = null;
let server = null;

function json(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text)
  });
  res.end(text);
}

function readRequestJson(req) {
  return new Promise((resolvePromise, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("error", reject);
    req.on("end", () => {
      if (!body.trim()) return resolvePromise({});
      try { resolvePromise(JSON.parse(body)); }
      catch (error) { reject(error); }
    });
  });
}

function cliCommandArgs(promptFile, outputFile, permission) {
  const args = [];
  if (cliScript) args.push(cliScript);
  args.push(
    "--prompt-file", promptFile,
    "--outfile", outputFile,
    "--no-output",
    "--permission", permission || "review"
  );
  return args;
}

function parseOutput(markdown) {
  const finalMatch = markdown.match(/## Final Response\s+([\s\S]*?)(?:\n## Files Touched|\s*$)/);
  const filesMatch = markdown.match(/## Files Touched\s+([\s\S]*?)\s*$/);
  const finalResponse = finalMatch ? finalMatch[1].trim() : markdown.trim();
  const touchedFiles = filesMatch
    ? filesMatch[1].split(/\r?\n/).map((line) => line.replace(/^-\s*/, "").trim()).filter((line) => line && line !== "None")
    : [];
  return { finalResponse, touchedFiles, markdown };
}

async function startRun({ prompt, permission = "review" }) {
  if (!prompt || typeof prompt !== "string") throw new Error("prompt is required.");
  if (!["review", "full"].includes(permission)) throw new Error("permission must be review or full.");

  const id = randomUUID();
  const dir = resolve(workspace, ".deepseek-watch", "ui", id);
  await mkdir(dir, { recursive: true });
  const promptFile = join(dir, "prompt.md");
  const outputFile = join(dir, "result.md");
  await writeFile(promptFile, prompt, "utf8");

  const run = {
    id,
    prompt,
    permission,
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    outputFile,
    promptFile,
    stdout: "",
    stderr: "",
    exitCode: null,
    finalResponse: "",
    touchedFiles: []
  };
  runs.set(id, run);
  emitRuns();

  const args = cliCommandArgs(promptFile, outputFile, permission);
  const child = spawn(cliExe, args, {
    cwd: workspace,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    run.stdout += chunk;
    run.updatedAt = new Date().toISOString();
    emitRun(run);
  });
  child.stderr.on("data", (chunk) => {
    run.stderr += chunk;
    run.updatedAt = new Date().toISOString();
    emitRun(run);
  });
  child.on("error", (error) => {
    run.status = "error";
    run.stderr += `\n${error.message}`;
    run.updatedAt = new Date().toISOString();
    emitRun(run);
  });
  child.on("close", async (code) => {
    run.exitCode = code;
    run.status = code === 0 ? "complete" : "error";
    try {
      Object.assign(run, parseOutput(await readFile(outputFile, "utf8")));
    } catch (error) {
      if (code === 0) run.status = "error";
      run.stderr += `\nCould not read output file: ${error.message}`;
    }
    run.updatedAt = new Date().toISOString();
    emitRun(run);
  });

  return run;
}

function safeRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    permission: run.permission,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    outputFile: run.outputFile,
    exitCode: run.exitCode,
    finalResponse: run.finalResponse,
    touchedFiles: run.touchedFiles,
    stdoutTail: run.stdout.slice(-4000),
    stderrTail: run.stderr.slice(-4000)
  };
}

function emitRuns() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("runs:update", Array.from(runs.values()).map(safeRun));
  }
}

function emitRun(run) {
  emitRuns();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("run:update", safeRun(run));
}

function startControlServer() {
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://127.0.0.1:${controlPort}`);
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, {
          ok: true,
          workspace,
          controlPort,
          cdpPort,
          runs: runs.size
        });
      }
      if (req.method === "POST" && url.pathname === "/chat") {
        const body = await readRequestJson(req);
        const run = await startRun({ prompt: body.prompt, permission: body.permission || "review" });
        return json(res, 202, safeRun(run));
      }
      const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
      if (req.method === "GET" && runMatch) {
        const run = runs.get(runMatch[1]);
        if (!run) return json(res, 404, { error: "run not found" });
        return json(res, 200, safeRun(run));
      }
      if (req.method === "GET" && url.pathname === "/runs") {
        return json(res, 200, Array.from(runs.values()).map(safeRun));
      }
      return json(res, 404, { error: "not found" });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  });
  server.listen(controlPort, "127.0.0.1");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(join(__dirname, "index.html"));
}

ipcMain.handle("app:info", () => ({ workspace, controlPort, cdpPort }));
ipcMain.handle("runs:list", () => Array.from(runs.values()).map(safeRun));
ipcMain.handle("chat:start", async (_event, input) => safeRun(await startRun(input || {})));

app.whenReady().then(() => {
  startControlServer();
  createWindow();
});

app.on("window-all-closed", () => {
  if (server) server.close();
  if (process.platform !== "darwin") app.quit();
});

