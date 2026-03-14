# 音声入力モード — 実装計画

## 変更対象ファイル一覧

| ファイル | 変更種別 | 内容 |
|---------|---------|------|
| `manifest.json` | 修正 | host_permissions に Deepgram API ドメイン追加 |
| `src/popup.html` | 修正 | Deepgram APIキー入力セクション追加 |
| `src/popup.js` | 修正 | Deepgram APIキーの保存・読み込みロジック追加 |
| `src/offscreen.js` | 修正 | マイクキャプチャ + Deepgram WebSocket + PCM変換追加 |
| `src/background.js` | 修正 | offscreen理由更新、voiceメッセージルーティング追加 |
| `src/content_script.js` | 修正 | マイクボタンUI、キーワード定義、transcript受信・自動投稿 |
| `src/content_style.css` | 修正 | マイクボタン・録音中アニメーションのスタイル追加 |

## 実装ステップ

### Step 1: manifest.json — host_permissions 追加

**変更箇所:** `host_permissions` 配列

**追加内容:**
```json
"https://api.deepgram.com/*"
```

**理由:** offscreen.jsからDeepgram WebSocket (`wss://api.deepgram.com/...`) に接続するため。

---

### Step 2: popup.html + popup.js — APIキー設定UI

**popup.html 変更箇所:** Gemini APIキーセクション（L187-197）の後

**追加内容:**
- セクションラベル「Voice Settings」
- Deepgram APIキー入力フィールド (`#deepgram-api-key`)
- 保存ボタン (`#btn-save-dg-key`)
- ステータス表示 (`#dg-key-status`)
- Deepgram Console へのリンク

**popup.js 変更箇所:** Gemini APIキー処理（L65-90）の後

**追加内容:**
- `chrome.storage.local.get(['deepgramApiKey'])` で初期ロード
- 保存ボタンのクリックハンドラ: `chrome.storage.local.set({ deepgramApiKey })`
- 空値の場合は削除: `chrome.storage.local.remove('deepgramApiKey')`
- 保存成功/失敗のステータス表示

**既存のGemini APIキー処理と同一パターンで実装する。**

---

### Step 3: offscreen.js — コア音声処理（最重要・最複雑）

**変更箇所:** メッセージリスナー（L14-26）に `voiceStart` / `voiceStop` ハンドラ追加、
ファイル末尾に音声処理関数群を追加

#### 3a: グローバル変数追加

```javascript
let deepgramWs = null;
let audioContext = null;
let mediaStream = null;
let scriptProcessor = null;
let voiceReconnectCount = 0;
const VOICE_MAX_RECONNECT = 3;
```

#### 3b: メッセージハンドラ追加

既存のリスナー内に以下を追加:
```javascript
else if (msg.type === 'voiceStart') {
  startVoiceCapture(msg.data.deepgramApiKey, msg.data.keywords);
  sendResponse({ ok: true });
}
else if (msg.type === 'voiceStop') {
  stopVoiceCapture();
  sendResponse({ ok: true });
}
```

#### 3c: startVoiceCapture(apiKey, keywords) 関数

1. `navigator.mediaDevices.getUserMedia({ audio: true })` でマイク取得
2. `new AudioContext({ sampleRate: 16000 })` 作成
3. `audioContext.createMediaStreamSource(stream)` → `audioContext.createScriptProcessor(4096, 1, 1)` 接続
4. Deepgram WebSocket URL構築（パラメータ: token, language, model, smart_format, endpointing, keywords等）
5. WebSocket接続
6. `scriptProcessor.onaudioprocess` で Float32→Int16 変換 → `deepgramWs.send(buffer)`
7. `deepgramWs.onmessage` で結果パース → `chrome.runtime.sendMessage({ type: 'voiceTranscript', ... })`
8. エラーハンドリング:
   - `getUserMedia` 拒否 → `voiceError` 送信
   - WebSocket `onerror`/`onclose` → 自動再接続（3回まで）or `voiceError` 送信
9. `voiceStatus` で接続状態を通知

#### 3d: stopVoiceCapture() 関数

1. `deepgramWs.send(JSON.stringify({ type: "CloseStream" }))` — Deepgramプロトコルに従い正常終了
2. `mediaStream.getTracks().forEach(t => t.stop())` — マイク解放
3. `scriptProcessor.disconnect()` — 音声処理ノード切断
4. `audioContext.close()` — AudioContext解放
5. `deepgramWs.close()` — WebSocket切断
6. 全変数をnull化
7. `voiceStatus({ state: 'stopped' })` 送信

#### 3e: reconnectVoice() 関数

1. `voiceReconnectCount` をインクリメント
2. 3回超過 → `voiceError` 送信して終了
3. `voiceStatus({ state: 'reconnecting' })` 送信
4. 1秒待機後、Deepgram WebSocketのみ再接続（マイク・AudioContextは維持）

#### 3f: float32ToInt16(float32Array) ユーティリティ

Float32 PCM → Int16 PCM バッファ変換。

---

### Step 4: background.js — メッセージルーティング

#### 4a: offscreen理由の更新

**変更箇所:** `ensureOffscreen()` 関数（L14-19）

```javascript
// 変更前
reasons: ['WEB_RTC'],
// 変更後
reasons: ['WEB_RTC', 'USER_MEDIA'],
justification: 'ニコニコ生放送のWebSocket接続およびマイク入力のため'
```

#### 4b: メッセージハンドラ追加

**変更箇所:** メインメッセージリスナー（L130-253）に以下を追加

**voiceStart:**
1. `chrome.storage.local.get(['deepgramApiKey'])` でAPIキー取得
2. APIキーなし → contentPortsに `voiceError` 送信
3. APIキーあり → `ensureOffscreen()` 確認後、offscreenに `voiceStart` 転送（APIキー + keywords付き）

**voiceStop:**
- offscreenに `voiceStop` 転送

**voiceTranscript / voiceError / voiceStatus:**
- offscreenから受信 → contentPortsにブロードキャスト（既存の `postCommentResult` と同パターン）

---

### Step 5: content_script.js — UI + 自動投稿

#### 5a: WBCキーワード定数

**追加箇所:** ファイル先頭のグローバル変数エリア

`VOICE_KEYWORDS` 配列を定義（選手名・野球用語・大会用語・応援表現）。
詳細は仕様書参照。

#### 5b: マイクボタンUI

**変更箇所:** `createCommentInput()` 関数内、
AIボタン作成（L367-374）の前に挿入

- `#niko-jikkyo-mic-btn` ボタン要素を作成
- マイクアイコン（SVG）+ 「音声」テキスト
- `inputRow` に追加（input と AI ボタンの間）

**クリックハンドラ:**
```
voiceActive = false (初期値)

クリック時:
  voiceActive = !voiceActive
  if (voiceActive):
    chrome.runtime.sendMessage({ type: 'voiceStart', keywords: VOICE_KEYWORDS })
    ボタンをactive状態に切り替え（テキスト「停止」、赤色パルス）
    入力欄プレースホルダー: '音声認識中...'
  else:
    chrome.runtime.sendMessage({ type: 'voiceStop' })
    ボタンを通常状態に戻す
    入力欄プレースホルダー: 'コメントを入力（Enter で送信）'
```

**音声入力中も手動入力を許可する:**
- inputは `disabled` にしない
- ユーザーが手動でテキスト入力→Enterした場合は通常投稿（voiceのinterimは上書きされる）

#### 5c: voiceTranscript ハンドラ

**変更箇所:** `port.onMessage.addListener` 内（L686-861）に追加

```
msg.type === 'voiceTranscript':
  if (msg.data.isFinal && msg.data.text.trim()):
    → 既存の投稿ロジックと同じ:
      myPostedComments.add(text)
      data = { text, isAnonymous: true, color?, size?, position? }
      chrome.runtime.sendMessage({ type: 'postComment', data })
      input.value = ''
  else if (!msg.data.isFinal):
    → input.value = msg.data.text  (interimプレビュー)
```

#### 5d: voiceError / voiceStatus ハンドラ

```
msg.type === 'voiceError':
  voiceActive = false
  マイクボタンを通常状態に戻す
  input.placeholder = msg.data (エラーメッセージ)
  3秒後にプレースホルダーを元に戻す

msg.type === 'voiceStatus':
  msg.data.state === 'reconnecting':
    input.placeholder = '再接続中...'
  msg.data.state === 'active':
    input.placeholder = '音声認識中...'
```

---

### Step 6: content_style.css — スタイル追加

**変更箇所:** AIボタンスタイル（L210-230）の近くに追加

#### マイクボタン基本スタイル

```css
#niko-jikkyo-mic-btn {
  /* #niko-jikkyo-ai-btn と同じベーススタイル */
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 8px 14px;
  border: 1px solid rgba(34, 211, 238, 0.4);
  border-radius: 100px;
  background: rgba(15, 23, 42, 0.9);
  color: #94A3B8;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  backdrop-filter: blur(12px);
  white-space: nowrap;
  transition: background 0.2s;
}
```

#### 録音中のアクティブスタイル

```css
#niko-jikkyo-mic-btn.active {
  background: rgba(233, 69, 96, 0.7);
  color: #fff;
  border-color: #E94560;
  animation: niko-mic-pulse 1.5s ease-in-out infinite;
}

@keyframes niko-mic-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(233, 69, 96, 0.4); }
  50% { box-shadow: 0 0 0 6px rgba(233, 69, 96, 0); }
}
```

---

## テスト計画

### 手動テスト項目

| # | テスト内容 | 確認ポイント |
|---|-----------|------------|
| 1 | ポップアップでDeepgram APIキーを保存 | storage に保存される、再表示で復元される |
| 2 | APIキー未設定でマイクボタン押下 | エラーメッセージが表示される |
| 3 | マイクボタン押下→ブラウザのマイク許可 | マイクアクセス許可ダイアログが表示される |
| 4 | マイク許可拒否 | エラー表示、音声モード解除 |
| 5 | 正常に音声認識開始 | ボタンが赤パルス、プレースホルダーが「音声認識中...」 |
| 6 | 発話中にinterim結果が表示される | 入力欄にリアルタイムテキスト表示 |
| 7 | 発話停止（800ms無音）→自動投稿 | コメントが投稿され、画面上に流れる |
| 8 | 連続発話→連続投稿 | 各発話が個別のコメントとして投稿される |
| 9 | 音声入力中に手動テキスト入力→Enter | 手動テキストが投稿される |
| 10 | マイクボタン再押下で停止 | マイク解放、ボタン通常状態に戻る |
| 11 | 選手名を発話 | 「大谷翔平」等がkeywordsブーストにより正しく変換される |
| 12 | Chromeタブ切り替え→戻る | 音声認識が継続している |
| 13 | 他アプリにフォーカス移動→戻る | 音声認識が継続している |
| 14 | ネットワーク切断シミュレーション | 再接続が試みられ、3回失敗でエラー表示 |
| 15 | 空発話・無音のみ | コメントが投稿されない |

---

## 実装順序とチェックポイント

```
Step 1: manifest.json
  └─ ✓チェック: 拡張がエラーなくロードされる

Step 2: popup.html + popup.js
  └─ ✓チェック: APIキーの保存・復元・削除が動作する

Step 3: offscreen.js
  └─ ✓チェック: コンソールでマイク音声がPCMバッファとして取得できる
  └─ ✓チェック: Deepgram WebSocketに接続し、transcript が返ってくる
  └─ ✓チェック: stopで全リソースが解放される

Step 4: background.js
  └─ ✓チェック: voiceStart → offscreenにAPIキー付きで転送される
  └─ ✓チェック: voiceTranscript → contentPortsに配信される

Step 5: content_script.js + content_style.css
  └─ ✓チェック: マイクボタンが表示され、クリックで音声認識が開始される
  └─ ✓チェック: interim結果が入力欄に表示される
  └─ ✓チェック: speech_final でコメントが自動投稿される
  └─ ✓チェック: smart_format により「さんたいに」が「3対2」等に整形される
  └─ ✓チェック: 停止でリソース解放、UI復帰
```

## 設計判断メモ

### キーワードUI

ポップアップにキーワードを**読み取り専用のタグ表示**で表示する。
ユーザーによる手動編集は今回のスコープ外。

理由:
- 初期実装ではキーワードはコード内プリセット
- 次回開発で「試合情報 → AI自動サジェスト」機能を追加予定
- 手動でブースト値を入力させるUXは現時点で不適切

### Smart Format

Deepgramの `smart_format=true` を有効にする。
野球実況では「3対2」「1回の表」「150キロ」等の数値表現が頻出するため、
音声認識結果を自動整形することでコメントの可読性が大幅に向上する。

### Silero VAD（将来対応）

初期実装ではDeepgram標準のendpointing（800ms無音検知）で運用する。
WBC実況テスト後、歓声によるエンドポイント誤判定が問題になった場合に
Silero VAD（`@ricky0123/vad-web`）を offscreen.js に導入する。

導入時の追加変更:
- `onnxruntime-web` + Silero VADモデルをバンドル
- offscreen.js にVAD初期化・発話開始/終了コールバック追加
- Deepgramへの送信をVADのアクティブ区間に限定
- 必要に応じてWeb Workerに音声処理をオフロード
