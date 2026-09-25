# 音声接続・VRM の実装と検証

## 構成

- Next.js 16.3.6 / React 19.2.8。ローカル環境は Nix の Node.js 24.21.0 / pnpm 10.34.0。
- 音声モデル `gpt-live-1`、声 `marin`、日本語の会話指示。
- Responses delegation: `gpt-6-luna`、`reasoning.effort: low`、`web_search` / `tool_choice: auto`。独自の操作ツールは登録しない。
- `POST /api/session` がサーバーの API キーで `POST /v1/live/sessions` を呼び、SDP answer を返す。ブラウザからモデルやプロンプトを指定できない。
- 音声はブラウザと OpenAI 間の WebRTC メディアトラックで送受信。DataChannel は字幕、検索結果、状態通知に利用する。
- OpenAI SDK は使用せず、ブラウザ API とサーバーの fetch を使用。
- 字幕は発話開始時刻順の1列で表示し、ユーザーを右の吹き出し、アシスタントを左に配置。同じ話者の連続した断片はまとめ、相づちと同時発話では双方の字幕を独立して更新する。区切りは表示用の推定で、厳密なターン境界ではない。
- アバターはビューポート全体に表示。通話操作・字幕・検索の出典は右端のボタンから開く `popover="auto"` のパネルに配置し、初期状態では閉じる。ボタン、Esc、外側クリックで閉じられ、閉じても通話と口の開閉を継続する。通話状態は操作ボタンにも表示する。
- VRM 表示: Three.js 0.186.0、`@pixiv/three-vrm` 3.5.5。クライアント側で遅延ロードする。

## VRM と口の開閉

- `public/models/avatar.vrm` は VRM 1.0、約13.2 MiB。`aa` を含む母音・瞬きの表情を確認済み。モデルと約11.8秒の `animation.vrma` は埋め込みリソースのみで、外部 URL への参照はない。
- モデルは正面のバストアップを表示領域の中央に配置。頭頂と胸の位置からカメラを決め、画面幅に合わせて調整する。上腕は T ポーズから78度下げ、体の近くに置く。`animation.vrma` は読み込まない。
- 呼吸は4.8秒周期で、胸を最大0.6度、左右の肩を最大0.35度動かす。毎フレーム初期姿勢から計算し、角度を累積しない。`voice-avatar.tsx` 先頭の `BREATH_SECONDS`・`BREATH_CHEST_DEGREES`・`BREATH_SHOULDER_DEGREES` で調整する。`prefers-reduced-motion: reduce` では静止姿勢に戻す。タブ非表示中は更新を止める。正規化ボーンの変更は [VRMHumanoid.update](https://pixiv.github.io/three-vrm/docs/classes/three-vrm.VRMHumanoid.html#update) で描画用ボーンに反映し、髪の物理演算は追加しない。
- 瞬きは2〜6秒のランダムな間隔。閉じる80ms・閉じた状態40ms・開く160msの表情変化で、口の動きと独立して更新する。
- OrbitControls でカメラをアバターの周囲に回転させ、正面から水平±25度・垂直±25度に制限。マウス／1本指のドラッグ、キャンバスにフォーカスした状態の矢印キーに対応。操作を離すと約0.35秒で正面へ戻り、途中で再操作できる。`prefers-reduced-motion: reduce` では即座に復帰する。Home キーでも復帰でき、画面サイズ変更でも操作中の角度を維持する。3D のパンとズームは無効、ブラウザのピンチズームは許可する。
- 受信したアシスタントの MediaStream を Web Audio の AnalyserNode に分岐し、波形の RMS から `aa` の強さを決める。小さい雑音を除き、開口を平滑化する。音素の判定は行わない。
- 音声再生は既存の audio 要素を使用。解析ノードはスピーカーへ接続せず、音声を二重再生しない。自分のマイク音量は口に反映しない。
- 再生停止・自動再生の拒否・通話終了時は閉口。マイクのミュート中も、アシスタントの再生音声には反応する。終了とページ離脱時に解析用 AudioContext を閉じる。
- 描画は最大30fps・ピクセル比は最大2。非表示タブでは更新を止める。ページ離脱時はロードを中断し、描画ループ・GPU リソース・ImageBitmap を解放する。
- モデルや WebGL が利用できなくても音声会話は継続可能。描画失敗は再読み込みボタンで復帰できる。
- 口の動きは受信音声の音量に基づく簡易表現。Bluetooth など出力機器固有の再生遅延に対する厳密な同期補正は行っていない。

## 状態とリソース管理

- `session.started` を受信するまで「会話中」にしない。HTTP で開始済みなので `session.start` は送信しない。
- 音声入力は AI の発話中も有効。独自の VAD や `response.cancel` を挟まず、GPT-Live の全二重会話と指定プロンプトで割り込みに対応。
- ミュートはローカルの音声トラックを無効化し、無音を送信する。セッションと課金は継続する。
- 終了ボタンは再生とマイク入力を止め、`session.close` を送信。`session.closed` の受信後にマイク・DataChannel・PeerConnection を解放する。
- 15秒以内に終了確認が届かなければ、リソースを解放し「最終利用時間は未確認」と表示する。
- マイク許可待ちでのキャンセルにも対応。後から許可された音声トラックを停止し、セッションは作成しない。
- セッション作成 HTTP の途中で終了を押した場合は、接続情報を受け取り `session.started` 後に終了要求を送る。
- ページ離脱時は終了要求とリソース解放を試みるが、終了イベントを待てないため確認済みとは扱わない。
- ネットワーク切断やプロセス強制終了の際、API 側の終了時刻・最終利用時間を保証しない。自動再接続・課金対象 POST の自動再試行はしない。
- デモはブラウザ側のタイマーで接続後10分に終了を開始する。これはサーバー側の強制時間制限・予算制限ではなく、バックグラウンドでのタイマー停止にも影響される。

## 認証・秘密情報・保存

- `src/proxy.ts` の Basic 認証で画面、API、`/models/*` を保護。`_next/static` と `_next/image` は対象外。
- 課金 API は Proxy と独立して認証を再検証。認証情報が未設定なら 503 で閉じる。
- API は同一 Origin、JSON、64 KiB 以下の本文のみ許可。
- `OPENAI_API_KEY`、SDP、字幕、上流の生レスポンスをアプリのログへ記録しない。接続失敗時の HTTP ステータスと request ID のみ記録。
- SOPS で渡した秘密情報はサーバー環境で使用。クライアントへ渡さない。
- アプリには DB、録音、localStorage による会話保存を実装していない。字幕はページのメモリ内に保持し、新しい通話や再読み込みでクリアする。
- GPT-Live の `store: false` は音声セッション保存を無効化する。OpenAI 全体のゼロ保持を保証する設定ではない。
- 実 API 検証では、委譲した Responses の完了イベントに `store: true` が含まれていた。委譲先と検索には、それぞれの API データ保持条件が適用される。機密情報の利用可否は社内ルールと API プロジェクトのデータ管理設定に従う。
- 検索の出典は API の URL citation を表示し、http/https 以外や認証情報入り URL を拒否する。天気の検索では annotations が空で、出典 URL が返らないことを実測した。検索完了と URL の有無を区別する。

## 検証記録（2026-09-26）

実 API のテストには合成音声を使用。人のマイク音声や社内情報は入力していない。

| 項目 | 結果 |
| --- | --- |
| `gpt-live-1` / `gpt-6-luna` のモデル取得 | 対象 API キーでそれぞれ HTTP 200 |
| Chrome 153.0.8010.53 / macOS の WebRTC 接続 | `session.started` 受信 |
| ミュート・解除 | UI 状態切り替えを確認。送信トラック無効化は自動テストで確認 |
| 正常終了 | `session.closed`, `reason: close_requested`, 最終 `usage.seconds` を受信 |
| 日本語入力・音声応答 | 入出力字幕と受信音声の非ゼロ振幅を確認 |
| 割り込み | AI 発話中に「ちょっと待って。その話はやめて、こんにちは、とだけ言ってください」を入力。途中の説明が止まり「はい。こんにちは。」へ切り替わったことを確認 |
| Web 検索 | `response.web_search_call.completed` と `response.completed` を受信。天気の音声回答、通常の記事検索の URL citation 表示を確認 |
| 未認証の画面・API・モデル要求 | すべて 401 |
| クロス Origin のセッション作成 | 403 |
| 不正な本文のセッション作成 | API 課金前に 400 |
| 390px 幅 | 横方向のオーバーフローなし。ページ末尾まで表示可能 |
| 本番クライアント JS | 実際の API キー・Basic 認証情報の混入なし |
| ユニットテスト | 認証、リクエスト保護、キャンセル競合、終了待ち、異常切断、字幕、出典 URL の検証 |

検索テストはツール実行・音声への反映・引用表示を確認したもので、回答の正確性を保証しない。実際に「GPT-Live-1」の合成音声が字幕で「GPT Live版」と認識され、GPT-Live の別の発表を回答するケースがあった。固有名詞の聞き取り・確認質問・回答品質は追加評価が必要。

合成音声の単発結果であり、実マイク・スピーカーでのエコーや割り込み遅延を保証するものではない。実 Safari、実 iOS、Vercel 上の接続は未検証。

### VRM 表示の検証

Chrome の実モデル描画と、模擬の受信 MediaStream による検証。OpenAI API は呼び出していない。

- 正面のバストアップ、受信音量による開口・無音と終了による閉口を確認。
- マイクのミュート中もアシスタント音声の解析を継続。終了で AudioContext とマイクを解放し、2回目の通話でも解析が動作。
- 390px 幅で横方向のはみ出しなし。
- PC（1280×1000px）、390×844px の縦画面、844×390px の横画面で、トップと `/about` のヘッダー・フッターの位置、幅、高さ、タイトル文字サイズが一致することを Chrome で確認。キャンバスと各パネルはヘッダー・フッターの間に収まり、ページを往復しても配置は変わらない。長い字幕はパネル内でスクロールする。
- パネルの初期非表示、Enter/Tab/Esc とフォーカス復帰、外側クリック、パネルの切り替え、非表示中の音声再生と口の開閉の継続を確認。
- WebGL コンテキスト喪失からの再読み込み、About への移動で描画終了を確認。
- モデルの503時も音声接続と終了が可能。VRMA へのリクエストとモーション操作ボタンがないことを確認。
- 瞬きの開眼・閉眼フレームと、腕を体へ寄せた姿勢を Chrome で確認。マウスの上下左右と模擬タッチの斜めドラッグで、描画時のカメラ座標から水平・垂直とも±25度以内であることを確認。
- 矢印キーによる回転、Home による正面復帰、リサイズ後の角度維持、ホイール操作でズームしないことを確認。タッチ検証は Chrome の入力エミュレーションであり、実 iOS の結果ではない。
- 自動復帰への変更後、マウスの上下左右・タッチの終了とキャンセル・矢印キー解除で正面に戻ること、補間中の再ドラッグ、フォーカス喪失後の復帰と再操作、動きを減らす設定での即時復帰を Chrome で確認。型チェックと既存の19テストも成功。
- 自動テスト19件、型チェック、本番ビルドが成功。瞬きの閉眼・開眼、可変間隔、値の範囲も検証。
- 呼吸追加後、Chrome で2周期以上のボーン変化を測定し、胸・肩の角度上限、左右対称の動き、上腕78度とカメラ位置の維持、描画用ボーンへの反映を確認。動きを減らす設定の切り替えによる停止・再開と、ドラッグからの正面復帰も確認。型チェックと既存19テストが成功。

検証用のスクリプト・画像・結果は `.tmp/voice-validation/` に保存（Git 管理対象外）。実 Safari / iOS での描画・音声同期、および実 GPT-Live 音声との組み合わせは追加した VRM 機能について未検証。

## 実機での確認手順

対象: macOS 26 以降 / iOS 26 以降の最新 Safari・Chrome。

1. HTTPS の公開先で Basic 認証し、右端の「通話操作」を開いて「会話を開始」からマイクを許可する。
2. 日本語で質問し、聞き取れる音声と双方の字幕を確認する。
3. AI の発話中に「待って、別の質問です」と割り込み、長い説明を続けないことを確認する。
4. 最新情報を Web 検索するよう依頼し、回答と、API が返した場合の出典リンクを確認する。
5. マイクをミュートして話しても入力字幕が増えず、解除後に入力できることを確認する。
6. 終了を押し、「終了確認済み」とマイク使用の終了を確認する。
7. マイク拒否、接続準備中の終了、連続した開始・終了、ネットワーク切断を試す。
8. iOS の画面ロック・タブ復帰、Bluetooth の接続変更、スピーカーとイヤホンを確認する。
9. VRM が中央のバストアップで瞬きし、アシスタントの発話中は口が開閉、無音や終了時には閉じることを確認する。自分だけが話しているときには口が動かないことも確認する。
10. ドラッグによる上下左右の角度制限、矢印キーの操作、正面への復帰、画面回転と通話の再開を確認する。

自動再生が止まる場合は「音声を再生」を使う。字幕の区切りやバックエンドの完了を、実際の音声再生完了とはみなさない。

## Vercel に配置するとき

- Node.js は `24.x` を使用。Vercel はパッチ番号を管理するため、ローカルの 24.21.0 と同一とは限らない。
- 公開先の環境に `OPENAI_API_KEY`, `BASIC_AUTH_USER`, `BASIC_AUTH_PASS` を Sensitive Environment Variables として設定する。
- 本実装は分散レート制限のストレージを持たない。社内公開時は Vercel Firewall で `/api/session` の POST に対するレート制限を設定し、Basic 認証の総当たりも制限する。
- 今回はローカル実装・検証までで、Vercel の設定変更やデプロイは実施していない。

## 公式資料

- [GPT-Live WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live)
- [Delegation and tools](https://developers.openai.com/api/docs/guides/live-delegation)
- [GPT-Live prompting](https://developers.openai.com/api/docs/guides/live-prompting)
- [Session lifecycle and usage](https://developers.openai.com/api/docs/guides/live-conversations)
- [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)
- [Next.js Proxy](https://nextjs.org/docs/app/api-reference/file-conventions/proxy)
- [Vercel Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)
- [SOPS exec-env](https://getsops.io/docs/usage/advanced/#passing-secrets-to-other-processes)
- [three-vrm 公式リポジトリ](https://github.com/pixiv/three-vrm)
- [Three.js リソースの解放](https://threejs.org/manual/pages/how-to-dispose-of-objects.html)
- [Web Audio の波形取得](https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode/getFloatTimeDomainData)
- [Popover API](https://developer.mozilla.org/en-US/docs/Web/API/Popover_API/Using)
- [Three.js OrbitControls](https://threejs.org/docs/pages/OrbitControls.html)
