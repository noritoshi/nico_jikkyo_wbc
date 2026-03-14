// offscreen.js — WebSocket接続 + mpn protobufコメント取得

const DEBUG = false; // デバッグログの有効/無効（リリース時はfalseに戻す）
function log(...args) {
  if (!DEBUG) return;
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  chrome.runtime.sendMessage({ type: 'log', data: msg }).catch(() => {});
}

let watchWs = null;
let commentAbort = null;
let vposBaseTime = null; // vpos基準時刻（Date.parse可能な文字列）

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'connect') {
    startConnection(msg.data);
    sendResponse({ ok: true });
    return true;
  } else if (msg.type === 'disconnect') {
    closeAll();
    sendResponse({ ok: true });
    return true;
  } else if (msg.type === 'postComment') {
    postComment(msg.data);
    sendResponse({ ok: true });
    return true;
  }
  // voice系メッセージなど、offscreenが処理しないメッセージは無視
  return false;
});

function closeAll() {
  if (commentAbort) {
    commentAbort.abort();
    commentAbort = null;
  }
  if (watchWs) {
    watchWs.close();
    watchWs = null;
  }
  fetchedSegments.clear();
  chrome.runtime.sendMessage({ type: 'status', data: 'disconnected' });
}

// ============================================================
// Protobuf Decoder
// ============================================================

function decodeVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos];
    result |= (byte & 0x7f) << shift;
    pos++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) break; // prevent infinite loop on bad data
  }
  return { value: result >>> 0, nextOffset: pos };
}

function decodeProtobuf(buf, offset = 0, end = undefined) {
  if (end === undefined) end = buf.length;
  const fields = {};
  let pos = offset;
  while (pos < end) {
    const tag = decodeVarint(buf, pos);
    pos = tag.nextOffset;
    if (pos > end || tag.value === 0) break;

    const fieldNumber = tag.value >>> 3;
    const wireType = tag.value & 0x7;

    if (wireType === 0) {
      const val = decodeVarint(buf, pos);
      pos = val.nextOffset;
      if (!fields[fieldNumber]) fields[fieldNumber] = [];
      fields[fieldNumber].push({ type: 'varint', value: val.value });
    } else if (wireType === 2) {
      const len = decodeVarint(buf, pos);
      pos = len.nextOffset;
      if (pos + len.value > end) break;
      const data = buf.slice(pos, pos + len.value);
      pos += len.value;
      if (!fields[fieldNumber]) fields[fieldNumber] = [];
      fields[fieldNumber].push({ type: 'bytes', data });
    } else if (wireType === 5) {
      pos += 4;
    } else if (wireType === 1) {
      pos += 8;
    } else {
      break;
    }
  }
  return fields;
}

function bytesToString(bytes) {
  return new TextDecoder().decode(bytes);
}

// Read length-delimited framed messages (varint length prefix)
function readFramedMessages(buf) {
  const messages = [];
  let pos = 0;
  while (pos < buf.length) {
    const len = decodeVarint(buf, pos);
    pos = len.nextOffset;
    if (len.value === 0 || pos + len.value > buf.length) break;
    messages.push(buf.slice(pos, pos + len.value));
    pos += len.value;
  }
  return messages;
}

function dumpFields(fields, prefix = '', depth = 0, maxDepth = 4) {
  if (depth > maxDepth) return;
  for (const [fn, values] of Object.entries(fields)) {
    for (const v of values) {
      if (v.type === 'varint') {
        log(`${prefix}f${fn}: varint=${v.value}`);
      } else if (v.type === 'bytes') {
        const str = bytesToString(v.data);
        const printable = str.replace(/[^\x20-\x7e\u3000-\u9fff\uff00-\uffef]/g, '');
        if (printable.length > str.length * 0.6 && str.length < 300) {
          log(`${prefix}f${fn}: str="${str.substring(0, 200)}"`);
        } else {
          log(`${prefix}f${fn}: bytes(${v.data.length})=${hex(v.data, 20)}`);
          // try nested
          try {
            const nested = decodeProtobuf(v.data);
            if (Object.keys(nested).length > 0) {
              dumpFields(nested, prefix + '  ', depth + 1, maxDepth);
            }
          } catch (e) {}
        }
      }
    }
  }
}

function hex(buf, maxBytes = 30) {
  return Array.from(buf.slice(0, maxBytes)).map(b => b.toString(16).padStart(2, '0')).join(' ');
}

// ============================================================
// Connection
// ============================================================

async function startConnection({ wsUrl, broadcastId }) {
  chrome.runtime.sendMessage({ type: 'status', data: 'connecting' });
  watchWs = new WebSocket(wsUrl);

  watchWs.onopen = () => {
    log('[ws] connected');
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
    // 全メッセージタイプをログ出力（デバッグ用）
    log('[ws] msg type=' + msg.type, JSON.stringify(msg.data).substring(0, 300));
    if (msg.type === 'postCommentResult') {
      chrome.runtime.sendMessage({ type: 'postCommentResult', data: msg.data });
      return;
    }
    if (msg.type === 'messageServer') {
      if (msg.data.vposBaseTime) {
        vposBaseTime = msg.data.vposBaseTime;
        log('[ws] vposBaseTime:', vposBaseTime);
      }
      startCommentStream(msg.data.viewUri);
    }
  };

  watchWs.onerror = () => {
    chrome.runtime.sendMessage({ type: 'status', data: 'error' });
  };
  watchWs.onclose = () => {
    chrome.runtime.sendMessage({ type: 'status', data: 'disconnected' });
  };
}

// ============================================================
// mpn Comment Stream (protobuf, streaming fetch)
// ============================================================

async function startCommentStream(viewUri) {
  chrome.runtime.sendMessage({ type: 'status', data: 'connected' });
  commentAbort = new AbortController();
  const signal = commentAbort.signal;

  let nextAt = 'now';

  while (!signal.aborted) {
    try {
      const url = viewUri + '?at=' + nextAt;
      log('[mpn] Poll:', url.substring(url.indexOf('?')));
      const pollStart = Date.now();
      const res = await fetch(url, { signal });

      if (!res.ok) {
        log('[mpn] HTTP error:', res.status);
        await sleep(2000, signal);
        continue;
      }

      // ストリーミングで逐次読み取り — フレームが届いた瞬間に処理
      // nextAtを取得したら現在のストリームを読みつつ次のポーリングも開始
      const reader = res.body.getReader();
      let buffer = new Uint8Array(0);
      let gotNext = false;
      let nextPollStarted = false;

      const continueReading = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const newBuf = new Uint8Array(buffer.length + value.length);
          newBuf.set(buffer);
          newBuf.set(value, buffer.length);
          buffer = newBuf;

          const { messages, remaining } = readFramedMessagesWithRemainder(buffer);
          buffer = remaining;

          for (const msgBuf of messages) {
            const result = processChunkedMessage(msgBuf);
            if (result.nextAt) {
              nextAt = result.nextAt;
              gotNext = true;
              log('[mpn] Next at:', result.nextAt, 'poll took:', (Date.now() - pollStart) + 'ms');
            }
            if (result.segmentUris) {
              for (const uri of result.segmentUris) {
                if (!fetchedSegments.has(uri)) {
                  fetchedSegments.add(uri);
                  log('[mpn] Fetch segment:', uri.substring(0, 80));
                  fetchSegment(uri);
                }
              }
            }
          }

          // nextAtを取得したら残りのストリームは裏で読みつつ、ループを抜ける
          if (gotNext && !nextPollStarted) {
            nextPollStarted = true;
            return; // 次のポーリングを即座に開始するためにreturn
          }
        }
      };

      await continueReading();

      // ストリームの残りをバックグラウンドで読み続ける（セグメントURI取得用）
      if (nextPollStarted) {
        (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const newBuf = new Uint8Array(buffer.length + value.length);
              newBuf.set(buffer);
              newBuf.set(value, buffer.length);
              buffer = newBuf;
              const { messages, remaining } = readFramedMessagesWithRemainder(buffer);
              buffer = remaining;
              for (const msgBuf of messages) {
                const result = processChunkedMessage(msgBuf);
                if (result.segmentUris) {
                  for (const uri of result.segmentUris) {
                    if (!fetchedSegments.has(uri)) {
                      fetchedSegments.add(uri);
                      log('[mpn] Fetch segment (bg):', uri.substring(0, 80));
                      fetchSegment(uri);
                    }
                  }
                }
              }
            }
          } catch (e) {}
        })();
      }

      if (!gotNext) {
        await sleep(500, signal);
      }
    } catch (err) {
      if (signal.aborted) break;
      log('[mpn] Error:', err.message);
      await sleep(2000, signal);
    }
  }
}

function readFramedMessagesWithRemainder(buf) {
  const messages = [];
  let pos = 0;
  while (pos < buf.length) {
    const len = decodeVarint(buf, pos);
    const headerSize = len.nextOffset - pos;
    if (len.value === 0) { pos = len.nextOffset; continue; }
    if (len.nextOffset + len.value > buf.length) break; // incomplete message
    messages.push(buf.slice(len.nextOffset, len.nextOffset + len.value));
    pos = len.nextOffset + len.value;
  }
  return { messages, remaining: buf.slice(pos) };
}

// Process a single ChunkedMessage
// Based on observed niconico protobuf structure:
// field 1: state (ChunkedState)
// field 2: signal
// field 3: backward segment
// field 4: next / signal with timestamp
function processChunkedMessage(msgBuf) {
  const fields = decodeProtobuf(msgBuf);
  log('[mpn] ChunkedMessage fields:', Object.keys(fields).join(','));
  dumpFields(fields, '  ', 0, 6);

  const result = { nextAt: null };

  // field 4 contains "next" with timestamp (field 1 = unix seconds)
  if (fields[4]) {
    for (const v of fields[4]) {
      if (v.type === 'bytes') {
        const nested = decodeProtobuf(v.data);
        if (nested[1]) {
          for (const ts of nested[1]) {
            if (ts.type === 'varint' && ts.value > 1700000000) {
              result.nextAt = String(ts.value);
              log('[mpn] Next at:', result.nextAt);
            }
          }
        }
      }
    }
  }

  // セグメントURIを収集
  const uris = collectSegmentUris(fields);
  result.segmentUris = uris;

  return result;
}

const fetchedSegments = new Set();

// セグメントURIを収集（fetchはしない）
function collectSegmentUris(fields, depth = 0) {
  const uris = [];
  if (depth > 5) return uris;
  for (const [fn, values] of Object.entries(fields)) {
    for (const v of values) {
      if (v.type === 'bytes') {
        const str = bytesToString(v.data);
        if (str.startsWith('https://') && !fetchedSegments.has(str)) {
          if (str.includes('/snapshot/') || str.includes('/backward/')) {
            // snapshot（埋め込みコンテンツ）とbackward（過去コメント）はスキップ
            fetchedSegments.add(str);
          } else {
            uris.push(str);
          }
        }
        try {
          const nested = decodeProtobuf(v.data);
          if (Object.keys(nested).length > 0) {
            uris.push(...collectSegmentUris(nested, depth + 1));
          }
        } catch (e) {}
      }
    }
  }
  return uris;
}

async function fetchSegment(uri) {
  try {
    const signal = commentAbort?.signal;
    const res = await fetch(uri, { signal });
    log('[seg] Streaming segment from', uri.substring(0, 80));

    // セグメントをストリーミングで読み取り、フレームが完成次第コメントを即座に送出
    const reader = res.body.getReader();
    let buffer = new Uint8Array(0);
    let commentCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // バッファに追加
      const newBuf = new Uint8Array(buffer.length + value.length);
      newBuf.set(buffer);
      newBuf.set(value, buffer.length);
      buffer = newBuf;

      // 完全なフレームを逐次処理
      const { messages, remaining } = readFramedMessagesWithRemainder(buffer);
      buffer = remaining;

      for (const frame of messages) {
        const c = extractComment(frame);
        if (c) {
          emitComment(c.text, c.no, c.mail, c.userId);
          commentCount++;
        }
      }
    }

    if (commentCount > 0) {
      log('[seg] Streamed', commentCount, 'comments from', uri.substring(0, 80));
    }
  } catch (err) {
    if (commentAbort?.signal.aborted) return;
    log('[seg] Fetch error:', err.message);
  }
}

// フレームから1コメントを抽出（text + vpos）
function extractComment(msgBuf) {
  const fields = decodeProtobuf(msgBuf);
  if (!fields[2]) return null;

  for (const wrapper of fields[2]) {
    if (wrapper.type !== 'bytes') continue;
    try {
      const wrapperFields = decodeProtobuf(wrapper.data);
      if (!wrapperFields[1]) continue;

      const innerMsg = wrapperFields[1][0];
      if (innerMsg?.type !== 'bytes') continue;

      const commentFields = decodeProtobuf(innerMsg.data);
      if (!commentFields[1]) continue;

      const textField = commentFields[1][0];
      if (textField?.type !== 'bytes') continue;

      const text = bytesToString(textField.data);
      const vpos = commentFields[3]?.[0]?.type === 'varint' ? commentFields[3][0].value : 0;
      const no = commentFields[8]?.[0]?.type === 'varint' ? commentFields[8][0].value : null;

      // modifier (f7): 装飾情報を解析（全てenum=varint）
      let mail = '';
      if (commentFields[7]?.[0]?.type === 'bytes') {
        const mod = decodeProtobuf(commentFields[7][0].data);
        const parts = [];

        // f1: position (0=naka, 1=shita, 2=ue)
        const posVal = mod[1]?.[0]?.type === 'varint' ? mod[1][0].value : 0;
        const posNames = ['', 'shita', 'ue'];
        if (posNames[posVal]) parts.push(posNames[posVal]);

        // f2: size (0=medium, 1=small, 2=big)
        const sizeVal = mod[2]?.[0]?.type === 'varint' ? mod[2][0].value : 0;
        const sizeNames = ['', 'small', 'big'];
        if (sizeNames[sizeVal]) parts.push(sizeNames[sizeVal]);

        // f3: named_color (0=white, 1=red, 2=pink, 3=orange, 4=yellow, 5=green, 6=cyan, 7=blue, 8=purple, 9=black)
        const colorVal = mod[3]?.[0]?.type === 'varint' ? mod[3][0].value : 0;
        const colorNames = ['', 'red', 'pink', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'black'];
        if (colorNames[colorVal]) parts.push(colorNames[colorVal]);

        // f6: opacity (0=normal, 1=translucent)
        const opacityVal = mod[6]?.[0]?.type === 'varint' ? mod[6][0].value : 0;
        if (opacityVal === 1) parts.push('translucent');

        mail = parts.join(' ');
        if (mail) log('[comment] modifier:', mail);
      }
      // f6: ユーザーハッシュ（匿名ID）
      const userId = commentFields[6]?.[0]?.type === 'bytes'
        ? bytesToString(commentFields[6][0].data) : null;

      return { text, vpos, no, mail, userId };
    } catch (e) {}
  }
  return null;
}

function isLikelyComment(text) {
  if (!text || text.length === 0) return false;
  // Filter out user IDs (a:xxxxx format)
  if (/^a:[A-Za-z0-9_-]+$/.test(text)) return false;
  // Filter out thread IDs (lv123456-N format)
  if (/^lv\d+-\d+$/.test(text)) return false;
  // Filter out pure numeric strings
  if (/^\d+$/.test(text)) return false;
  // Filter out URLs
  if (text.startsWith('https://') || text.startsWith('http://')) return false;
  // Must have some readable content
  if (text.length < 1 || text.length > 200) return false;
  return true;
}

const seenCommentNos = new Set(); // コメント番号による重複排除

function emitComment(text, commentNo, mail = '', userId = null) {
  if (!isLikelyComment(text)) return;

  // コメント番号で重複排除
  if (commentNo && seenCommentNos.has(commentNo)) {
    log('[comment] duplicate no=' + commentNo + ' skipped');
    return;
  }
  if (commentNo) {
    seenCommentNos.add(commentNo);
    if (seenCommentNos.size > 1000) {
      const arr = Array.from(seenCommentNos);
      seenCommentNos.clear();
      for (let i = 500; i < arr.length; i++) seenCommentNos.add(arr[i]);
    }
  }

  log('[comment]', text.substring(0, 50), 'no=' + commentNo, 'mail=' + mail);
  chrome.runtime.sendMessage({
    type: 'comment',
    data: { text, mail, userId }
  });
}

function postComment(data) {
  if (!watchWs || watchWs.readyState !== WebSocket.OPEN) {
    log('[post] WebSocket not connected');
    chrome.runtime.sendMessage({ type: 'postCommentResult', data: { error: 'not_connected' } });
    return;
  }

  const vpos = vposBaseTime
    ? Math.round((Date.now() - Date.parse(vposBaseTime)) / 10)
    : 0;

  const msg = {
    type: 'postComment',
    data: {
      text: data.text,
      vpos,
      isAnonymous: data.isAnonymous !== false
    }
  };
  if (data.color) msg.data.color = data.color;
  if (data.size) msg.data.size = data.size;
  if (data.position) msg.data.position = data.position;

  log('[post] Sending:', JSON.stringify(msg));
  watchWs.send(JSON.stringify(msg));
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
