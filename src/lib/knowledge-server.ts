import { readFileSync } from "node:fs";
import { type KnowledgeId, knowledgeAttribution, knowledgeCatalog } from "./knowledge-catalog.ts";

type FaqGroup = {
  id: KnowledgeId;
  items: { id: string; question: string; answer: string; sourceUrl: string }[];
};

// A static URL lets Next.js trace this server-side file into the deployment.
const faq: FaqGroup[] = JSON.parse(readFileSync(new URL("../data/knowledge/ndl-faq.json", import.meta.url), "utf8"));

export function parseKnowledgeIds(value: unknown): KnowledgeId[] {
  if (
    !Array.isArray(value) ||
    value.length > knowledgeCatalog.length ||
    value.some((id) => !knowledgeCatalog.some((entry) => entry.id === id)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("Invalid knowledge selection");
  }
  return value as KnowledgeId[];
}

export function readSelectedFaq(ids: KnowledgeId[]) {
  const groups = faq.filter((group) => ids.includes(group.id));
  return {
    attribution: knowledgeAttribution,
    groups: groups.map((group) => ({
      ...group,
      title: knowledgeCatalog.find((entry) => entry.id === group.id)?.title,
    })),
    // These are retrieved sources, not a claim that every entry was cited in an answer.
    sources: groups.flatMap((group) =>
      [...new Set(group.items.map((item) => item.sourceUrl))].map((url) => ({
        url,
        title: `国立国会図書館：${knowledgeCatalog.find((entry) => entry.id === group.id)?.title}`,
      })),
    ),
  };
}
