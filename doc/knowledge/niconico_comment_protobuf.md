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

## 参考リソース

- [nicolive-comment-protobuf (公式Protobufスキーマ)](https://github.com/n-air-app/nicolive-comment-protobuf)
- [NDGRClient (Python クライアント実装)](https://github.com/tsukumijima/NDGRClient)
- [NdgrClientSharp (C# クライアント実装)](https://github.com/TORISOUP/NdgrClientSharp)
- [帰ってきたニコニコのニコ生コメントサーバーからのコメント取得備忘録 - Qiita](https://qiita.com/DaisukeDaisuke/items/3938f245caec1e99d51e)
- [実験放送の構成 - コメントサーバー編 - dwango on GitHub](https://dwango.github.io/niconico/jikken-housou/comment-server/)
