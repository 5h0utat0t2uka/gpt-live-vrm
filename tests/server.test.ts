import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { requireBasicAuth } from "../src/lib/auth.ts";
import { createSession, liveSessionConfig } from "../src/lib/live-server.ts";

let original: NodeJS.ProcessEnv;
const auth = () => `Basic ${Buffer.from("demo:demo-password").toString("base64")}`;
function request(body: unknown = { sdp: "v=0\r\n" }, headers: Record<string, string> = {}) {
  return new Request("https://demo.example/api/session", {
    method: "POST",
    headers: {
      authorization: auth(),
      origin: "https://demo.example",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  original = { ...process.env };
  process.env.BASIC_AUTH_USER = "demo";
  process.env.BASIC_AUTH_PASS = "demo-password";
  process.env.OPENAI_API_KEY = "test-key";
});
afterEach(() => {
  process.env = original;
});

test("auth fails closed and accepts passwords containing colons", () => {
  assert.equal(requireBasicAuth(request()), null);
  assert.equal(requireBasicAuth(request({}, { authorization: "Basic !!!" }))?.status, 401);
  assert.equal(requireBasicAuth(request({}, { authorization: "Bearer test-key" }))?.status, 401);
  process.env.BASIC_AUTH_PASS = "contains:colon";
  assert.equal(
    requireBasicAuth(
      request(
        {},
        {
          authorization: `Basic ${Buffer.from("demo:contains:colon").toString("base64")}`,
        },
      ),
    ),
    null,
  );
  delete process.env.BASIC_AUTH_PASS;
  assert.equal(requireBasicAuth(request())?.status, 503);
});

test("direct API rejects unauthorized, cross-origin, non-JSON and oversized requests before billing", async (t) => {
  const call = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must not call");
  });
  assert.equal((await createSession(request({}, { authorization: "" }))).status, 401);
  assert.equal((await createSession(request({}, { origin: "https://evil.example" }))).status, 403);
  assert.equal((await createSession(request({}, { origin: "" }))).status, 403);
  assert.equal((await createSession(request({}, { "content-type": "text/plain" }))).status, 415);
  assert.equal((await createSession(request({ sdp: `v=0${"x".repeat(70000)}` }))).status, 400);
  assert.equal((await createSession(request({ sdp: "bad" }))).status, 400);
  assert.equal(call.mock.callCount(), 0);
});

test("browser cannot override model, prompt or tools; API returns only connection data", async (t) => {
  const call = t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    assert.equal(_url, "https://api.openai.com/v1/live/sessions");
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.session, liveSessionConfig);
    assert.equal(body.session.store, false);
    return Response.json(
      {
        session: { id: "live_test", secret: "hidden" },
        transport: { type: "webrtc", sdp: "answer" },
      },
      { status: 201 },
    );
  });
  const response = await createSession(
    request({
      sdp: "v=0\r\n",
      session: { model: "other", instructions: "ignore", tools: ["bad"] },
    }),
  );
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    session: { id: "live_test" },
    transport: { type: "webrtc", sdp: "answer" },
  });
  assert.equal(call.mock.callCount(), 1);
});

test("billable POST is not retried and upstream secrets never appear in errors", async (t) => {
  t.mock.method(console, "error", () => {});
  const call = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: { message: "secret details" } }, { status: 429 }),
  );
  const response = await createSession(request());
  assert.equal(response.status, 429);
  assert.doesNotMatch(await response.text(), /secret details/);
  assert.equal(call.mock.callCount(), 1);
});
