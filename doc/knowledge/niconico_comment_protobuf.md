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

### Modifier (f7) の内容（公式Protobufスキーマより）

全てenum（varint）。デフォルト値(0)はprotobufでフィールド省略される。

```protobuf
message Modifier {
  enum Pos { naka = 0; shita = 1; ue = 2; }
  Pos position = 1;

  enum Size { medium = 0; small = 1; big = 2; }
  Size size = 2;

  enum ColorName {
    white = 0; red = 1; pink = 2; orange = 3; yellow = 4;
    green = 5; cyan = 6; blue = 7; purple = 8; black = 9;
    white2 = 10; red2 = 11; pink2 = 12; orange2 = 13; yellow2 = 14;
    green2 = 15; cyan2 = 16; blue2 = 17; purple2 = 18; black2 = 19;
  }
  message FullColor { int32 r = 1; int32 g = 2; int32 b = 3; }
  oneof color { ColorName named_color = 3; FullColor full_color = 4; }

  enum Font { defont = 0; mincho = 1; gothic = 2; }
  Font font = 5;

  enum Opacity { Normal = 0; Translucent = 1; }
  Opacity opacity = 6;
}
```

- `*2`系の色はプレミアム会員専用カラー
- `Translucent`: 連投制限やrestricted判定のコメントに適用される半透明表示
- 固定コメント(ue/shita)は本家では同位置に重ならないよう縦にスタックされる

### AccountStatus (f4) の値

- `0` (未設定/一般会員)
- `1` (プレミアム会員)

### 実データ検証結果（2026-03-09 WBC韓国vsオーストラリア戦）

100件超のコメントをフィールドダンプして確認した結果:

| フィールド | 出現率 | 実データ例 | 備考 |
|---|---|---|---|
| f1 (content) | 100% | `"韓国いけいけ"` | 常に存在 |
| f2 (name) | ほぼ空 | 大半は`bytes(0)`、まれに`str="あつ"`等のコテハン | 184(匿名)ユーザーは空。コテハン設定者のみ値あり |
| f3 (vpos) | ~98% | `varint=6163829` | まれに欠落するコメントあり |
| f4 (account_status) | ~30% | `varint=1` | 一般会員(0)はprotobuf省略で出現しない。値が出る=プレミアム |
| f5 (raw_user_id) | ~1% | `varint=23527943` | ID公開設定のユーザーのみ。大半は184なので出現しない |
| f6 (hashed_user_id) | ~99% | `str="a:3EDNoasUQX9wCGRG"` | ほぼ全コメントに存在。f5がある場合はf6が無いケースあり |
| f7 (modifier) | 100% | `bytes(0)`〜`bytes(6)` | 装飾なし=`bytes(0)`、装飾あり=`bytes(2)`〜`bytes(6)` |
| f8 (no) | 100% | `varint=16432` | 常に存在。番組内連番 |

**重要な発見:**
- f6 (hashed_user_id) はID公開ユーザー(f5あり)では欠落することがある → f5とf6は排他的
- f4はprotobufのデフォルト値(0)省略により、一般会員では出現しない。`varint=1`が出れば確実にプレミアム
- f2 (name) のコテハンはごく少数。概要分析で活用可能だが、ほぼ全ユーザーが匿名(184)

## 実況ダッシュボード（概要・ユーザー一覧）機能

### コメントログ蓄積
- background.jsで直近5分間・最大500件のコメントを`commentLog[]`に蓄積
- 各エントリ: `{ text, mail, userId, time }`
- `translucent`（低レピュテーション/連投制限）のコメントは蓄積対象外
- pruneは時間ベース（5分超）+ 件数ベース（500件超）の2段階

### AI概要生成
- モデル: gemini-2.5-flash（thinking, thinkingBudget: 2048）
- maxOutputTokens: 8192
- 自動更新: 3分間隔（autoSummaryTimer）
- 出力内容:
  1. 場の雰囲気（2-3文）
  2. 話題のトピック（3-5個）
  3. ユーザー傾向JSON（上位20名、固定カテゴリから選択）

### ユーザー傾向カテゴリ（固定7種）

| カテゴリ | 意味 |
|---|---|
| 解説 | 試合展開・戦術を説明 |
| ツッコミ | 面白がる・突っ込む |
| 応援 | 特定チーム/選手を応援 |
| 悲嘆 | 嘆き・絶望 |
| 盛り上げ | 草・www系 |
| 予想 | 展開・スコア予想 |
| 雑談 | 試合外の話題 |

- Geminiに固定候補から1つ選ばせる（自由生成だと「感情表現」「試合関連コメント」等の曖昧なカテゴリが多発するため）
- JSONはコメント数上位20名のみ出力（全員出すとMAX_TOKENSで切れる）
- `userTendencyCache`にキャッシュし、`buildUserList`でマージ

### ユーザー一覧（AIなし、リアルタイム集計）
- 10秒間隔で自動更新（パネル表示中のみ）
- 表示項目: ユーザーID（先頭8文字）、コメント数、傾向バッジ、経過時間、直近コメント
- コメント数降順、上位20名まで表示
- クリックで全コメント展開（スクロール可能）

### コメント推移グラフ
- background.jsで10秒バケット×60個（直近10分間）のコメント数を記録（`commentBuckets[]`）
- `recordCommentBucket()`で全コメント受信時にカウント（translucent含む）
- `getGraphData()`でMap化して60個の数値配列を返す
- content_scriptでCanvas線グラフ描画（5秒間隔更新）
- 時間軸ラベル: -10m / -5m / now、最大値ラベル: max/10s
- ホバーで「場の雰囲気」ツールチップ表示（`summaryHistory[]`から最寄りの概要を5分以内で検索）
- 概要生成時に「## 場の雰囲気」セクションのみ抽出してタイムスタンプ付き履歴保存（最大20件）

### ユーザー一覧
- 全コメントを記録（件数制限なし、5分間のウィンドウ内）
- 上位20名まで表示、コメント数降順
- ユーザーID行クリックで全コメント展開/折りたたみ（max-height: 150px、スクロール可能）

### UI構成
- 画面右側の固定サイドパネル（width: 320px）
- コメント推移グラフ（上部、高さ60px）→ AI概要セクション → ユーザー一覧セクション（flex: 1）
- 「実況」ボタンでパネル開閉（AIパネルと独立）
- 通常時はopacity: 0.85、ホバーで1.0

### Web検索コメント（Google Search Grounding）
- モデル: gemini-2.5-flash + `tools: [{googleSearch: {}}]`
- thinkingConfig は設定しない（thinking有効だと推論過程がtext出力に混入しMAX_TOKENSになる）
- citation除去: `[cite: N, M]` や `[N]` 形式のタグを正規表現で後処理除去
- 重複parts除去: 連続する同一textのpartsをフィルタ
- プロンプトに「[cite]タグ不要」を明記

### MAX_TOKENS対策
- ユーザー傾向JSONが巨大になるとfinishReason: MAX_TOKENSで切れる
- 対策1: 上位20名に制限 + 傾向5文字以内
- 対策2: maxOutputTokens 8192に増加
- 対策3: 不完全JSON修復（最後の完全エントリまでで`}`を閉じてパース）
- 対策4: 未閉じ```jsonブロックを概要テキストから除去

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
| `position` | string | 省略可 | 位置（ue, shita） |

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

## コメント重複表示の問題

- 同一コメントがmpnセグメント境界で2つのセグメントに重複して配信される場合がある
- コメント番号(f8)での重複排除は不完全（f8が取得できない場合がある）
- **クライアント側で同一テキスト+3秒以内の重複排除が有効**
- 日本語コメントで重複しやすく、ASCII-onlyでは重複しにくい傾向あり（原因不明）

## Netflix上のフォーカス管理

- Netflixプレーヤーはコントロール非表示時にJS経由でフォーカスを動画要素に移動させる
- コメント入力中にフォーカスが奪われるとIME変換が強制確定される（ブラウザ仕様）
- `focusin`イベントキャプチャで横取りする方式で対処可能だが、一瞬のフォーカス喪失は残る
- `HTMLElement.prototype.focus`上書きはcontent_scriptのisolated worldから動作しない

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

## Chrome拡張 content_script の WebSocket 制約

- content_script からの `fetch` / `XMLHttpRequest` は拡張の `host_permissions` に従い、ページのCSPに制約されない
- しかし `WebSocket` (wss://) は **ページのCSP (connect-src) に制約される**
- Netflix上の content_script から `wss://api.deepgram.com` への WebSocket 接続は 1006 (Abnormal Closure) で即座に失敗する
- offscreen document、background service worker からも同様に失敗（原因は異なる可能性あり）
- **回避策**: WebSocket の代わりに REST API (`fetch` POST) を使用する（`host_permissions` で許可済みなら動作する）
- Deepgram の場合: ストリーミング WebSocket API → REST API バッチ送信方式に変更して解決

## 参考リソース

- [nicolive-comment-protobuf (公式Protobufスキーマ)](https://github.com/n-air-app/nicolive-comment-protobuf)
- [NDGRClient (Python クライアント実装)](https://github.com/tsukumijima/NDGRClient)
- [NdgrClientSharp (C# クライアント実装)](https://github.com/TORISOUP/NdgrClientSharp)
- [帰ってきたニコニコのニコ生コメントサーバーからのコメント取得備忘録 - Qiita](https://qiita.com/DaisukeDaisuke/items/3938f245caec1e99d51e)
- [実験放送の構成 - コメントサーバー編 - dwango on GitHub](https://dwango.github.io/niconico/jikken-housou/comment-server/)
