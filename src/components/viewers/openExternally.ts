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
