import Link from "next/link";
import styles from "./page.module.css";

export default function Privacy() {
  return (
    <main className={styles.main}>
      <p>
        このアプリは録音・会話履歴を保存しませんが、送信後のデータには
        <a href="https://developers.openai.com/api/docs/guides/your-data" target="_blank" rel="noopener noreferrer">
          OpenAI のデータ保持ポリシー
        </a>
        が適用され、学習データとしては利用されません。
      </p>
      <p>また、ミュート中でもAPI接続と課金は継続し、デモは接続後10分で終了します。</p>
      <Link href="/">← Back</Link>
    </main>
  );
}
