// background.js — Service Worker: ニコニコAPIへの接続管理とコメント転送

const DEBUG = false; // デバッグログの有効/無効
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
    reasons: ['WEB_RTC'],
    justification: 'ニコニコ生放送のWebSocket接続を維持するため'
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
    || (data.user?.premiumOrigin != null && data.user?.premiumOrigin !== '0' && data.user?.premiumOrigin !== 0);
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
    });

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
  chrome.runtime.sendMessage({ type: 'disconnect' });
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

  // offscreenからのコメント受信 → content_scriptに転送（port経由）
  if (msg.type === 'comment') {
    for (const port of contentPorts) {
      try { port.postMessage(msg.data); } catch (e) {}
    }
    return;
  }
});

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

    shitaCA: `あなたはニコニコ生放送のテキストアート職人です。
アスキーアート（AA）を作成してください。

ルール:
- 各行がニコニコのコメントとして1行ずつ投稿される
- 3〜8行で作成
- 各行は最大75文字
- 全角スペースだけの行は禁止。各行に必ず文字や記号を含めること
- 「shita」等のコマンドは含めない
- 説明・番号は一切不要
- 記号（★●▲▼■□◆◇○△▽☆♪♡／＼｜＿）を活用

良い例:
　　＿＿＿＿＿
　／　⚾ WBC　＼
｜　日本優勝！　｜
　＼＿＿＿＿＿／

悪い例（全角スペースだけの行がある）:

★☆★ 侍ジャパン ★☆★


ユーザーの依頼: {userPrompt}

テキストアートのみを出力:`
  };

  const template = systemPrompts[data.mode] || systemPrompts.normal;
  const prompt = template
    .replace('{userPrompt}', data.userPrompt)
    .replace('{recentComments}', data.recentComments || '（なし）');

  try {
    geminiAbortController = new AbortController();
    // コメントアートは賢いモデルを使う
    const model = data.mode === 'shitaCA' ? 'gemini-2.5-flash' : 'gemini-3.1-flash-lite-preview';
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: data.mode === 'shitaCA' ? 8192 : 1024 },
        }),
        signal: geminiAbortController.signal
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      return { error: `API エラー (${res.status}): ${errText.substring(0, 100)}` };
    }

    const json = await res.json();
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return { error: '生成結果が空でした' };
    }
    return { text: text.trim() };
  } catch (e) {
    if (e.name === 'AbortError') {
      return { cancelled: true };
    }
    return { error: `通信エラー: ${e.message}` };
  } finally {
    geminiAbortController = null;
  }
}

// content_scriptからのport接続を管理（tabs権限不要）
const contentPorts = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'niko-jikkyo') {
    contentPorts.add(port);
    port.onDisconnect.addListener(() => contentPorts.delete(port));
  }
});
