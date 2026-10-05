// Only display metadata is shared with the browser. FAQ answers stay on the server.
export const knowledgeCatalog = [
  { id: "ndl-services", title: "利用案内", description: "利用条件・料金・来館前の準備" },
  { id: "ndl-registration", title: "利用者登録", description: "登録の目的・利用できるサービス" },
  { id: "ndl-reading", title: "資料の閲覧・複写", description: "貸出・閲覧場所・コピーの利用条件" },
] as const;

export type KnowledgeId = (typeof knowledgeCatalog)[number]["id"];

export const knowledgeAttribution = {
  title: "国立国会図書館「よくあるご質問」",
  url: "https://www.ndl.go.jp/help",
  termsUrl: "https://www.ndl.go.jp/sitepolicy/terms",
  retrievedAt: "2026-10-04",
  notice: "国立国会図書館のFAQをもとに、本デモ用に質問・回答を抜粋・要約しています。公式の案内サービスではありません。",
};
