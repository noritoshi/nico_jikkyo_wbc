# Niko Jikkyo - 開発ガイド

## ナレッジベース

このプロジェクトには `doc/knowledge/` に技術仕様・設計判断の蓄積があります。
コードを変更する前に、関連するドキュメントを確認してください。

- `doc/knowledge/niconico_comment_protobuf.md` — ニコニコのコメントAPI仕様、protobuf構造、ダッシュボード機能設計、投稿API、Chrome拡張の知見
- `doc/knowledge/comment_art.md` — コメントアート（CA）の仕様・制約

## ドキュメント構成

- `doc/knowledge/` — 技術知識（ニコニコAPI仕様、コメントアート仕様など）
- `doc/issue/` — 機能開発の仕様・計画
  - `doc/issue/voice_input/` — 音声入力モード（requirements, spec, implementation_plan）
- `doc/design/` — UIデザイン（.penファイル）
  - `doc/design/voice_input/` — 音声入力モードのUIデザイン

## プロジェクト構成

- Chrome Extension Manifest V3
- `src/background.js` — Service Worker（API通信、コメントログ蓄積、AI概要生成）
- `src/offscreen.js` — Offscreen Document（WebSocket + mpnポーリング + protobufデコード）
- `src/content_script.js` — Netflix上のUI（コメント描画、入力バー、ダッシュボード）
- `src/content_style.css` — 全UIスタイル
- `src/popup.html` / `src/popup.js` — 拡張ポップアップ（接続設定、API Key設定）

## デバッグ方針

- 不具合の原因特定には、ユーザーにDevTools（Console, Network等）のログ確認を積極的に依頼すること
- console.log/warn でデバッグログを仕込み、ユーザーに出力内容を報告してもらって原因を切り分ける
- 推測だけで修正を重ねるより、ログで事実を確認してから修正する

## デバッグフラグ

- `src/background.js` と `src/offscreen.js` の先頭に `const DEBUG = true/false;` がある
- 開発中は `true` にしてコンソールログを出力
- `/release` 実行時は必ず `false` に戻すこと

## 外部API

- Gemini API（Google AI Studio）— コメント生成・概要分析に使用
- ニコニコ mpn (NDGR) API — コメント取得・投稿
