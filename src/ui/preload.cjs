const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("deepseekUi", {
  info: () => ipcRenderer.invoke("app:info"),
  listRuns: () => ipcRenderer.invoke("runs:list"),
  startChat: (input) => ipcRenderer.invoke("chat:start", input),
  onRuns: (handler) => {
    const listener = (_event, runs) => handler(runs);
    ipcRenderer.on("runs:update", listener);
    return () => ipcRenderer.off("runs:update", listener);
  },
  onRun: (handler) => {
    const listener = (_event, run) => handler(run);
    ipcRenderer.on("run:update", listener);
    return () => ipcRenderer.off("run:update", listener);
  }
});

