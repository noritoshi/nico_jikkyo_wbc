# Niko Jikkyo - 開発ガイド

## ナレッジベース

このプロジェクトには `doc/knowledge/` に技術仕様・設計判断の蓄積があります。
コードを変更する前に、関連するドキュメントを確認してください。

- `doc/knowledge/niconico_comment_protobuf.md` — ニコニコのコメントAPI仕様、protobuf構造、ダッシュボード機能設計、投稿API、Chrome拡張の知見
- `doc/knowledge/comment_art.md` — コメントアート（CA）の仕様・制約

## プロジェクト構成

- Chrome Extension Manifest V3
- `src/background.js` — Service Worker（API通信、コメントログ蓄積、AI概要生成）
- `src/offscreen.js` — Offscreen Document（WebSocket + mpnポーリング + protobufデコード）
- `src/content_script.js` — Netflix上のUI（コメント描画、入力バー、ダッシュボード）
- `src/content_style.css` — 全UIスタイル
- `src/popup.html` / `src/popup.js` — 拡張ポップアップ（接続設定、API Key設定）

## 外部API

- Gemini API（Google AI Studio）— コメント生成・概要分析に使用
- ニコニコ mpn (NDGR) API — コメント取得・投稿
