import { runAgent } from "./agent";
import { callTool } from "./mcp";
import {
  resolveConnection,
  findPreset,
  isProviderUsable,
  type ProviderStore,
  type Settings,
} from "./settings";
import type { PipelineDeps } from "./pipeline";

export function resolveInappSettings(
  store: ProviderStore,
  backend: { providerId: string; model?: string },
): Settings | null {
  if (backend.providerId === "") {
    const base = resolveConnection(store);
    if (base === null) return null;
    return backend.model !== undefined && backend.model !== ""
      ? { ...base, model: backend.model }
      : base;
  }
  const preset = findPreset(store, backend.providerId);
  const entry = store.providers[backend.providerId];
  if (preset === undefined || entry === undefined) return null;
  if (!isProviderUsable(store, backend.providerId)) return null;
  const baseUrl = entry.baseUrlOverride ?? preset.baseUrl;
  const model = backend.model || preset.models[0] || store.activeModel;
  if (baseUrl === "" || model === "") return null;
  return { baseUrl, apiKey: entry.apiKey, model };
}

export function makePipelineDeps(store: ProviderStore): PipelineDeps {
  return {
    runInapp: (backend, brief, onToken, signal) =>
      new Promise<string>((resolve, reject) => {
        const settings = resolveInappSettings(store, backend);
        if (settings === null) {
          reject(new Error("no in-app provider configured"));
          return;
        }
        let text = "";
        void runAgent({
          settings,
          systemPrompt: backend.systemPrompt,
          messages: [{ role: "user", content: brief }],
          signal,
          callbacks: {
            onToken: (d) => {
              text += d;
              onToken?.(d);
            },
            onAssistantText: () => {},
            onToolStart: () => {},
            onToolEnd: () => {},
            onFileChanged: () => {},
            onDone: (reason) => {
              if (reason === "aborted") {
                reject(new Error("aborted"));
                return;
              }
              resolve(text);
            },
            onError: (err) => reject(err),
          },
        });
      }),
    runMcp: async (backend, brief) => {
      const res = await callTool(`mcp__${backend.server}__${backend.tool}`, {
        input: brief,
      });
      return res.result;
    },
  };
}
