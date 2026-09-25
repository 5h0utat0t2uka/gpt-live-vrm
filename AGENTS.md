<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 作業用ファイル

- エージェントが作成する一時スクリプト、検証用の音声、スクリーンショット、ログは、プロジェクト内の `.tmp/` に保存する。`/tmp` や `/private/tmp` に散在させない。
- 音声デモの一時検証ファイルは `.tmp/voice-validation/` にまとめる。このディレクトリは Git 管理対象外。
- 継続して使う自動テストは `tests/` に置く。秘密情報を一時ファイルに書き出さない。
