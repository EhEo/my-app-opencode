// Open a workspace-relative or absolute path in the OS default app.
export async function openInOsApp(path: string): Promise<void> {
  try {
    const mod = await import("@tauri-apps/plugin-opener");
    const fn =
      (mod as { openPath?: (p: string) => Promise<void> }).openPath ??
      (mod as { open?: (p: string) => Promise<void> }).open;
    if (typeof fn === "function") await fn(path);
  } catch {
    void 0;
  }
}

// Open an http(s)/mailto URL in the OS default browser (not the webview).
export async function openExternalUrl(url: string): Promise<void> {
  try {
    const mod = await import("@tauri-apps/plugin-opener");
    const fn =
      (mod as { openUrl?: (u: string) => Promise<void> }).openUrl ??
      (mod as { open?: (u: string) => Promise<void> }).open;
    if (typeof fn === "function") await fn(url);
  } catch {
    void 0;
  }
}
