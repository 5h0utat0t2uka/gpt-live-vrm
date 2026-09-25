"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { initialVoiceState, mergeCaptions, VoiceSession } from "../lib/voice-session.ts";
import styles from "./page.module.css";

const VoiceAvatar = dynamic(() => import("../components/voice-avatar"), {
  ssr: false,
  // loading: () => <p role="status">アバターを準備しています。</p>,
  loading: () => null,
});

const phaseLabels = {
  idle: "待機中",
  connecting: "接続中",
  connected: "会話中",
  closing: "終了処理中",
  ended: "終了",
  error: "接続を確認してください",
};

function Captions({ captions }: { captions: ReturnType<typeof mergeCaptions> }) {
  return (
    <section className={styles.transcript} aria-label="会話の字幕">
      {captions.length ? (
        // biome-ignore lint/a11y/noRedundantRoles: Safari needs an explicit list role when list-style is none.
        <ol className={styles.messages} role="list">
          {captions.map((caption) => (
            <li key={caption.id} className={caption.speaker === "user" ? styles.userMessage : styles.assistantMessage}>
              <p>
                <span className={styles.speaker}>{caption.speaker === "user" ? "あなた：" : "アシスタント："}</span>
                {caption.text}
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <p className={styles.empty}>会話の字幕がここに表示されます。</p>
      )}
    </section>
  );
}

export default function Home() {
  const [state, setState] = useState(initialVoiceState);
  const audio = useRef<HTMLAudioElement>(null);
  const session = useRef<VoiceSession | null>(null);
  const getOutputLevel = useCallback(() => session.current?.getOutputLevel() ?? 0, []);
  const active = ["connecting", "connected", "closing"].includes(state.phase);

  useEffect(() => {
    const leave = () => session.current?.leave();
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      session.current?.leave();
    };
  }, []);

  function start() {
    if (!audio.current || active) return;
    session.current?.dispose();
    const connection = new VoiceSession(audio.current, setState);
    session.current = connection;
    void connection.start();
  }

  return (
    <main className={styles.main}>
      <VoiceAvatar getLevel={getOutputLevel} />
      <nav className={styles.panelButtons} aria-label="会話パネル">
        <button type="button" popoverTarget="controls-panel">
          <svg width={24} height={24} viewBox="0 0 24 24" role="img" aria-label="chat">
            <path
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth={1.5}
              d="M4 10v4m4-7v10m4-13v16m4-13v10m4-7v4"
            ></path>
          </svg>{" "}
          <span className={styles.callState}>{state.playbackBlocked ? "再生を確認" : phaseLabels[state.phase]}</span>
        </button>
        <button type="button" popoverTarget="transcript-panel">
          <svg width={24} height={24} viewBox="0 0 24 24" role="img" aria-label="subtitle">
            <path
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193q-.51.041-1.02.072v3.091l-3-3q-2.031 0-4.02-.163a2.1 2.1 0 0 1-.825-.242m9.345-8.334a2 2 0 0 0-.476-.095a48.6 48.6 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.5 48.5 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402c-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235q.865.113 1.74.194V21l4.155-4.155"
            ></path>
          </svg>
        </button>
        <button type="button" popoverTarget="sources-panel">
          <svg width={24} height={24} viewBox="0 0 24 24" role="img" aria-label="refs">
            <g fill="none" stroke="currentColor" strokeWidth={1.5}>
              <circle cx={12} cy={12} r={10}></circle>
              <ellipse cx={12} cy={12} rx={4} ry={10}></ellipse>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2 12h20"></path>
            </g>
          </svg>
        </button>
      </nav>
      <section id="controls-panel" popover="auto" className={styles.panel} aria-labelledby="controls-heading">
        <div className={styles.panelHeading}>
          <h2 id="controls-heading">通話操作</h2>
          <button type="button" popoverTarget="controls-panel" popoverTargetAction="hide" aria-label="通話操作を閉じる">
            閉じる
          </button>
        </div>
        <div className={styles.status} role="status">
          <strong>{phaseLabels[state.phase]}</strong>
          <p>{state.message}</p>
        </div>
        <div className={styles.buttons}>
          <button type="button" className={styles.start} onClick={start} disabled={active}>
            会話を開始
          </button>
          <button
            type="button"
            onClick={() => session.current?.toggleMute()}
            disabled={state.phase !== "connected"}
            aria-pressed={state.muted}
          >
            {state.muted ? "マイクを再開" : "マイクをミュート"}
          </button>
          <button type="button" onClick={() => session.current?.stop()} disabled={!active || state.phase === "closing"}>
            会話を終了
          </button>
        </div>
        {state.playbackBlocked && (
          <div className={styles.notice} role="alert">
            <p>音声の再生がブラウザにより停止されています。</p>
            <button
              type="button"
              onClick={() => {
                void session.current?.resumePlayback();
              }}
            >
              音声を再生
            </button>
          </div>
        )}
      </section>
      {/* biome-ignore lint/a11y/useMediaCaption: Live captions are rendered in the transcript panel. Audio stays mounted while panels are hidden. */}
      <audio ref={audio} autoPlay playsInline aria-label="アシスタントの音声" />

      <section id="transcript-panel" popover="auto" className={styles.panel} aria-labelledby="transcript-heading">
        <div className={styles.panelHeading}>
          <h2 id="transcript-heading">字幕</h2>
          <button type="button" popoverTarget="transcript-panel" popoverTargetAction="hide" aria-label="字幕を閉じる">
            閉じる
          </button>
        </div>
        <Captions captions={mergeCaptions(state.user, state.assistant)} />
      </section>
      <section
        id="sources-panel"
        popover="auto"
        className={`${styles.panel} ${styles.sources}`}
        aria-labelledby="sources-heading"
      >
        <div className={styles.panelHeading}>
          <h2 id="sources-heading">検索の出典</h2>
          <button type="button" popoverTarget="sources-panel" popoverTargetAction="hide" aria-label="出典を閉じる">
            閉じる
          </button>
        </div>
        {state.sources.length === 0 && (
          <p>
            {state.searches > 0
              ? "検索は完了しました。出典 URL はまだ届いていません。天気など、出典 URL が返されない結果もあります。"
              : "検索の出典はまだありません。"}
          </p>
        )}
        <ul>
          {state.sources.map((source) => (
            <li key={source.url}>
              <a href={source.url} target="_blank" rel="noopener noreferrer">
                {source.title} ↗
              </a>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
