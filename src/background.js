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
    // モデル選択: shitaCA=thinking model, 通常=lite
    const isShitaCA = data.mode === 'shitaCA';
    const model = isShitaCA ? 'gemini-2.5-flash' : 'gemini-3.1-flash-lite-preview';
    const genConfig = {};
    if (isShitaCA) {
      genConfig.maxOutputTokens = 16384;
      genConfig.temperature = 0.2;
      genConfig.thinkingConfig = { thinkingBudget: 4096 };
    } else {
      genConfig.maxOutputTokens = 1024;
    }
    const requestBody = {
      contents: [{ parts }],
      generationConfig: genConfig,
    };
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
      let text = resParts.filter(p => !p.thought).map(p => p.text).join('');

      // コードブロック(```)で囲まれている場合は中身だけ抽出
      const codeBlockMatch = text.match(/```[\s\S]*?\n([\s\S]*?)```/);
      if (codeBlockMatch) text = codeBlockMatch[1];
      text = text.trim();

      // 全角スペース・罫線のみで中身がない出力を検知してリトライ
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

// content_scriptからのport接続を管理（tabs権限不要）
const contentPorts = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'niko-jikkyo') {
    contentPorts.add(port);
    port.onDisconnect.addListener(() => contentPorts.delete(port));
  }
});
