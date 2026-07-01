import OpenAI from "openai";
import type { Settings } from "./settings";
import { createTauriFetch } from "./tauriFetch";

const tauriFetch = createTauriFetch();

/**
 * Build an OpenAI-compatible SDK client from persisted user settings.
 *
 * SECURITY: `dangerouslyAllowBrowser: true` is required AND safe here.
 * opencode-desktop is a Tauri native desktop app; this code runs inside the
 * Tauri webview on the user's OWN machine — the same device that owns the API
 * key. It is NOT served over HTTP to third parties. The SDK's browser guard
 * exists to stop publishing keys to anonymous website visitors, which is not
 * our threat model. Without the flag the SDK refuses to construct in any
 * browser-like runtime (the Tauri webview counts as one), so the app could
 * never make a single LLM call.
 *
 * API key: some local servers (plain llama.cpp / Ollama) need no auth. The
 * SDK still rejects an empty string, so we substitute a dummy `"none"` — a
 * server that ignores the Authorization header won't care, and one that
 * requires auth will simply 401, surfacing via `testConnection` / `onError`.
 */
export function createClient(s: Settings): OpenAI {
  return new OpenAI({
    baseURL: s.baseUrl,
    apiKey: s.apiKey || "none",
    dangerouslyAllowBrowser: true,
    fetch: tauriFetch,
  });
}
