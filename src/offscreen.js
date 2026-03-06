// offscreen.js — WebSocket接続 + mpn protobufコメント取得

function log(...args) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  chrome.runtime.sendMessage({ type: 'log', data: msg }).catch(() => {});
}

let watchWs = null;
let commentAbort = null;

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
  if (commentAbort) {
    commentAbort.abort();
    commentAbort = null;
  }
  if (watchWs) {
    watchWs.close();
    watchWs = null;
  }
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

function dumpFields(fields, prefix = '', depth = 0) {
  if (depth > 4) return;
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
              dumpFields(nested, prefix + '  ', depth + 1);
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
    if (msg.type === 'messageServer') {
      log('[ws] messageServer:', JSON.stringify(msg.data));
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
      const res = await fetch(url, { signal });

      if (!res.ok) {
        log('[mpn] HTTP error:', res.status);
        await sleep(2000, signal);
        continue;
      }

      // レスポンス全体をすばやく読み取り
      const buf = new Uint8Array(await res.arrayBuffer());
      const { messages } = readFramedMessagesWithRemainder(buf);

      let gotNext = false;
      for (const msgBuf of messages) {
        const result = processChunkedMessage(msgBuf);
        if (result.nextAt) {
          nextAt = result.nextAt;
          gotNext = true;
        }
      }

      if (!gotNext) {
        await sleep(500, signal);
      }
      // nextAtを得たら即座に次のリクエスト（待ちなし）
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
  dumpFields(fields, '  ');

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

  // Look for segment URIs in all nested bytes fields
  findAndFetchSegments(fields, 0);

  return result;
}

const fetchedSegments = new Set();

function findAndFetchSegments(fields, depth) {
  if (depth > 5) return;
  for (const [fn, values] of Object.entries(fields)) {
    for (const v of values) {
      if (v.type === 'bytes') {
        const str = bytesToString(v.data);
        // Check if this is a segment URI
        if (str.startsWith('https://') && !fetchedSegments.has(str)) {
          // backward segments (old comments) and snapshot segments (embedded content) are not needed
          if (str.includes('/backward/') || str.includes('/snapshot/')) {
            log('[mpn] Skipping:', str.includes('/backward/') ? 'backward' : 'snapshot');
            fetchedSegments.add(str);
          } else {
            log('[mpn] Found URI in f' + fn + ':', str.substring(0, 120));
            fetchedSegments.add(str);
            fetchSegment(str);
          }
        }
        // Recurse into nested messages
        try {
          const nested = decodeProtobuf(v.data);
          if (Object.keys(nested).length > 0) {
            findAndFetchSegments(nested, depth + 1);
          }
        } catch (e) {}
      }
    }
  }
}

async function fetchSegment(uri) {
  try {
    const signal = commentAbort?.signal;
    const res = await fetch(uri, { signal });
    const buf = new Uint8Array(await res.arrayBuffer());
    log('[seg] Fetched segment:', buf.length, 'bytes from', uri.substring(0, 80));

    if (buf.length < 10) {
      log('[seg] Segment too small, skipping');
      return;
    }

    // Try framed messages first
    const framed = readFramedMessages(buf);
    if (framed.length > 0) {
      log('[seg] Framed messages:', framed.length);
      for (const frame of framed) {
        extractAndEmitComments(frame);
      }
    } else {
      // Try direct decode
      extractAndEmitComments(buf);
    }
  } catch (err) {
    log('[seg] Fetch error:', err.message);
  }
}

function extractAndEmitComments(msgBuf) {
  const fields = decodeProtobuf(msgBuf);

  // セグメント内の各フレームメッセージは以下の構造:
  // f1: コメントテキスト (bytes/string)
  // f2: (bytes, 空文字列が多い)
  // f3: vpos (varint)
  // f4: score/flag (varint, optional)
  // f6: ユーザーID (bytes/string, "a:xxxx")
  // f7: (bytes)
  // f8: コメント番号 (varint)
  //
  // ただしメッセージは1段ネストされている場合がある

  // 直接f1がある場合（フラットな構造）
  if (fields[1] && fields[3]) {
    const f1 = fields[1][0];
    const f3 = fields[3][0];
    if (f1?.type === 'bytes' && f3?.type === 'varint') {
      const text = bytesToString(f1.data);
      emitComment(text);
      return;
    }
  }

  // ネストされている場合: bytes フィールドの中にコメント構造がある
  for (const [fn, values] of Object.entries(fields)) {
    for (const v of values) {
      if (v.type === 'bytes') {
        try {
          const nested = decodeProtobuf(v.data);
          // f1 (text) + f3 (vpos as varint) があればコメント
          if (nested[1] && nested[3]) {
            const nf1 = nested[1][0];
            const nf3 = nested[3][0];
            if (nf1?.type === 'bytes' && nf3?.type === 'varint') {
              const text = bytesToString(nf1.data);
              emitComment(text);
            }
          }
        } catch (e) {}
      }
    }
  }
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

function emitComment(text) {
  if (!isLikelyComment(text)) return;
  log('[comment]', text.substring(0, 50));
  chrome.runtime.sendMessage({
    type: 'comment',
    data: { text, mail: '', user_id: '' }
  });
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
