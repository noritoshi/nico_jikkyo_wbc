// background.js — Service Worker: ニコニコAPIへの接続管理とコメント転送

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
  console.log('[bg] Parsed embedded data keys:', Object.keys(data));
  console.log('[bg] data.site:', JSON.stringify(data.site, null, 2)?.substring(0, 500));
  console.log('[bg] data.program:', JSON.stringify(data.program, null, 2)?.substring(0, 500));

  // WebSocket URLを探す
  const wsUrl = data.site?.relive?.webSocketUrl
    || data.program?.supplier?.websocketUrl
    || data.site?.websocketUrl;

  const broadcastId = data.program?.nicoliveProgramId
    || data.program?.broadcastId;

  if (!wsUrl) throw new Error('WebSocket URL not found in embedded data');

  return { wsUrl, broadcastId, title: data.program?.title || channelId };
}

// 接続開始
async function connect(channelId) {
  try {
    console.log('[bg] Fetching watch data for:', channelId);
    const watchData = await fetchWatchData(channelId);
    console.log('[bg] Watch data:', JSON.stringify(watchData, null, 2));

    console.log('[bg] Creating offscreen document...');
    await ensureOffscreen();
    console.log('[bg] Offscreen ready, sending connect message');

    chrome.runtime.sendMessage({
      type: 'connect',
      data: watchData
    });

    // 接続情報を保存
    await chrome.storage.local.set({
      lastChannel: channelId,
      programTitle: watchData.title
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

  // offscreenからのログ転送
  if (msg.type === 'log') {
    console.log(msg.data);
    return;
  }

  // offscreenからのステータス更新
  if (msg.type === 'status') {
    currentStatus = msg.data;
    // popupに転送
    chrome.runtime.sendMessage({
      type: 'statusUpdate',
      data: { status: msg.data }
    }).catch(() => {});
    return;
  }

  // offscreenからのコメント受信 → content_scriptに転送
  if (msg.type === 'comment') {
    chrome.tabs.query({}, (tabs) => {
      console.log('[bg] All tabs:', tabs.map(t => t.url?.substring(0, 50)));
      const netflixTabs = tabs.filter(t => t.url?.startsWith('https://www.netflix.com'));
      console.log('[bg] Netflix tabs found:', netflixTabs.length);
      for (const tab of netflixTabs) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'comment',
          data: msg.data
        }).catch(err => console.log('[bg] sendMessage error:', err.message));
      }
    });
    return;
  }
});
