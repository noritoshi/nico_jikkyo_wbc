// offscreen.js — WebSocket接続をService Worker外で維持するためのオフスクリーンドキュメント

// ログをbackgroundに転送（Service WorkerのDevToolsで見えるようにする）
function log(...args) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  chrome.runtime.sendMessage({ type: 'log', data: msg }).catch(() => {});
}

let watchWs = null;
let commentPoller = null; // AbortController for comment polling

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'connect') {
    startConnection(msg.data);
    sendResponse({ ok: true });
  } else if (msg.type === 'disconnect') {
    closeAll();
    sendResponse({ ok: true });
  }
  return true;
});

function closeAll() {
  if (commentPoller) {
    commentPoller.abort();
    commentPoller = null;
  }
  if (watchWs) {
    watchWs.close();
    watchWs = null;
  }
  chrome.runtime.sendMessage({ type: 'status', data: 'disconnected' });
}

async function startConnection({ wsUrl, broadcastId }) {
  chrome.runtime.sendMessage({ type: 'status', data: 'connecting' });

  watchWs = new WebSocket(wsUrl);

  watchWs.onopen = () => {
    log('[offscreen] Watch WS connected, sending startWatching');
    watchWs.send(JSON.stringify({
      type: 'startWatching',
      data: {
        stream: {
          quality: 'abr',
          protocol: 'hls+fmp4',
          latency: 'low',
          chasePlay: false
        },
        room: {
          protocol: 'webSocket',
          commentable: true
        },
        reconnect: false
      }
    }));
  };

  watchWs.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'ping') {
      watchWs.send(JSON.stringify({ type: 'pong' }));
      watchWs.send(JSON.stringify({ type: 'keepSeat' }));
      return;
    }

    if (msg.type !== 'ping' && msg.type !== 'statistics') {
      log('[offscreen] WS msg:', msg.type);
    }

    // 新API: messageServer with viewUri (HTTP streaming)
    if (msg.type === 'messageServer') {
      log('[offscreen] messageServer received, viewUri:', msg.data.viewUri);
      startCommentPolling(msg.data.viewUri, msg.data.hashedUserId);
    }
  };

  watchWs.onerror = (err) => {
    log('[offscreen] Watch WS error');
    chrome.runtime.sendMessage({ type: 'status', data: 'error' });
  };

  watchWs.onclose = () => {
    log('[offscreen] Watch WS closed');
    chrome.runtime.sendMessage({ type: 'status', data: 'disconnected' });
  };
}

// 新API: viewUri からコメントをストリーミング取得
async function startCommentPolling(viewUri, hashedUserId) {
  chrome.runtime.sendMessage({ type: 'status', data: 'connected' });

  commentPoller = new AbortController();
  const signal = commentPoller.signal;

  // at パラメータ: now (最新コメントのみ取得)
  let nextUri = viewUri + '?at=now';

  while (!signal.aborted) {
    try {
      log('[offscreen] Fetching comments from:', nextUri.substring(0, 100) + '...');
      const res = await fetch(nextUri, { signal });

      if (!res.ok) {
        log('[offscreen] Comment fetch failed:', res.status);
        await sleep(3000, signal);
        continue;
      }

      const body = await res.text();
      log('[offscreen] Response length:', body.length, 'first 500 chars:', body.substring(0, 500));

      // レスポンスをパース（NDJSON or JSON）
      const entries = parseCommentResponse(body);

      for (const entry of entries) {
        if (entry.chat) {
          chrome.runtime.sendMessage({
            type: 'comment',
            data: {
              text: entry.chat.content || entry.chat.body || '',
              vpos: entry.chat.vpos,
              date: entry.chat.date,
              mail: entry.chat.mail || '',
              user_id: entry.chat.user_id || entry.chat.userId || ''
            }
          });
        }
      }

      // "next" URIを探す
      const nextEntry = entries.find(e => e.next);
      if (nextEntry && nextEntry.next) {
        nextUri = nextEntry.next;
      } else {
        // nextがない場合は少し待って同じURIをリトライ
        await sleep(2000, signal);
      }
    } catch (err) {
      if (signal.aborted) break;
      log('[offscreen] Comment polling error:', err.message);
      await sleep(3000, signal);
    }
  }
}

function parseCommentResponse(body) {
  const entries = [];
  // NDJSON形式の場合（行ごとにJSON）
  const lines = body.split('\n').filter(l => l.trim());
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch (e) {
      // JSONでない行は無視
    }
  }
  // 単一JSONオブジェクトの場合
  if (entries.length === 0) {
    try {
      const obj = JSON.parse(body);
      if (Array.isArray(obj)) {
        entries.push(...obj);
      } else {
        entries.push(obj);
      }
    } catch (e) {
      log('[offscreen] Failed to parse response:', body.substring(0, 200));
    }
  }
  return entries;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      }, { once: true });
    }
  });
}
