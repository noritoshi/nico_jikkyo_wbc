# ニコニコ生放送 コメントAPI仕様

## 概要

ニコニコ生放送の新配信基盤（2024年6月〜）では、コメントサーバーが従来のWebSocket+JSONから
**mpn (NDGR) API** に移行。Protobuf形式のバイナリをHTTPストリーミングで配信する。

- コードネーム: NDGR（のどぐろ）
- エンドポイント: `https://mpn.live.nicovideo.jp/`
- プロトコル: HTTP ストリーミング + Length-Delimited Protobuf Stream
- 公式スキーマ: https://github.com/n-air-app/nicolive-comment-protobuf

## 接続フロー

1. 番組ページのHTMLから `embedded_data` を取得
2. embedded_data内の WebSocket URL に接続
3. `startWatching` メッセージを送信
4. `messageServer` レスポンスで `viewUri` と `vposBaseTime` を取得
5. `viewUri?at=now` をポーリング → タイムスタンプ取得
6. `viewUri?at=<timestamp>` → セグメントURI取得
7. セグメントをfetch → Protobufデコード → コメント取得

## セグメントの種類

| パス | 内容 | 用途 |
|------|------|------|
| `/data/segment/v4/` | リアルタイムコメント | 通常表示用 |
| `/data/backward/v4/` | 過去コメント | 過去ログ取得用 |
| `/data/snapshot/v4/` | 埋め込みコンテンツ | アカシック等、表示不要 |

## ポーリングとストリーミングの仕組み

### viewUriポーリング（ロングポーリング）

viewUriへのHTTPリクエストはロングポーリング。サーバーは次のセグメントが準備できるまで
レスポンスを保持する（約30秒間）。クライアント側でポーリング頻度を上げることはできない。

```
?at=now → タイムスタンプ取得（即座に返る）
?at=<timestamp> → セグメントURI配信（~30秒保持、ストリーミング）
```

### セグメントのストリーミング配信（重要）

セグメントURIは**セグメントのデータが全て揃う前に配信される**。
セグメント自体もHTTPストリーミングで、コメントが投稿されるたびにリアルタイムに
フレームが追加される。

- セグメントURIは現在のセグメント配信終了の**約6秒前**に次セグメント情報が届く
- 複数セグメントを**並行して**ストリーミング読み取りすることで遅延を最小化
- `res.arrayBuffer()`で全体を待つと~30秒の遅延が発生する
- `res.body.getReader()`でチャンク単位に読み取ることでリアルタイム表示が可能

### WebSocketメッセージタイプ

WebSocketではコメントは流れない。メタデータのみ：
- `serverTime` — サーバー時刻
- `seat` — keepAlive間隔
- `stream` — HLS動画ストリーム情報
- `schedule` — 番組スケジュール
- `messageServer` — コメントサーバー（mpn viewUri）
- `akashicMessageServer` — アカシック
- `statistics` — 視聴者数・コメント数

## Protobuf構造

### ChunkedMessage (viewUriレスポンス)

```
ChunkedMessage {
  field 1: state (ChunkedState)
  field 2: signal
  field 3: segment info (セグメントURI含む)
  field 4: next (次のポーリング用タイムスタンプ)
}
```

### セグメント内フレーム構造

```
セグメント (Length-Delimited frames)
  └─ frame
       ├─ f1: メタデータ (bytes ~64)
       ├─ f2: コメントラッパー (bytes) ← コメントがある場合
       ├─ f4: メタデータ (bytes ~15)
       └─ f5: varint (フラグ)
```

### コメント抽出パス

```
frame.f2 (wrapper) → wrapper.f1 (inner protobuf) → Chat message
```

## Chat メッセージフィールド定義

公式スキーマ: `proto/dwango/nicolive/chat/data/atoms.proto`

| フィールド番号 | 名前 | 型 | 意味 |
|---|---|---|---|
| f1 | `content` | string | コメント本文 |
| f2 | `name` | optional string | コテハン（名前）。コマンド（`184`, `shita`, `red`等）も含む |
| f3 | `vpos` | int32 | 再生位置（1/100秒単位、放送開始からの経過時間） |
| f4 | `account_status` | AccountStatus enum | アカウント状態（0=一般, 1=プレミアム） |
| f5 | `raw_user_id` | optional int64 | 生ユーザーID（ID公開設定時のみ） |
| f6 | `hashed_user_id` | optional string | ハッシュ化ユーザーID（`a:xxx`形式） |
| f7 | `modifier` | Modifier | 色・サイズ・位置の装飾情報 |
| f8 | `no` | int32 | コメント番号（番組内連番） |

### Modifier (f7) の内容

テキストの装飾を指定:
- 位置: 上(ue) / 中(naka) / 下(shita)
- サイズ: big / medium / small
- 色: 名前指定(red, blue等) または RGB値
- フォント
- 透明度

### AccountStatus (f4) の値

- `0` (未設定/一般会員)
- `1` (プレミアム会員)

## コメントフィルタリング仕様

### コメントフィルター（こまいちゃん）

ドワンゴ独自開発のAI「こまいちゃん」による**サーバー側フィルタ**。
コメント投稿時にAIが判定し、不適切と判断されたコメントはmpn APIに配信されない。

- **放送者が番組作成時に設定**: 強度は「強・やや強・中・弱・なし」の5段階
- **全視聴者に統一適用**: 放送者の設定がそのまま全視聴者に反映
- **外部APIなし**: レピュテーションスコアを問い合わせるAPIは非公開

つまり、mpn APIから配信されるコメントは**既にフィルタ済み**。
追加のクライアント側フィルタリングは基本的に不要。

### その他のフィルタ

- **NG設定**: ユーザー個別のNGワード・NGユーザー設定（クライアント側）
- **コメント番号(f8)の欠番**: フィルタされたコメントの痕跡として番号が飛ぶ可能性あり

## vposBaseTime

WebSocketの`messageServer`レスポンスに含まれる。
vposの基準時刻（ISO 8601形式）。

```
実際の表示時刻 = vposBaseTime + (vpos / 100) 秒
```

## 認証

- コメント**閲覧**はログイン**不要**（シークレットモードでも可）
- コメント**投稿**はログイン**必要**（Cookieベースのセッション認証）
- embedded_dataのWebSocket URL内のaudience_tokenはセッション不要で取得できる
- ログイン済みCookieで`fetchWatchData`すると認証済みWebSocket URLが得られ、投稿可能になる

## コメント投稿API

既に接続中のWebSocketに JSON メッセージを送信する方式。

### 投稿リクエスト

```json
{
  "type": "postComment",
  "data": {
    "text": "コメント本文",
    "vpos": 857670,
    "isAnonymous": true,
    "color": "red",
    "size": "small"
  }
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `text` | string | 必須 | コメント本文 |
| `vpos` | int32 | 必須 | 再生位置（1/100秒単位）。`(現在時刻 - vposBaseTime) * 100` で計算 |
| `isAnonymous` | boolean | 省略可 | 184（匿名）。省略時はID公開 |
| `color` | string | 省略可 | 色名（red, blue, green等） |
| `size` | string | 省略可 | サイズ（big, medium, small） |

### 投稿レスポンス

```json
{
  "type": "postCommentResult",
  "data": {
    "chat": {
      "content": "コメント本文",
      "mail": "red small",
      "anonymity": 0,
      "restricted": false,
      "modifier": {
        "position": null,
        "size": "small",
        "color": "red",
        "font": null,
        "opacity": "normal"
      }
    }
  }
}
```

- `postCommentResult` が返れば投稿成功（ログイン済み）
- エラーが返れば未ログインまたは投稿制限

## 特許に関する注意

- ドワンゴが「動画上にコメントを横に流す」表示方式の特許を保有
  - 特許第4695583号、特許第4734471号（出願日: 2006年12月11日）
  - **2026年12月11日に失効予定**（出願から20年）
- 2025年3月3日: 最高裁でドワンゴがFC2に勝訴（海外サーバーでも侵害認定）
- ニコニコ代表が2022年に「コメントを流すアドオンは見つけ次第潰す」と発言
- bilibiliなど海外サービスは日本の特許権の範囲外
- Chrome Web Storeでの公開は特許リスクあり → GitHub公開+手動インストールが安全

## ニコニコの利用規約

- 外部ツール・コメントビューアの利用を明示的に禁止する条項はない
- スクレイピング・リバースエンジニアリングの明示的禁止もない
- 禁止事項: サーバー過負荷、運営妨害（一般的）
- 本拡張のポーリングはサーバー主導のロングポーリング（~30秒間隔）で負荷は最小限

## Chrome拡張の公開に関する知見

- Chrome Web Storeは審査あり（通常1〜3営業日）
- host_permissionsがあると審査が厳しめ
- `tabs`権限は`scripting`権限+`host_permissions`で代替可能
  - content_scriptの動的注入: `chrome.scripting.executeScript()`
  - backgroundとcontent_script間の通信: `chrome.runtime.connect()`（port方式）
- `cookies`権限は`host_permissions`があれば不要（fetchのcredentials: includeは動く）
- content_scriptの二重注入ガード: `window.__nikoJikkyoLoaded` フラグ
- git履歴のメール書き換え: `git filter-branch --env-filter`
- プロジェクトローカルのgit設定: `git config user.email` (--globalなし)

## 参考リソース

- [nicolive-comment-protobuf (公式Protobufスキーマ)](https://github.com/n-air-app/nicolive-comment-protobuf)
- [NDGRClient (Python クライアント実装)](https://github.com/tsukumijima/NDGRClient)
- [NdgrClientSharp (C# クライアント実装)](https://github.com/TORISOUP/NdgrClientSharp)
- [帰ってきたニコニコのニコ生コメントサーバーからのコメント取得備忘録 - Qiita](https://qiita.com/DaisukeDaisuke/items/3938f245caec1e99d51e)
- [実験放送の構成 - コメントサーバー編 - dwango on GitHub](https://dwango.github.io/niconico/jikken-housou/comment-server/)
