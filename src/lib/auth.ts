import { createHash, timingSafeEqual } from "node:crypto";

const digest = (value: string) => createHash("sha256").update(value).digest();

// Called by both Proxy and the paid API route. Missing secrets fail closed.
export function requireBasicAuth(request: Request): Response | null {
  const user = process.env.BASIC_AUTH_USER;
  const password = process.env.BASIC_AUTH_PASS;
  const headers = { "Cache-Control": "no-store" };
  if (!user || !password || user.includes(":")) {
    return Response.json({ error: "Basic 認証の環境変数を設定してください。" }, { status: 503, headers });
  }
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
  if (match && authorization.length <= 4096) {
    const credentials = Buffer.from(match[1], "base64").toString("utf8");
    if (timingSafeEqual(digest(credentials), digest(`${user}:${password}`))) return null;
  }
  return Response.json(
    { error: "認証が必要です。ページを再読み込みしてください。" },
    {
      status: 401,
      headers: {
        ...headers,
        "WWW-Authenticate": 'Basic realm="Voice demo", charset="UTF-8"',
      },
    },
  );
}
