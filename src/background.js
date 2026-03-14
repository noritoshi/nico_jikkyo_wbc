// background.js — Service Worker: ニコニコAPIへの接続管理とコメント転送

const DEBUG = true; // デバッグログの有効/無効（リリース時はfalseに戻す）
function debugLog(...args) { if (DEBUG) console.log(...args); }

let currentStatus = 'disconnected';

// offscreenドキュメントの作成
async function ensureOffscreen() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'src/offscreen.html',
    reasons: ['WEB_RTC', 'USER_MEDIA'],
    justification: 'ニコニコ生放送のWebSocket接続およびマイク入力のため'
  });
}

// ニコニコ生放送ページからWebSocket URLを取得
async function fetchWatchData(channelId) {
  const url = `https://live.nicovideo.jp/watch/${channelId}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);

  const html = await res.text();

  // embedded-dataからJSONを取り出す
  const match = html.match(/data-props="([^"]+)"/);
  if (!match) throw new Error('embedded-data not found in page');

  const decoded = match[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  const data = JSON.parse(decoded);
  debugLog('[bg] Parsed embedded data keys:', Object.keys(data));

  // WebSocket URLを探す
  const wsUrl = data.site?.relive?.webSocketUrl
    || data.program?.supplier?.websocketUrl
    || data.site?.websocketUrl;

  const broadcastId = data.program?.nicoliveProgramId
    || data.program?.broadcastId;

  if (!wsUrl) throw new Error('WebSocket URL not found in embedded data');

  const isPremium = data.user?.accountType === 'premium'
    || data.user?.isPremium === true
    || (data.user?.premiumOrigin !== null && data.user?.premiumOrigin !== undefined && data.user?.premiumOrigin !== '0' && data.user?.premiumOrigin !== 0);
  debugLog('[bg] User info:', JSON.stringify(data.user));

  return { wsUrl, broadcastId, title: data.program?.title || channelId, isPremium };
}

// Netflixタブにcontent_scriptを注入（まだ注入されていない場合）
async function ensureContentScript() {
  const tabs = await chrome.tabs.query({ url: 'https://www.netflix.com/*' });
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/content_script.js']
      });
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['src/content_style.css']
      });
    } catch (e) {
      debugLog('[bg] Script injection skipped for tab', tab.id, e.message);
    }
  }
}

// 接続開始
async function connect(channelId) {
  try {
    debugLog('[bg] Fetching watch data for:', channelId);
    const watchData = await fetchWatchData(channelId);
    debugLog('[bg] Watch data:', JSON.stringify(watchData));

    await ensureContentScript();
    await ensureOffscreen();

    chrome.runtime.sendMessage({
      type: 'connect',
      data: watchData
    }).catch(() => {});

    // content_scriptにプレミアム情報を通知
    for (const port of contentPorts) {
      try { port.postMessage({ type: 'premiumStatus', isPremium: watchData.isPremium }); } catch (e) {}
    }

    // 接続情報を保存
    await chrome.storage.local.set({
      lastChannel: channelId,
      programTitle: watchData.title,
      isPremium: watchData.isPremium
    });
  } catch (err) {
    console.error('Connection failed:', err);
    currentStatus = 'error';
    broadcastStatus('error', err.message);
  }
}

// 切断
function disconnect() {
  chrome.runtime.sendMessage({ type: 'disconnect' }).catch(() => {});
}

// ステータスをpopupとcontent_scriptに通知
function broadcastStatus(status, errorMsg) {
  currentStatus = status;
  // popupへ
  chrome.runtime.sendMessage({
    type: 'statusUpdate',
    data: { status, error: errorMsg }
  }).catch(() => {});
}

// メッセージハンドラ
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // popupからの接続要求
  if (msg.type === 'popup_connect') {
    connect(msg.channelId);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'popup_disconnect') {
    disconnect();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'popup_getStatus') {
    sendResponse({ status: currentStatus });
    return true;
  }

  // AI生成キャンセル
  if (msg.type === 'cancelAiComment') {
    if (geminiAbortController) geminiAbortController.abort();
    return;
  }

  // AI コメント生成リクエスト
  if (msg.type === 'generateAiComment') {
    callGeminiApi(msg.data).then((result) => {
      // リクエスト元のport（content_script）に返す
      for (const port of contentPorts) {
        try { port.postMessage({ type: 'aiCommentResult', data: result }); } catch (e) {}
      }
    });
    return;
  }

  // offscreenからのログ転送
  if (msg.type === 'log') {
    debugLog(msg.data);
    return;
  }

  // offscreenからのステータス更新
  if (msg.type === 'status') {
    currentStatus = msg.data;
    chrome.runtime.sendMessage({
      type: 'statusUpdate',
      data: { status: msg.data }
    }).catch(() => {});
    return;
  }

  // offscreenからの投稿結果 → content_scriptに転送
  if (msg.type === 'postCommentResult') {
    for (const port of contentPorts) {
      try { port.postMessage({ type: 'postCommentResult', data: msg.data }); } catch (e) {}
    }
    return;
  }

  // offscreenからのコメント受信 → content_scriptに転送（port経由）+ ログ蓄積
  if (msg.type === 'comment') {
    // コメントログに蓄積（概要機能用、translucent=低レピュテーションは除外）
    const mail = msg.data.mail || '';
    if (!mail.includes('translucent')) {
      commentLog.push({ text: msg.data.text, mail, userId: msg.data.userId, time: Date.now() });
    }
    recordCommentBucket();
    pruneCommentLog();
    // content_scriptへの転送はtext,mailのみ（既存の描画に影響なし）
    for (const port of contentPorts) {
      try { port.postMessage({ text: msg.data.text, mail: msg.data.mail }); } catch (e) {}
    }
    return;
  }

  // 概要の自動更新ON/OFF
  if (msg.type === 'toggleAutoSummary') {
    if (msg.enabled) {
      startAutoSummary();
    } else {
      stopAutoSummary();
    }
    return;
  }

  // 概要の手動取得
  if (msg.type === 'generateSummary') {
    generateSummary().then((result) => {
      for (const port of contentPorts) {
        try { port.postMessage({ type: 'summaryResult', data: result }); } catch (e) {}
      }
    });
    return;
  }

  // 概要履歴リクエスト（グラフホバー用）
  if (msg.type === 'getSummaryHistory') {
    for (const port of contentPorts) {
      try { port.postMessage({ type: 'summaryHistoryResult', data: summaryHistory }); } catch (e) {}
    }
    return;
  }

  // コメントグラフデータリクエスト
  if (msg.type === 'getCommentGraph') {
    const points = getGraphData();
    const total = points.reduce((a, b) => a + b, 0);
    console.log('[bg] getCommentGraph: buckets=' + commentBuckets.length + ' total=' + total);
    for (const port of contentPorts) {
      try { port.postMessage({ type: 'commentGraphResult', data: points }); } catch (e) {}
    }
    return;
  }

  // ユーザー一覧リクエスト
  if (msg.type === 'getUserList') {
    const userList = buildUserList();
    for (const port of contentPorts) {
      try { port.postMessage({ type: 'userListResult', data: userList }); } catch (e) {}
    }
    return;
  }

});
  // 音声入力は content_script から直接 Deepgram WebSocket に接続（background不要）

// Gemini API呼び出し
let geminiAbortController = null;

async function callGeminiApi(data) {
  const result = await chrome.storage.local.get(['geminiApiKey']);
  const apiKey = result.geminiApiKey;
  if (!apiKey) {
    return { error: 'API Keyが設定されていません。ポップアップで設定してください。' };
  }

  const systemPrompts = {
    normal: `あなたはニコニコ生放送の実況コメントを生成するアシスタントです。

現在の番組の直近のコメント:
{recentComments}

ユーザーの依頼: {userPrompt}

以下のルールに従ってコメントを1つ生成してください:
- 最大75文字
- ニコニコ生放送の実況らしい自然な口調
- 絵文字は使わない
- コメント本文のみを返してください（説明不要）`,

    webSearch: `あなたはニコニコ生放送の実況コメントを生成するアシスタントです。
Google検索で最新情報を調べて、それに基づいたコメントを生成してください。

現在の番組の直近のコメント:
{recentComments}

ユーザーの依頼: {userPrompt}

手順:
1. まずユーザーの依頼に関連する最新情報をWeb検索で調べる
2. 検索結果から得た事実に基づいてコメントを生成する

以下のルールに従ってコメントを1つ生成してください:
- 最大75文字
- ニコニコ生放送の実況らしい自然な口調
- 絵文字は使わない
- 検索で得た具体的な情報（スコア、選手名、出来事など）を盛り込む
- コメント本文のみを返してください（説明不要、検索結果の引用不要、[cite]タグ不要）`,

    shitaCA: `あなたはニコニコ生放送で愛される「コメントアート（CA）職人」です。
視聴者が一体感を感じるような、見栄えの良いテキストアートを作成してください。

■ ルール:
- 構成: 4〜6行（画面下部で最も見栄えが良い段数）
- 横幅: 各行最大75文字（全角35文字程度が安全）
- 禁止: 全角スペースのみの行は絶対に作らない。必ず何らかの記号や文字を含めること
- 出力: 説明・番号・「shita」等のコマンドは一切不要。テキストアート本体のみを出力

■ 使える文字（推奨順）:
1. 罫線素片（枠作りに最適、環境差が少ない）: ╔═╗║╚╝╠╣╦╩ ┌─┐│└┘┏━┓┃┗┛
2. ブロック要素（背景埋め、グラデーション）: █▓░▄▀
3. 幾何学記号（アクセント）: ★☆■□◆◇●○▲▼
4. カラー絵文字（⚾🏆など）は幅が環境依存でズレやすいため、使わないこと

■ デザイン指針:
- 罫線素片で枠を作り、テレビのテロップのような整った見た目にする
- 各行の横幅（文字数）を揃えて整ったシルエットにする
- 二重線枠（╔═╗）はテロップ感・高級感が出るのでおすすめ
- ブロック要素（█▓░）は枠内の背景や装飾に使う

■ 良い例:
╔════════════════╗
║★　侍ジャパン優勝！　★║
║　　おめでとう！！　　　║
╚════════════════╝

■ 悪い例（全角スペースだけの行がある）:

★☆★ 侍ジャパン ★☆★


ユーザーの依頼: {userPrompt}

テキストアートのみを出力:`
  };

  const template = systemPrompts[data.mode] || systemPrompts.normal;
  const prompt = template
    .replace('{userPrompt}', data.userPrompt || '')
    .replace('{recentComments}', data.recentComments || '（なし）');

  const parts = [{ text: prompt }];

  try {
    geminiAbortController = new AbortController();
    // モデル選択: shitaCA=thinking model, webSearch=flash+検索, 通常=lite
    const isShitaCA = data.mode === 'shitaCA';
    const isWebSearch = data.mode === 'webSearch';
    const model = isShitaCA ? 'gemini-2.5-flash'
      : isWebSearch ? 'gemini-2.5-flash'
      : 'gemini-3.1-flash-lite-preview';
    const genConfig = {};
    if (isShitaCA) {
      genConfig.maxOutputTokens = 16384;
      genConfig.temperature = 0.2;
      genConfig.thinkingConfig = { thinkingBudget: 4096 };
    } else if (isWebSearch) {
      genConfig.maxOutputTokens = 1024;
    } else {
      genConfig.maxOutputTokens = 1024;
    }
    const requestBody = {
      contents: [{ parts }],
      generationConfig: genConfig,
    };
    // Web検索モード: Google Search Groundingを有効化
    if (isWebSearch) {
      requestBody.tools = [{ googleSearch: {} }];
    }
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    // API呼び出し（500エラーor空出力で最大2回リトライ）
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: geminiAbortController.signal
      });

      if (res.status === 500) {
        if (attempt < 2) { await new Promise(r => setTimeout(r, 1000)); continue; }
        return { error: 'API サーバーエラーが続いています。しばらく待ってから再試行してください。' };
      }

      if (!res.ok) {
        const errText = await res.text();
        return { error: `API エラー (${res.status}): ${errText.substring(0, 100)}` };
      }

      const json = await res.json();
      // thinking modelはparts内に{thought:true}のパートと実際の出力パートがある
      const resParts = json.candidates?.[0]?.content?.parts || [];
      // 重複partsを除去してからテキスト結合
      const textParts = resParts.filter(p => !p.thought).map(p => p.text);
      const uniqueParts = textParts.filter((t, i) => i === 0 || t !== textParts[i - 1]);
      let text = uniqueParts.join('');
      // citation タグを除去 (例: [cite: 1, 2], [1], [2, 3])
      text = text.replace(/\s*\[cite:[^\]]*\]?/g, '').replace(/\s*\[\d+(?:,\s*\d+)*\]/g, '');

      // コードブロック(```)で囲まれている場合は中身だけ抽出
      const codeBlockMatch = text.match(/```[\s\S]*?\n([\s\S]*?)```/);
      if (codeBlockMatch) text = codeBlockMatch[1];
      text = text.trim();

      // 全角スペース・罫線のみで中身がない出力を検知してリトライ
      // eslint-disable-next-line no-irregular-whitespace
      const contentChars = text.replace(/[\s　╔═╗║╚╝╠╣╦╩┌─┐│└┘┏━┓┃┗┛]/g, '');
      if (!contentChars && attempt < 2) {
        debugLog('[bg] Empty CA output, retrying...', attempt);
        genConfig.temperature = Math.min((genConfig.temperature || 0.3) + 0.2, 1.0);
        requestBody.generationConfig = genConfig;
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      if (!text) {
        return { error: '生成結果が空でした' };
      }
      return { text };
    }
    return { error: '生成に失敗しました。再試行してください。' };
  } catch (e) {
    if (e.name === 'AbortError') {
      return { cancelled: true };
    }
    return { error: `通信エラー: ${e.message}` };
  } finally {
    geminiAbortController = null;
  }
}

// コメントログ（概要機能用：直近5分間、最大500件）
const commentLog = [];
const COMMENT_LOG_MAX_AGE = 5 * 60 * 1000; // 5分
const COMMENT_LOG_MAX_COUNT = 500;

function pruneCommentLog() {
  const cutoff = Date.now() - COMMENT_LOG_MAX_AGE;
  while (commentLog.length > 0 && commentLog[0].time < cutoff) {
    commentLog.shift();
  }
  while (commentLog.length > COMMENT_LOG_MAX_COUNT) {
    commentLog.shift();
  }
}

// コメント頻度ヒストグラム（グラフ用：10秒バケット×60=10分間）
const GRAPH_BUCKET_SEC = 10;
const GRAPH_BUCKET_COUNT = 60; // 10分間
const commentBuckets = []; // [{time, count}]

function recordCommentBucket() {
  const now = Math.floor(Date.now() / 1000 / GRAPH_BUCKET_SEC) * GRAPH_BUCKET_SEC * 1000;
  if (commentBuckets.length > 0 && commentBuckets[commentBuckets.length - 1].time === now) {
    commentBuckets[commentBuckets.length - 1].count++;
  } else {
    commentBuckets.push({ time: now, count: 1 });
  }
  // 古いバケットを削除
  const cutoff = now - GRAPH_BUCKET_COUNT * GRAPH_BUCKET_SEC * 1000;
  while (commentBuckets.length > 0 && commentBuckets[0].time < cutoff) {
    commentBuckets.shift();
  }
}

function getGraphData() {
  const now = Math.floor(Date.now() / 1000 / GRAPH_BUCKET_SEC) * GRAPH_BUCKET_SEC * 1000;
  const bucketMap = new Map();
  for (const b of commentBuckets) {
    bucketMap.set(b.time, b.count);
  }
  const points = [];
  for (let i = GRAPH_BUCKET_COUNT - 1; i >= 0; i--) {
    const t = now - i * GRAPH_BUCKET_SEC * 1000;
    points.push(bucketMap.get(t) || 0);
  }
  return points; // 60個の数値配列（古い→新しい）
}

// ユーザー傾向キャッシュ（概要生成時にGeminiが分析した結果）
let userTendencyCache = {};

// 概要生成
let summaryAbortController = null;

async function generateSummary() {
  const result = await chrome.storage.local.get(['geminiApiKey']);
  const apiKey = result.geminiApiKey;
  if (!apiKey) {
    return { error: 'API Keyが設定されていません。ポップアップで設定してください。' };
  }

  pruneCommentLog();
  if (commentLog.length < 5) {
    return { error: 'コメントが少なすぎます（最低5件必要）。しばらく待ってから再試行してください。' };
  }

  // コメントをフォーマット（相対時刻 + ユーザーID短縮 + テキスト）
  const now = Date.now();
  const formatted = commentLog.map(c => {
    const agoSec = Math.round((now - c.time) / 1000);
    const agoStr = agoSec >= 60 ? `${Math.floor(agoSec / 60)}分${agoSec % 60}秒前` : `${agoSec}秒前`;
    const uid = c.userId ? c.userId.replace('a:', '') : '???';
    return `[${agoStr}] ${uid}: ${c.text}`;
  }).join('\n');

  const elapsedMin = Math.round((now - commentLog[0].time) / 60000);
  const prompt = `あなたはニコニコ生放送のコメント分析アシスタントです。

以下は直近${elapsedMin || 1}分間のコメントログです（${commentLog.length}件）。
形式: [相対時刻] ユーザーID: コメント本文

${formatted}

以下の形式で分析結果を日本語で出力してください:

## 場の雰囲気
全体の盛り上がり度合い、主な話題、場の空気を2-3文で簡潔に。「直近○分間では」等の時間への言及は不要。

## 話題のトピック
箇条書きで主な話題を3-5個（各1行で簡潔に）

最後に、コメント数上位20名のみ、以下のJSON形式で傾向を出力してください。
JSONブロックは必ず \`\`\`json と \`\`\` で囲んでください。20名を超えないこと。

\`\`\`json
{"ユーザーID": "傾向5文字以内", "ユーザーID2": "傾向5文字以内"}
\`\`\`

傾向は以下の固定カテゴリから1つ選んでください:
"解説"=試合展開・戦術を説明, "ツッコミ"=面白がる・突っ込む, "応援"=特定チーム/選手を応援, "悲嘆"=嘆き・絶望, "盛り上げ"=草・www系, "予想"=展開・スコア予想, "雑談"=試合外の話題
注意: 説明や前置きは不要。上記フォーマットのみ出力してください。`;

  try {
    summaryAbortController = new AbortController();
    const model = 'gemini-2.5-flash';
    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingBudget: 2048 },
      },
    };
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: summaryAbortController.signal
    });

    if (!res.ok) {
      const errText = await res.text();
      return { error: `API エラー (${res.status}): ${errText.substring(0, 100)}` };
    }

    const json = await res.json();
    const resParts = json.candidates?.[0]?.content?.parts || [];
    let text = resParts.filter(p => !p.thought).map(p => p.text).join('');
    text = text.trim();

    if (!text) {
      return { error: '分析結果が空でした' };
    }

    // JSONブロックからユーザー傾向を抽出してキャッシュ
    const jsonMatch = text.match(/```json\s*\n?([\s\S]*?)```/);
    if (jsonMatch) {
      let jsonStr = jsonMatch[1].trim();
      // MAX_TOKENSで切れた不完全なJSONを修復（末尾の不完全エントリを削除して閉じる）
      if (!jsonStr.endsWith('}')) {
        const lastComplete = jsonStr.lastIndexOf('"');
        const lastComma = jsonStr.lastIndexOf(',', lastComplete);
        if (lastComma > 0) {
          jsonStr = jsonStr.substring(0, lastComma) + '}';
        }
      }
      try {
        const tendencies = JSON.parse(jsonStr);
        userTendencyCache = tendencies;
        debugLog('[bg] User tendencies cached:', Object.keys(tendencies).length, 'users');
      } catch (e) {
        debugLog('[bg] Failed to parse user tendencies JSON:', e.message);
      }
      // 概要テキストからJSONブロックを除去（表示用）
      text = text.replace(/```json[\s\S]*?```/, '').trim();
    }
    // MAX_TOKENSで```が閉じなかった場合もJSONを除去
    text = text.replace(/```json[\s\S]*$/, '').trim();

    // 「場の雰囲気」セクションだけ抽出して履歴に保存
    const moodMatch = text.match(/##\s*場の雰囲気\s*\n([\s\S]*?)(?=\n##|\n```|$)/);
    if (moodMatch) {
      addSummaryHistory(moodMatch[1].trim());
    }
    return { text, commentCount: commentLog.length };
  } catch (e) {
    if (e.name === 'AbortError') {
      return { cancelled: true };
    }
    return { error: `通信エラー: ${e.message}` };
  } finally {
    summaryAbortController = null;
  }
}

// 概要履歴（タイムスタンプ付き、グラフホバー用）
const summaryHistory = []; // [{time, text}]
const SUMMARY_HISTORY_MAX = 20;

function addSummaryHistory(text) {
  summaryHistory.push({ time: Date.now(), text });
  while (summaryHistory.length > SUMMARY_HISTORY_MAX) summaryHistory.shift();
}

// 概要の自動更新タイマー（3分間隔）
const AUTO_SUMMARY_INTERVAL = 3 * 60 * 1000; // 3分
let autoSummaryTimer = null;
let autoSummaryEnabled = false;

function startAutoSummary() {
  if (autoSummaryTimer) return;
  autoSummaryEnabled = true;
  // 初回は即座に実行
  runAutoSummary();
  autoSummaryTimer = setInterval(runAutoSummary, AUTO_SUMMARY_INTERVAL);
  debugLog('[bg] Auto-summary started (interval: 3min)');
}

function stopAutoSummary() {
  autoSummaryEnabled = false;
  if (autoSummaryTimer) {
    clearInterval(autoSummaryTimer);
    autoSummaryTimer = null;
  }
  if (summaryAbortController) summaryAbortController.abort();
  debugLog('[bg] Auto-summary stopped');
}

async function runAutoSummary() {
  if (!autoSummaryEnabled) return;
  // 生成中なら前回をキャンセルして再実行
  if (summaryAbortController) summaryAbortController.abort();

  // まずステータスを送信
  for (const port of contentPorts) {
    try { port.postMessage({ type: 'summaryStatus', data: 'generating' }); } catch (e) {}
  }

  const result = await generateSummary();
  if (result.cancelled) return; // 自動更新OFF等でキャンセルされた場合
  for (const port of contentPorts) {
    try { port.postMessage({ type: 'summaryResult', data: result }); } catch (e) {}
  }
}

// ユーザー一覧を構築（コメントログから集計 + AI傾向キャッシュをマージ）
function buildUserList() {
  pruneCommentLog();
  const userMap = new Map();
  for (const c of commentLog) {
    const uid = c.userId || '???';
    if (!userMap.has(uid)) {
      userMap.set(uid, { userId: uid, count: 0, firstTime: c.time, lastTime: c.time, comments: [] });
    }
    const u = userMap.get(uid);
    u.count++;
    u.lastTime = c.time;
    u.comments.push(c.text);
  }
  // コメント数降順でソート
  const users = Array.from(userMap.values()).sort((a, b) => b.count - a.count);
  // AI傾向キャッシュをマージ
  for (const u of users) {
    const shortId = u.userId.replace('a:', '');
    u.tendency = userTendencyCache[shortId] || null;
  }
  return { users, totalComments: commentLog.length };
}

// content_scriptからのport接続を管理（tabs権限不要）
const contentPorts = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'niko-jikkyo') {
    contentPorts.add(port);
    port.onDisconnect.addListener(() => contentPorts.delete(port));
  }
});
