// offscreen.js — WebSocket接続をService Worker外で維持するためのオフスクリーンドキュメント

let watchWs = null;
let commentWs = null;

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
  if (commentWs) {
    commentWs.close();
    commentWs = null;
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
    // 視聴開始メッセージを送信
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
    }

    // コメントサーバー情報を受信
    if (msg.type === 'room') {
      connectCommentServer(msg.data);
    }

    // messageServer形式（新しいAPI）
    if (msg.type === 'messageServer') {
      connectCommentServer({
        messageServer: msg.data
      });
    }
  };

  watchWs.onerror = (err) => {
    console.error('Watch WebSocket error:', err);
    chrome.runtime.sendMessage({ type: 'status', data: 'error' });
  };

  watchWs.onclose = () => {
    console.log('Watch WebSocket closed');
    chrome.runtime.sendMessage({ type: 'status', data: 'disconnected' });
  };
}

function connectCommentServer(roomData) {
  const wsUri = roomData.messageServer?.uri || roomData.messageServer?.webSocketUri;
  if (!wsUri) {
    console.error('No comment server URI found in room data:', roomData);
    return;
  }

  const threadId = roomData.threadId || roomData.messageServer?.threadId;

  chrome.runtime.sendMessage({ type: 'status', data: 'connected' });

  commentWs = new WebSocket(wsUri);

  commentWs.onopen = () => {
    // スレッド接続メッセージ（過去コメントは不要、リアルタイムのみ）
    if (threadId) {
      commentWs.send(JSON.stringify([
        { ping: { content: 'rs:0' } },
        {
          thread: {
            thread: String(threadId),
            version: '20061206',
            user_id: 'guest',
            res_from: 0,
            with_global: 1,
            scores: 1,
            nicoru: 0
          }
        },
        { ping: { content: 'rf:0' } }
      ]));
    }
  };

  commentWs.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    // コメントを受信したらbackgroundに転送
    if (msg.chat && msg.chat.content) {
      chrome.runtime.sendMessage({
        type: 'comment',
        data: {
          text: msg.chat.content,
          vpos: msg.chat.vpos,
          date: msg.chat.date,
          mail: msg.chat.mail || '',
          user_id: msg.chat.user_id
        }
      });
    }
  };

  commentWs.onerror = (err) => {
    console.error('Comment WebSocket error:', err);
  };

  commentWs.onclose = () => {
    console.log('Comment WebSocket closed');
  };
}
