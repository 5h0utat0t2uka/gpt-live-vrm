import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  appendCaption,
  mergeCaptions,
  sourceFromAnnotation,
  VoiceSession,
  type VoiceState,
} from "../src/lib/voice-session.ts";

class Track extends EventTarget {
  enabled = true;
  stopped = false;
  stop() {
    this.stopped = true;
  }
}
class Stream {
  track = new Track();
  getTracks() {
    return [this.track];
  }
  getAudioTracks() {
    return this.getTracks();
  }
}
class Channel extends EventTarget {
  readyState = "open";
  sent: Record<string, unknown>[] = [];
  close() {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  emit(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}
class Peer extends EventTarget {
  static current: Peer;
  channel = new Channel();
  connectionState = "new";
  iceGatheringState = "complete";
  localDescription = { sdp: "v=0\r\n" };
  closed = false;
  constructor() {
    super();
    Peer.current = this;
  }
  addTrack() {}
  createDataChannel() {
    return this.channel;
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0\r\n" };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() {
    this.closed = true;
  }
}
const descriptors = new Map<string, PropertyDescriptor | undefined>();
let microphone: Stream;
let audio: {
  srcObject: unknown;
  paused: boolean;
  play: () => Promise<void>;
  pause: () => void;
};
let state: VoiceState;
let session: VoiceSession;
function define(name: string, value: unknown) {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}
beforeEach(() => {
  microphone = new Stream();
  audio = {
    srcObject: null,
    paused: true,
    play: async () => {
      audio.paused = false;
    },
    pause: () => {
      audio.paused = true;
    },
  };
  define("navigator", {
    mediaDevices: { getUserMedia: async () => microphone },
  });
  define("isSecureContext", true);
  define("RTCPeerConnection", Peer);
  define("MediaStream", Stream);
  define("fetch", async () =>
    Response.json(
      {
        session: { id: "live_test" },
        transport: { type: "webrtc", sdp: "answer" },
      },
      { status: 201 },
    ),
  );
  session = new VoiceSession(audio as unknown as HTMLAudioElement, (next) => {
    state = next;
  });
});
afterEach(() => {
  session.dispose();
  for (const [key, value] of descriptors) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
  descriptors.clear();
});

test("full-duplex input stays enabled during assistant speech; close waits for final usage", async () => {
  await session.start();
  const peer = Peer.current;
  assert.equal(state.phase, "connecting");
  peer.channel.emit({ type: "session.started", event_id: "start" });
  peer.channel.emit({
    type: "session.output_transcript.delta",
    event_id: "out",
    delta: "こんにちは",
    start_ms: 0,
    end_ms: 100,
  });
  peer.channel.emit({
    type: "session.input_transcript.delta",
    event_id: "in",
    delta: "待って",
    start_ms: 50,
    end_ms: 150,
  });
  assert.equal(microphone.track.enabled, true);
  assert.equal(state.user[0].text, "待って");
  assert.equal(state.assistant[0].text, "こんにちは");
  assert.deepEqual(peer.channel.sent, []);
  session.toggleMute();
  assert.equal(microphone.track.enabled, false);
  session.toggleMute();
  assert.equal(microphone.track.enabled, true);
  session.stop();
  assert.equal(state.phase, "closing");
  assert.equal(microphone.track.enabled, false);
  assert.equal(peer.closed, false);
  assert.deepEqual(peer.channel.sent, [{ type: "session.close" }]);
  peer.channel.emit({
    type: "session.closed",
    event_id: "closed",
    usage: { seconds: 12.5 },
    reason: "close_requested",
  });
  assert.equal(state.finalized, true);
  assert.equal(state.seconds, 12.5);
  assert.equal(state.phase, "ended");
  assert.equal(peer.closed, true);
  assert.equal(microphone.track.stopped, true);
  peer.channel.emit({ type: "session.started" });
  assert.equal(state.phase, "ended");
});

test("ending before microphone permission resolves releases late tracks without connecting", async () => {
  let allow: (value: Stream) => void = () => {};
  Object.defineProperty(globalThis, "navigator", {
    value: {
      mediaDevices: {
        getUserMedia: () =>
          new Promise<Stream>((resolve) => {
            allow = resolve;
          }),
      },
    },
    configurable: true,
  });
  const starting = session.start();
  session.stop();
  allow(microphone);
  await starting;
  assert.equal(microphone.track.stopped, true);
  assert.equal(state.phase, "ended");
});

test("cancel during SDP request completes handshake only to gracefully close", async () => {
  let respond: (value: Response) => void = () => {};
  Object.defineProperty(globalThis, "fetch", {
    value: () =>
      new Promise<Response>((resolve) => {
        respond = resolve;
      }),
    configurable: true,
  });
  const starting = session.start();
  await new Promise((resolve) => setImmediate(resolve));
  session.stop();
  assert.equal(state.phase, "closing");
  respond(Response.json({ transport: { type: "webrtc", sdp: "answer" } }));
  await starting;
  Peer.current.channel.emit({ type: "session.started" });
  assert.equal(state.phase, "closing");
  assert.deepEqual(Peer.current.channel.sent, [{ type: "session.close" }]);
});

test("unexpected channel loss is not reported as successful finalization", async () => {
  await session.start();
  Peer.current.channel.emit({ type: "session.started" });
  Peer.current.channel.close();
  assert.equal(state.finalized, false);
  assert.equal(state.phase, "error");
  assert.equal(microphone.track.stopped, true);
});

test("close timeout releases the microphone without inventing final usage", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await session.start();
  Peer.current.channel.emit({ type: "session.started" });
  session.stop();
  t.mock.timers.tick(15001);
  assert.equal(state.phase, "error");
  assert.equal(state.finalized, false);
  assert.equal(microphone.track.stopped, true);
});

test("autoplay rejection has a retry control state", async () => {
  audio.play = async () => {
    throw new Error("blocked");
  };
  await session.start();
  await session.resumePlayback();
  assert.equal(state.playbackBlocked, true);
  audio.play = async () => {};
  await session.resumePlayback();
  assert.equal(state.playbackBlocked, false);
});

test("captions preserve spaces, repeated words and speaker-independent timing", () => {
  const first = appendCaption([], { delta: "そう", start_ms: 0, end_ms: 100 });
  const next = appendCaption(first, {
    delta: " そうです",
    start_ms: 100,
    end_ms: 400,
  });
  assert.equal(next[0].text, "そう そうです");
  assert.equal(appendCaption(next, { delta: "次", start_ms: 3000, end_ms: 3200 }).length, 2);
});

test("chat orders speakers by speech time, including delayed captions and overlapping acknowledgments", () => {
  const user = appendCaption([], { event_id: "user-1", delta: "質問", start_ms: 0, end_ms: 1000 });
  const assistant = appendCaption([], { event_id: "assistant-1", delta: "はい", start_ms: 500, end_ms: 700 });
  // A delayed continuation must keep growing the caller's original bubble.
  const continued = appendCaption(user, { delta: "です", start_ms: 1000, end_ms: 1200 });
  const answered = appendCaption(assistant, { delta: "回答です", start_ms: 3000, end_ms: 4000 });
  const nextQuestion = appendCaption(continued, { delta: "次の質問", start_ms: 5000, end_ms: 6000 });
  assert.deepEqual(
    mergeCaptions(nextQuestion, answered).map(({ speaker, text }) => [speaker, text]),
    [
      ["user", "質問です"],
      ["assistant", "はい"],
      ["assistant", "回答です"],
      ["user", "次の質問"],
    ],
  );
  assert.equal(user[0].text, "質問");
  assert.equal(assistant[0].text, "はい");
  // Delayed input may need to appear before output already received.
  assert.equal(mergeCaptions([], answered)[0].speaker, "assistant");
  assert.equal(mergeCaptions(continued, answered)[0].speaker, "user");
});

test("citation URLs reject executable schemes and credentials", () => {
  assert.equal(sourceFromAnnotation({ type: "url_citation", url: "javascript:alert(1)" }), null);
  assert.equal(
    sourceFromAnnotation({
      type: "url_citation",
      url: "https://user:pass@example.com",
    }),
    null,
  );
  assert.deepEqual(
    sourceFromAnnotation({
      type: "url_citation",
      url: "https://example.com",
      title: "出典",
    }),
    { url: "https://example.com/", title: "出典" },
  );
});

test("hosted search without citations remains visible and later citations deduplicate", async () => {
  await session.start();
  const channel = Peer.current.channel;
  channel.emit({ type: "session.started" });
  channel.emit({
    type: "response.event",
    event_id: "search",
    event: { type: "response.web_search_call.completed" },
  });
  assert.equal(state.searches, 1);
  assert.equal(state.sources.length, 0);
  const annotation = {
    type: "url_citation",
    url: "https://example.com/article",
    title: "公式記事",
  };
  channel.emit({
    type: "response.event",
    event_id: "citation",
    event: { type: "response.output_text.annotation.added", annotation },
  });
  channel.emit({
    type: "response.event",
    event_id: "item",
    event: {
      type: "response.output_item.done",
      item: {
        type: "message",
        content: [{ type: "output_text", annotations: [annotation] }],
      },
    },
  });
  assert.equal(state.sources.length, 1);
  assert.equal(state.sources[0].title, "公式記事");
});
