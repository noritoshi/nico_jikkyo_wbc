# 音声入力モード — 技術仕様

## アーキテクチャ

### メッセージフロー

```
content_script.js                background.js                offscreen.js
      │                               │                            │
      │── voiceStart ────────────────▶│── voiceStart ────────────▶│
      │   { keywords[] }              │   { deepgramApiKey,       │
      │                               │     keywords[] }          │
      │                               │                            │ getUserMedia()
      │                               │                            │ AudioContext(16kHz)
      │                               │                            │ Deepgram WebSocket
      │                               │                            │
      │◀── voiceTranscript ───────────│◀── voiceTranscript ───────│
      │   { text, isFinal }           │   { text, isFinal }       │ (interim/final結果)
      │                               │                            │
      │ isFinal=true → postComment ──▶│──────────────────────────▶│
      │ (既存の投稿フロー)              │                            │ watchWs.send()
      │                               │                            │
      │── voiceStop ─────────────────▶│── voiceStop ─────────────▶│
      │                               │                            │ CloseStream
      │                               │                            │ マイク解放
```

### 各コンポーネントの責務

| コンポーネント | 責務 |
|--------------|------|
| content_script.js | マイクボタンUI、キーワードリスト保持、interimテキスト表示、自動投稿判定 |
| background.js | メッセージルーティング、APIキー取得・転送、offscreen理由更新 |
| offscreen.js | マイクキャプチャ、PCM変換、Deepgram WebSocket管理、transcript解析 |

## Deepgram接続仕様

### WebSocket URL

```
wss://api.deepgram.com/v1/listen
  ?token={apiKey}
  &language=ja
  &model=nova-3
  &punctuate=true
  &smart_format=true
  &endpointing=800
  &interim_results=true
  &encoding=linear16
  &sample_rate=16000
  &channels=1
  &keywords={keyword1:boost1}&keywords={keyword2:boost2}...
```

### パラメータ詳細

| パラメータ | 値 | 理由 |
|-----------|-----|------|
| `token` | Deepgram APIキー | ブラウザWebSocketではカスタムヘッダー不可のためURLパラメータで認証 |
| `language` | `ja` | 日本語認識 |
| `model` | `nova-3` | 最新・最高精度モデル |
| `punctuate` | `true` | `!` `?` を付与するため有効化。不要な句読点（`。` `、`）は後処理で除去 |
| `smart_format` | `true` | 数値・スコアを読みやすく整形（「さんたいに」→「3対2」、「いちかい」→「1回」等）。Nova-3で日本語対応 |
| `endpointing` | `800` | 800msの無音で発話区切りと判定（1秒投稿目標に適合） |
| `interim_results` | `true` | 認識途中のテキストをリアルタイム取得（UIプレビュー用） |
| `encoding` | `linear16` | 16bit PCM |
| `sample_rate` | `16000` | 16kHz（音声認識に十分、帯域を節約） |
| `channels` | `1` | モノラル |
| `keywords` | 選手名等 | ブースト値付きで認識精度向上 |

### レスポンス構造

```json
{
  "type": "Results",
  "channel_index": [0, 1],
  "duration": 1.5,
  "start": 0.0,
  "is_final": true,
  "speech_final": true,
  "channel": {
    "alternatives": [
      {
        "transcript": "大谷ホームラン",
        "confidence": 0.95
      }
    ]
  }
}
```

### 投稿判定ロジック

| `is_final` | `speech_final` | 動作 |
|------------|---------------|------|
| `false` | - | interimテキストを入力欄にプレビュー表示 |
| `true` | `false` | 部分確定。プレビューを更新（投稿しない） |
| `true` | `true` | **発話完了 → 後処理 → 自動投稿** |

### テキスト後処理

Deepgramから返されたテキストを投稿前に加工する。

```javascript
function postProcessTranscript(text) {
  return text
    .replace(/[。、，．]/g, '')   // 句読点を除去（コメントに不要）
    .replace(/！/g, '!')         // 全角→半角（ニコニコの慣習）
    .replace(/？/g, '?')         // 全角→半角
    .trim();
}
```

**方針:**
- `punctuate=true` で Deepgram に感嘆符・疑問符を付与させる
- 句読点（`。` `、`）はニコニココメントに不自然なので除去
- `!` `?` は残す（「うおー!」「マジかよ!」「えっ?」等の感情表現に必要）
- 全角 `！` `？` は半角に統一（ニコニコの表記慣習）

### 発話時間に応じた文字引き伸ばし

Deepgramのレスポンスには単語レベルのタイミング情報が含まれる:

```json
{
  "words": [
    { "word": "うおー", "start": 0.0, "end": 2.5, "confidence": 0.9 }
  ]
}
```

この `duration = end - start` を使い、長く叫んだ発声をテキストに反映する。

**アルゴリズム:**

```javascript
// 伸ばし可能な末尾文字
const ELONGATABLE = /[ーあいうえおアイウエオぁぃぅぇぉァィゥェォっッ]$/;

// 基準発話時間（秒）: この時間以下なら引き伸ばしなし
const BASE_DURATION = 0.8;
// 1秒あたりの追加文字数
const CHARS_PER_SEC = 3;
// コメント最大文字数
const MAX_COMMENT_LENGTH = 75;

function elongateWord(word, duration) {
  if (duration <= BASE_DURATION) return word;
  const match = word.match(/(.*?)(([ーあいうえおアイウエオぁぃぅぇぉァィゥェォっッ])\3*)$/);
  if (!match) return word;

  const [, prefix, trail, char] = match;
  const extraChars = Math.round((duration - BASE_DURATION) * CHARS_PER_SEC);
  const elongated = prefix + char.repeat(trail.length + extraChars);
  return elongated;
}

function elongateTranscript(transcript, words) {
  // 各単語を発話時間に応じて引き伸ばし
  let result = transcript;
  for (const w of words) {
    const duration = w.end - w.start;
    const elongated = elongateWord(w.word, duration);
    if (elongated !== w.word) {
      result = result.replace(w.word, elongated);
    }
  }
  // コメント最大長を超えないようにトリム
  return result.slice(0, MAX_COMMENT_LENGTH);
}
```

**例:**

| 発声 | duration | 出力 |
|------|----------|------|
| うおー | 0.5秒 | うおー |
| うおー | 2.0秒 | うおーーーー |
| やったー | 0.6秒 | やったー |
| やったー | 2.5秒 | やったーーーーー |
| すごい | 1.5秒 | すごい（伸ばし文字なし → 変化なし） |
| えー | 3.0秒 | えーーーーーーー |

**適用タイミング:**
`postProcessTranscript()` の前に `elongateTranscript()` を適用する。

```
Deepgram結果 → elongateTranscript() → postProcessTranscript() → 投稿
```

### 叫び声・感嘆の扱い

音声入力では興奮した発声もコメントとして投稿する方針とする。

- 「うおー!」「やったー!」「マジかよ!」等の叫び声は正当なコメント
- Deepgramはこれらを正しくテキスト化する（endpointingで区切られた後に投稿）
- 空テキスト・空白のみの場合のみフィルタする

**Silero VAD（将来）との関係:**
VADはマイクに入力された**ユーザー自身の肉声**（叫び含む）を検知する。
フィルタされるのは**背景の他人の歓声・環境音**であり、ユーザーの叫び声ではない。

### WebSocketライフサイクル

```
voiceStart受信
  → getUserMedia()
  → new AudioContext({ sampleRate: 16000 })
  → createMediaStreamSource() → createScriptProcessor(4096, 1, 1)
  → new WebSocket(deepgramUrl)
  → onaudioprocess: Float32→Int16変換 → ws.send(buffer)
  → onmessage: JSONパース → voiceTranscript送信

voiceStop受信
  → ws.send(JSON.stringify({ type: "CloseStream" }))
  → MediaStreamTrack.stop()
  → AudioContext.close()
  → WebSocket.close()
  → 全参照をnull化

onclose/onerror（予期しない切断）
  → 自動再接続（最大3回、1秒間隔）
  → 3回失敗 → voiceError送信 → content_scriptがモード解除
```

## 音声処理

### PCMフォーマット変換

```
getUserMedia (48kHz float32)
  → AudioContext (resample to 16kHz)
  → ScriptProcessorNode (bufferSize: 4096)
  → onaudioprocess: Float32Array → Int16Array
  → WebSocket.send(Int16Array.buffer)
```

### Float32→Int16変換

```javascript
function float32ToInt16(float32Array) {
  const int16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return int16.buffer;
}
```

AudioContextの `sampleRate: 16000` 指定により、ブラウザ側でリサンプリングが行われる。
ScriptProcessorNodeは非推奨だが、offscreen documentでの単純な用途には十分であり、AudioWorkletの複雑さを回避する。

## キーワードリスト（初期版）

```javascript
const VOICE_KEYWORDS = [
  // 侍ジャパン主要選手（2026 WBC想定）
  '大谷翔平:2', '山本由伸:2', '鈴木誠也:2', '吉田正尚:2',
  '村上宗隆:2', '牧秀悟:2', '源田壮亮:2', '宮城大弥:2',
  '佐々木朗希:2', '今永昇太:2', 'ダルビッシュ:2', '栗林良吏:2',
  '甲斐拓也:2', '近藤健介:2', '岡本和真:2', '戸郷翔征:2',

  // 野球用語
  'ホームラン:1.5', 'ヒット:1', 'ツーベース:1.5', 'スリーベース:1.5',
  'ストライク:1', 'ボール:1', 'アウト:1', 'セーフ:1',
  'フォアボール:1', 'デッドボール:1.5', '三振:1.5',
  'ダブルプレー:1.5', 'ゲッツー:1.5', 'エラー:1',
  'ファインプレー:1.5', '犠牲フライ:1.5', '盗塁:1.5',
  'ピッチャー:1', 'バッター:1', 'キャッチャー:1',
  'ストレート:1', 'フォーク:1', 'スライダー:1', 'カーブ:1', 'チェンジアップ:1',

  // WBC・大会用語
  'WBC:2', 'ワールドベースボールクラシック:2', '侍ジャパン:2',
  '決勝:1.5', '準決勝:1.5', '予選:1',

  // 実況・応援表現
  'ナイスバッティング:1', 'ナイスピッチング:1',
  'ナイスキャッチ:1', 'すごい:1', 'やばい:1'
];
```

## APIキー管理

- 保存先: `chrome.storage.local` キー名 `deepgramApiKey`
- ポップアップUI: Gemini APIキーの下に同様のセクションを追加
- 取得先URL: https://console.deepgram.com/
- 音声入力開始時に background.js が storage から読み出し、offscreen.js に転送

## メッセージ型定義

### content_script → background

| type | data | 説明 |
|------|------|------|
| `voiceStart` | `{ keywords: string[] }` | 音声入力開始要求 |
| `voiceStop` | - | 音声入力停止要求 |

### background → offscreen

| type | data | 説明 |
|------|------|------|
| `voiceStart` | `{ deepgramApiKey: string, keywords: string[] }` | マイク開始+Deepgram接続 |
| `voiceStop` | - | マイク停止+Deepgram切断 |

### offscreen → background → content_script (port経由)

| type | data | 説明 |
|------|------|------|
| `voiceTranscript` | `{ text: string, isFinal: boolean }` | 認識結果 |
| `voiceError` | `string` | エラーメッセージ |
| `voiceStatus` | `{ state: 'connecting' \| 'active' \| 'reconnecting' \| 'stopped' }` | 接続状態 |

## 将来の拡張仕様

### Silero VAD（クライアント側発話検知）

騒がしい環境（スタジアム歓声等）で Deepgram のエンドポイント判定が不正確な場合に導入。

**技術スタック:**
- `@ricky0123/vad-web` — Silero VAD のブラウザラッパー
- `onnxruntime-web` — ONNX モデル実行エンジン（WASM）
- モデルサイズ: 数MB、推論: 数ミリ秒（リアルタイム動作可能）

**offscreen.js 内での処理フロー:**

```
getUserMedia
  → AudioContext
  → Silero VAD (onnxruntime-web)
      ├─ onSpeechStart → Deepgram への送信をアクティブ化
      └─ onSpeechEnd   → Deepgram に確定シグナル送信
  → Deepgram WebSocket（VADがアクティブな区間のみ）
```

**チューニングパラメータ:**
```javascript
const vad = await MicVAD.new({
  onSpeechStart: () => { /* Deepgram送信開始 */ },
  onSpeechEnd: (audio) => { /* 確定トリガー */ },
  redemptionFrames: 8,            // 発話終了判定の猶予フレーム数
  positiveSpeechThreshold: 0.8,   // 発話検知の閾値（環境に応じて調整）
});
```

**検討事項:**
- CPU/メモリ消費: Netflix動画再生と同時実行のため低スペックPCで要検証
- 初期ロード: WASM + モデルファイルの読み込みで拡張起動がわずかに遅延
- 導入判断: Deepgram標準エンドポイントで問題が出てから

### Web Workers による音声処理オフロード

PCM変換・リサンプリング・VAD推論をメインスレッドから分離:

```
offscreen.js (メインスレッド)
  → getUserMedia
  → Worker (audio-processor.js)
      → PCM変換 (Float32→Int16)
      → [将来] Silero VAD 推論
      → postMessage(processedBuffer)
  → Deepgram WebSocket.send(buffer)
```

ScriptProcessorNode が十分な間は不要。Silero VAD 導入時に検討。
