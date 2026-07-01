import { invoke } from "@tauri-apps/api/core";

export interface SkillMetadata {
  name: string;
  description: string;
}

export interface InstalledSkill {
  name: string;
  metadata: SkillMetadata;
  body: string;
}

export interface SkillEnableMap {
  [name: string]: { enabled: boolean };
}

function parseFrontmatter(
  text: string,
): { metadata: SkillMetadata; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (match === null) {
    const firstLine = text.split("\n", 1)[0]?.trim() ?? "";
    return {
      metadata: { name: firstLine, description: "" },
      body: text.trim(),
    };
  }
  const rawYaml = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  const name = extractYamlString(rawYaml, "name");
  const description = extractYamlString(rawYaml, "description");
  return {
    metadata: { name: name ?? "", description: description ?? "" },
    body,
  };
}

function extractYamlString(yaml: string, key: string): string | null {
  const re = new RegExp(`^${key}\\s*:\\s*(.+?)\\s*$`, "m");
  const m = yaml.match(re);
  if (m === null) return null;
  let v = (m[1] ?? "").trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  return v;
}

export async function listInstalled(): Promise<string[]> {
  const names = await invoke<string[]>("skill_list");
  return names;
}

export async function readInstalledSkill(
  name: string,
): Promise<InstalledSkill | null> {
  try {
    const text = await invoke<string>("skill_read", { name });
    const { metadata, body } = parseFrontmatter(text);
    return { name, metadata, body };
  } catch {
    return null;
  }
}

export async function loadAllInstalledSkills(): Promise<InstalledSkill[]> {
  const names = await listInstalled();
  const results = await Promise.all(names.map(readInstalledSkill));
  return results.filter((s): s is InstalledSkill => s !== null);
}

export async function installSkill(
  srcPath: string,
  name: string,
): Promise<void> {
  await invoke<void>("skill_install", { srcPath, name });
}

export async function uninstallSkill(name: string): Promise<void> {
  await invoke<void>("skill_uninstall", { name });
}

export function buildSkillsPrompt(
  skills: InstalledSkill[],
  enabledMap: SkillEnableMap,
): string {
  const active = skills.filter(
    (s) => enabledMap[s.name]?.enabled !== false,
  );
  if (active.length === 0) return "";
  const sections = active.map((s, i) => {
    const desc =
      s.metadata.description.length > 0
        ? `\n설명: ${s.metadata.description}\n`
        : "";
    return `## Skill ${i + 1}: ${s.name}${desc}\n${s.body}`;
  });
  return [
    "아래는 사용자가 설치한 Anthropic Skills 형식의 절차/SOP입니다.",
    "관련된 작업이면 이 지침을 따르세요. `load_skill` 같은 도구는 없으므로 본문은 매 호출마다 함께 전달됩니다.",
    "",
    sections.join("\n\n---\n\n"),
  ].join("\n");
}