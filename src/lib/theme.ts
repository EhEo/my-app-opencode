import { monaco } from "./monaco";

export type ThemeMode = "dark" | "light" | "system";
export type EffectiveTheme = "dark" | "light";

export function loadThemeMode(): ThemeMode {
  const raw = localStorage.getItem("theme");
  return raw === "light" || raw === "system" || raw === "dark" ? raw : "dark";
}

export function saveThemeMode(mode: ThemeMode): void {
  localStorage.setItem("theme", mode);
}

export function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(
  mode: ThemeMode,
  systemDark: boolean,
): EffectiveTheme {
  if (mode === "system") return systemDark ? "dark" : "light";
  return mode;
}

/** Apply the effective theme: CSS variables switch on the root data-theme
 *  attribute; Monaco has a matching defineTheme per mode. */
export function applyTheme(effective: EffectiveTheme): void {
  document.documentElement.dataset.theme = effective;
  monaco.editor.setTheme(
    effective === "light" ? "opencode-light" : "opencode-dark",
  );
}
