import styles from "./page.module.css";

export default function About() {
  return (
    <main className={styles.main}>
      <p>
        このアプリは録音・会話履歴を保存せず、字幕は画面内だけに保持します。また、ミュート中でも接続と課金は継続し、デモは接続後10分で終了します。
      </p>
      <p>
        送信後のデータには
        <a href="https://developers.openai.com/api/docs/guides/your-data" target="_blank" rel="noopener noreferrer">
          OpenAI のデータ保持ポリシー
        </a>
        が適用されます。
      </p>
    </main>
  );
}
