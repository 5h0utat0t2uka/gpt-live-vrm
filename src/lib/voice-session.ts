import { AudioLevel } from "./audio-level.ts";

export type Caption = { id: string; text: string; start: number; end: number };

// Keep each speaker's ongoing caption intact, including during overlapping speech.
export function mergeCaptions(user: Caption[], assistant: Caption[]) {
  return [
    ...user.map((caption) => ({ ...caption, id: `user:${caption.id}`, speaker: "user" as const })),
    ...assistant.map((caption) => ({ ...caption, id: `assistant:${caption.id}`, speaker: "assistant" as const })),
  ].sort((a, b) => a.start - b.start);
}

export type Source = { url: string; title: string };
export type VoiceState = {
  phase: "idle" | "connecting" | "connected" | "closing" | "ended" | "error";
  message: string;
  muted: boolean;
  playbackBlocked: boolean;
  seconds: number;
  finalized: boolean;
  user: Caption[];
  assistant: Caption[];
  sources: Source[];
  searches: number;
  backend: string;
  events: { id: string; type: string }[];
};

export const initialVoiceState: VoiceState = {
  phase: "idle",
  message: "開始するとマイクの許可を求められます。",
  muted: false,
  playbackBlocked: false,
  seconds: 0,
  finalized: false,
  user: [],
  assistant: [],
  sources: [],
  searches: 0,
  backend: "",
  events: [],
};

export function appendCaption(captions: Caption[], event: Record<string, unknown>): Caption[] {
  if (typeof event.delta !== "string" || typeof event.start_ms !== "number" || typeof event.end_ms !== "number")
    return captions;
  const last = captions.at(-1);
  if (last && event.start_ms >= last.start && event.start_ms - last.end < 1500) {
    return [...captions.slice(0, -1), { ...last, text: last.text + event.delta, end: event.end_ms }];
  }
  return [
    ...captions,
    {
      id: String(event.event_id ?? `${event.start_ms}-${captions.length}`),
      text: event.delta,
      start: event.start_ms,
      end: event.end_ms,
    },
  ].slice(-200);
}

export function sourceFromAnnotation(value: unknown): Source | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("type" in value) ||
    value.type !== "url_citation" ||
    !("url" in value) ||
    typeof value.url !== "string"
  )
    return null;
  try {
    const url = new URL(value.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    return {
      url: url.href,
      title: "title" in value && typeof value.title === "string" ? value.title : url.hostname,
    };
  } catch {
    return null;
  }
}

// Each instance owns a call: stale callbacks cannot affect a subsequent call.
export class VoiceSession {
  private state: VoiceState = { ...initialVoiceState };
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private microphone: MediaStream | null = null;
  private abort = new AbortController();
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private callTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private requested = false;
  private ready = false;
  private closing = false;
  private seen = new Set<string>();
  private responses = new Set<string>();
  private audio: HTMLAudioElement;
  private audioLevel = new AudioLevel();
  private onChange: (state: VoiceState) => void;

  constructor(audio: HTMLAudioElement, onChange: (state: VoiceState) => void) {
    this.audio = audio;
    this.onChange = onChange;
  }

  private update(change: Partial<VoiceState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...change };
    this.onChange(this.state);
  }

  private finish(message: string, finalized = false) {
    this.update({
      phase: finalized ? "ended" : "error",
      message,
      finalized,
      muted: false,
      playbackBlocked: false,
      backend: "",
    });
    this.dispose();
  }

  private send(event: Record<string, unknown>) {
    if (this.channel?.readyState !== "open") return false;
    try {
      this.channel.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }

  async start() {
    // Run during the start button's user gesture, before microphone permission awaits.
    this.audioLevel.start();
    this.update({
      phase: "connecting",
      message: "マイクの許可と接続を待っています。",
    });
    try {
      if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia)
        throw new Error("HTTPS または localhost の対応ブラウザで開いてください。");
      const microphone = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (this.disposed) {
        microphone.getTracks().forEach((track) => {
          track.stop();
        });
        return;
      }
      this.microphone = microphone;
      this.startupTimer = setTimeout(
        () => this.finish("接続を確認できませんでした。接続は解放しましたが、終了と最終利用時間は未確認です。"),
        50_000,
      );
      const peer = new RTCPeerConnection();
      this.peer = peer;
      for (const track of microphone.getAudioTracks()) {
        peer.addTrack(track, microphone);
        track.addEventListener("ended", () => {
          if (!this.disposed) this.stop();
        });
      }
      peer.addEventListener("track", ({ track }) => {
        if (this.disposed || this.closing) return;
        const stream = new MediaStream([track]);
        this.audio.srcObject = stream;
        this.audioLevel.attach(stream);
        void this.resumePlayback();
      });
      peer.addEventListener("connectionstatechange", () => {
        if (this.disposed) return;
        clearTimeout(this.disconnectTimer);
        if (peer.connectionState === "failed") this.finish("通信が失敗しました。終了と最終利用時間は未確認です。");
        else if (peer.connectionState === "disconnected") {
          this.update({ message: "通信の復帰を待っています。" });
          this.disconnectTimer = setTimeout(
            () => this.finish("通信が切断されました。終了と最終利用時間は未確認です。"),
            8000,
          );
        } else if (peer.connectionState === "connected" && this.ready && !this.closing)
          this.update({ message: "接続中です。自由に話しかけてください。" });
      });
      const channel = peer.createDataChannel("oai-events");
      this.channel = channel;
      channel.addEventListener("message", ({ data }) => this.handleMessage(data));
      channel.addEventListener("close", () => {
        if (!this.disposed) this.finish("接続が閉じられました。終了と最終利用時間は未確認です。");
      });
      const offer = await peer.createOffer();
      if (this.disposed) return;
      await peer.setLocalDescription(offer);
      await this.gatherIce(peer);
      if (this.disposed) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error("接続情報を作成できませんでした。");
      this.requested = true;
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ sdp }),
        signal: this.abort.signal,
      });
      const result = await response.json();
      if (this.disposed) return;
      if (!response.ok)
        throw new Error(typeof result.error === "string" ? result.error : "接続を開始できませんでした。");
      if (typeof result.transport?.sdp !== "string") throw new Error("接続情報が不正です。");
      await peer.setRemoteDescription({
        type: "answer",
        sdp: result.transport.sdp,
      });
      // POST already starts the session; do not send session.start.
    } catch (error) {
      if (this.disposed) return;
      const message =
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "マイクの使用が許可されていません。ブラウザのサイト設定を確認してください。"
          : error instanceof DOMException && error.name === "NotFoundError"
            ? "使用できるマイクが見つかりません。"
            : error instanceof Error
              ? error.message
              : "接続に失敗しました。";
      this.finish(message);
    }
  }

  private gatherIce(peer: RTCPeerConnection) {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        peer.removeEventListener("icegatheringstatechange", check);
        this.abort.signal.removeEventListener("abort", cancel);
      };
      const check = () => {
        if (peer.iceGatheringState === "complete") {
          cleanup();
          resolve();
        }
      };
      const cancel = () => {
        cleanup();
        reject(new Error("接続を中止しました。"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("ネットワーク接続の準備がタイムアウトしました。"));
      }, 10_000);
      peer.addEventListener("icegatheringstatechange", check);
      this.abort.signal.addEventListener("abort", cancel, { once: true });
      if (this.abort.signal.aborted) cancel();
      else check();
    });
  }

  private handleMessage(data: unknown) {
    if (this.disposed || typeof data !== "string") return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data);
    } catch {
      this.finish("イベントを読み取れませんでした。終了確認は未完了です。");
      return;
    }
    if (!event || typeof event.type !== "string") return;
    if (typeof event.event_id === "string") {
      if (this.seen.has(event.event_id)) return;
      this.seen.add(event.event_id);
      if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value as string);
    }
    if (!event.type.endsWith(".delta") && event.type !== "session.usage.updated")
      this.update({
        events: [
          ...this.state.events,
          {
            id: String(event.event_id ?? crypto.randomUUID()),
            type: event.type,
          },
        ].slice(-30),
      });
    switch (event.type) {
      case "session.started":
        this.ready = true;
        clearTimeout(this.startupTimer);
        if (this.closing) {
          this.requestClose();
          break;
        }
        this.update({
          phase: "connected",
          message: "接続中です。自由に話しかけてください。",
        });
        // Demo safeguard, not a server-enforced billing quota.
        this.callTimer = setTimeout(() => this.stop(), 10 * 60_000);
        break;
      case "session.input_transcript.delta":
        this.update({ user: appendCaption(this.state.user, event) });
        break;
      case "session.output_transcript.delta":
        this.update({ assistant: appendCaption(this.state.assistant, event) });
        break;
      case "session.usage.updated":
      case "session.closed": {
        const usage = event.usage as { seconds?: unknown } | undefined;
        if (typeof usage?.seconds === "number") this.update({ seconds: usage.seconds });
        if (event.type === "session.closed")
          this.finish(
            `会話を終了しました。${event.reason === "close_requested" ? "" : "サーバーから終了が通知されました。"}`,
            true,
          );
        break;
      }
      case "response.event":
        this.handleResponse(event.event);
        break;
      case "error":
        this.update({
          message: "API が操作を受け付けませんでした。会話を終了して再接続してください。",
        });
        break;
    }
  }

  private handleResponse(value: unknown) {
    if (!value || typeof value !== "object" || !("type" in value)) return;
    const event = value as Record<string, unknown>;
    const response = event.response as { id?: string } | undefined;
    if (event.type === "response.web_search_call.completed") {
      this.update({ searches: this.state.searches + 1 });
    }
    if (event.type === "response.created" && response?.id) {
      this.responses.add(response.id);
      this.update({ backend: "回答を確認しています…" });
    }
    if (event.type === "response.web_search_call.in_progress" || event.type === "response.web_search_call.searching")
      this.update({ backend: "Web を検索しています…" });
    if (
      ["response.completed", "response.failed", "response.incomplete", "response.cancelled"].includes(
        String(event.type),
      )
    ) {
      if (response?.id) this.responses.delete(response.id);
      this.update({
        backend:
          event.type === "response.completed"
            ? this.responses.size
              ? "回答を確認しています…"
              : ""
            : "バックエンドの回答を完了できませんでした。",
      });
    }
    const annotations: unknown[] = [];
    if (event.type === "response.output_text.annotation.added") annotations.push(event.annotation);
    if (event.type === "response.output_item.done") {
      const item = event.item as { content?: { annotations?: unknown[] }[] } | undefined;
      for (const part of item?.content ?? []) annotations.push(...(part.annotations ?? []));
    }
    const sources = new Map(this.state.sources.map((source) => [source.url, source]));
    for (const annotation of annotations) {
      const source = sourceFromAnnotation(annotation);
      if (source) sources.set(source.url, source);
    }
    if (annotations.length) this.update({ sources: [...sources.values()].slice(-30) });
  }

  toggleMute() {
    if (!this.ready || this.closing || this.disposed) return;
    const muted = !this.state.muted;
    this.microphone?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
    this.update({ muted });
  }

  async resumePlayback() {
    if (this.disposed || this.closing) return;
    this.audioLevel.resume();
    try {
      await this.audio.play();
      this.update({ playbackBlocked: false });
    } catch {
      this.update({ playbackBlocked: true });
    }
  }

  stop() {
    if (this.disposed || this.closing) return;
    this.closing = true;
    this.audio.pause();
    this.microphone?.getAudioTracks().forEach((track) => {
      track.enabled = false;
    });
    if (!this.requested) {
      this.update({
        phase: "ended",
        message: "接続を中止しました。",
        finalized: false,
      });
      this.dispose();
      return;
    }
    this.update({
      phase: "closing",
      message: "マイクと再生を止め、終了確認を待っています。",
      muted: true,
      playbackBlocked: false,
    });
    if (this.ready) this.requestClose();
    // During startup receive the SDP answer, then close after session.started.
  }

  getOutputLevel() {
    if (this.disposed || this.closing || this.audio.paused || this.audio.muted || this.state.playbackBlocked) return 0;
    return this.audioLevel.read() * this.audio.volume;
  }

  private requestClose() {
    if (!this.send({ type: "session.close" })) {
      this.finish("終了要求を送れませんでした。最終利用時間は未確認です。");
      return;
    }
    this.closeTimer = setTimeout(
      () => this.finish("終了確認がタイムアウトしました。接続は解放しましたが、最終利用時間は未確認です。"),
      15_000,
    );
  }

  leave() {
    if (this.disposed) return;
    if (this.ready) this.send({ type: "session.close" });
    this.finish("ページを離れたため切断しました。終了と最終利用時間は未確認です。");
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.startupTimer);
    clearTimeout(this.closeTimer);
    clearTimeout(this.disconnectTimer);
    clearTimeout(this.callTimer);
    this.abort.abort();
    this.microphone?.getTracks().forEach((track) => {
      track.stop();
    });
    this.channel?.close();
    this.peer?.close();
    this.audioLevel.dispose();
    this.audio.pause();
    this.audio.srcObject = null;
  }
}
