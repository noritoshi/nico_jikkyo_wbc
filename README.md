# Niko Jikkyo

Netflix の映像上にニコニコ生放送の実況コメントをリアルタイムに流す Chrome 拡張機能です。

2026 WBC (World Baseball Classic) の Netflix 独占配信を、ニコニコ実況のコメントと一緒に楽しむために作られました。

![screenshot](doc/screenshot.png)

## インストール方法

この拡張機能は Chrome ウェブストアでは公開していません。以下の手順で手動インストールしてください。

### 1. ファイルをダウンロード

[最新リリースページ](https://github.com/noritoshi/nico_jikkyo_wbc/releases/latest) を開き、**Assets** の中にある `niko-jikkyo-v*.zip` をクリックしてダウンロードします。

ダウンロードした ZIP ファイルをダブルクリックして解凍してください。

### 2. Chrome に拡張機能を追加

1. Chrome のアドレスバーに `chrome://extensions` と入力して Enter
2. 画面右上の「**デベロッパーモード**」のスイッチを **ON** にする
3. 画面左上に表示される「**パッケージ化されていない拡張機能を読み込む**」をクリック
4. 先ほど解凍したフォルダを選択して「選択」をクリック

Chrome のツールバーに「**ニコ×N**」のアイコンが表示されればインストール完了です。

## 使い方

### 1. Netflix で WBC の試合を開く

Netflix にアクセスして、見たい WBC の試合のページを開いてください。

### 2. ニコニコ実況のチャンネル ID を確認

ニコニコ生放送の実況チャンネルのページを開き、URL に含まれるチャンネル ID（例: `ch2650071`）または番組 ID（例: `lv349854345`）をコピーします。

WBC 2026 のニコニコ実況チャンネルは `ch2650071` です。

### 3. 拡張機能で接続

1. Chrome ツールバーの「**ニコ×N**」アイコンをクリック
2. チャンネル ID を入力（例: `ch2650071`）
3. 「**接続**」ボタンをクリック
4. 「接続済み」と表示されれば OK

Netflix の映像上にニコニコ実況のコメントがリアルタイムに流れます。

### 4. 終了するとき

ポップアップの「**切断**」ボタンをクリックするか、Netflix のタブを閉じてください。

## よくある質問

**Q. ニコニコのアカウントは必要ですか？**
A. いいえ、ログイン不要で使えます。

**Q. コメントが流れません**
A. Netflix のタブを開いた状態で拡張機能から接続してください。接続後に Netflix のページを開いた場合は、ページを再読み込み（F5）してから再接続してください。

**Q. WBC 以外でも使えますか？**
A. ニコニコ生放送のチャンネル ID や番組 ID を指定すれば、他の番組のコメントも流せます。

## 不具合報告・改善要望

バグや改善のアイデアがあれば、メールで教えてください：

**nicojikkyowbc+app@gmail.com**

---

## 技術情報

<details>
<summary>開発者向け情報（クリックで展開）</summary>

### Tech Stack

- Chrome Extension Manifest V3
- Offscreen Document API（WebSocket + HTTP ストリーミング維持）
- ニコニコ mpn (NDGR) API（protobuf over HTTP streaming）
- スキーマなし protobuf ワイヤフォーマットデコーダ（自前実装）

### Architecture

```
popup.html  ←→  background.js (Service Worker)
                      ↕
                offscreen.js (WebSocket + mpn polling)
                      ↕
                mpn segment streams (protobuf)
                      ↕
                background.js  →  content_script.js (Netflix overlay)
```

1. ニコニコ生放送ページから WebSocket URL を取得
2. WebSocket 接続で `messageServer.viewUri` を取得
3. viewUri をロングポーリング → セグメント URI をストリーミング受信
4. セグメントをストリーミング読み取り → コメントをリアルタイム表示

</details>

## License

MIT

## Disclaimer

- 本拡張機能はニコニコ動画/ニコニコ生放送の非公開 API を使用しています。API 仕様の変更により動作しなくなる可能性があります。
- 動画上にコメントを流す表示方式に関して、株式会社ドワンゴが特許（特許第4695583号等、2026年12月失効予定）を保有しています。本ソフトウェアの利用は自己責任でお願いします。
- Netflix および WBC (World Baseball Classic) の商標はそれぞれの権利者に帰属します。
