// offscreen.js — WebSocket接続をService Worker外で維持するためのオフスクリーンドキュメント

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
// Minimal Protobuf Decoder (wire format only, no schema needed)
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
  }
  return { value: result, nextOffset: pos };
}

// Decode protobuf into a generic object: { fieldNumber: [values...] }
function decodeProtobuf(buf, offset = 0, end = buf.length) {
  const fields = {};
  let pos = offset;
  while (pos < end) {
    const tag = decodeVarint(buf, pos);
    pos = tag.nextOffset;
    if (pos > end) break;

    const fieldNumber = tag.value >> 3;
    const wireType = tag.value & 0x7;

    if (wireType === 0) {
      // varint
      const val = decodeVarint(buf, pos);
      pos = val.nextOffset;
      if (!fields[fieldNumber]) fields[fieldNumber] = [];
      fields[fieldNumber].push({ type: 'varint', value: val.value });
    } else if (wireType === 2) {
      // length-delimited
      const len = decodeVarint(buf, pos);
      pos = len.nextOffset;
      const data = buf.slice(pos, pos + len.value);
      pos += len.value;
      if (!fields[fieldNumber]) fields[fieldNumber] = [];
      fields[fieldNumber].push({ type: 'bytes', data });
    } else if (wireType === 5) {
      // 32-bit
      pos += 4;
    } else if (wireType === 1) {
      // 64-bit
      pos += 8;
    } else {
      break; // unknown wire type
    }
  }
  return fields;
}

function bytesToString(bytes) {
  return new TextDecoder().decode(bytes);
}

// Try to decode bytes as a nested protobuf message
function tryDecodeNested(bytes) {
  try {
    const result = decodeProtobuf(bytes);
    if (Object.keys(result).length > 0) return result;
  } catch (e) {}
  return null;
}

// Read length-delimited protobuf messages from a buffer (chunked format)
function readChunkedMessages(buf) {
  const messages = [];
  let pos = 0;
  while (pos < buf.length) {
    const len = decodeVarint(buf, pos);
    pos = len.nextOffset;
    if (pos + len.value > buf.length) break;
    const msgBuf = buf.slice(pos, pos + len.value);
    pos += len.value;
    messages.push(msgBuf);
  }
  return messages;
}

// Extract all string values from protobuf fields recursively
function extractStrings(fields, depth = 0) {
  const strings = [];
  if (depth > 5) return strings;
  for (const [fn, values] of Object.entries(fields)) {
    for (const v of values) {
      if (v.type === 'bytes') {
        // Try as string
        const str = bytesToString(v.data);
        if (str && /^[\x20-\x7e\u3000-\u9fff\uff00-\uffef]+$/.test(str.trim())) {
          strings.push({ field: fn, value: str });
        }
        // Try as nested message
        const nested = tryDecodeNested(v.data);
        if (nested) {
          strings.push(...extractStrings(nested, depth + 1).map(s => ({
            field: fn + '.' + s.field,
            value: s.value
          })));
        }
      }
    }
  }
  return strings;
}

// Extract URIs from protobuf
function extractUris(fields, depth = 0) {
  const uris = [];
  if (depth > 5) return uris;
  for (const [fn, values] of Object.entries(fields)) {
    for (const v of values) {
      if (v.type === 'bytes') {
        const str = bytesToString(v.data);
        if (str && str.startsWith('https://')) {
          uris.push(str);
        }
        const nested = tryDecodeNested(v.data);
        if (nested) {
          uris.push(...extractUris(nested, depth + 1));
        }
      }
    }
  }
  return uris;
}

// ============================================================
// Comment extraction from protobuf
// ============================================================

// NiconamaMessage.chat typically has:
//   field 1: raw body (string) - old format
//   field 3: content (string) - comment text
//   field 5: vpos (varint)
//   field 6: mail/command (string)
// The actual field numbers depend on the proto schema.
// We extract all readable strings as potential comments.

function extractComments(segmentBuf) {
  const comments = [];
  // The segment may contain length-delimited chunks
  const chunks = readChunkedMessages(segmentBuf);

  for (const chunk of chunks) {
    const fields = decodeProtobuf(chunk);
    const extracted = extractCommentsFromFields(fields, 0);
    comments.push(...extracted);
  }

  // If no chunks parsed, try direct decode
  if (comments.length === 0) {
    const fields = decodeProtobuf(segmentBuf);
    comments.push(...extractCommentsFromFields(fields, 0));
  }

  return comments;
}

function extractCommentsFromFields(fields, depth) {
  const comments = [];
  if (depth > 6) return comments;

  for (const [fn, values] of Object.entries(fields)) {
    for (const v of values) {
      if (v.type === 'bytes') {
        const nested = tryDecodeNested(v.data);
        if (nested) {
          // Check if this looks like a comment message (has a string field that looks like text)
          const strs = extractStrings(nested, 0);
          const hasText = strs.some(s => s.value.length >= 1 && s.value.length < 200);
          const hasUri = strs.some(s => s.value.startsWith('https://'));

          if (hasText && !hasUri) {
            // This might be a comment - get the longest non-URL string as the text
            const textCandidates = strs
              .filter(s => !s.value.startsWith('https://') && s.value.length >= 1)
              .sort((a, b) => b.value.length - a.value.length);
            if (textCandidates.length > 0) {
              comments.push({ text: textCandidates[0].value });
            }
          }

          // Recurse
          comments.push(...extractCommentsFromFields(nested, depth + 1));
        }
      }
    }
  }
  return comments;
}

// ============================================================
// Connection
// ============================================================

async function startConnection({ wsUrl, broadcastId }) {
  chrome.runtime.sendMessage({ type: 'status', data: 'connecting' });

  watchWs = new WebSocket(wsUrl);

  watchWs.onopen = () => {
    log('[offscreen] Watch WS connected');
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

    if (msg.type !== 'statistics') {
      log('[offscreen] WS msg:', msg.type);
    }

    if (msg.type === 'messageServer') {
      log('[offscreen] messageServer viewUri:', msg.data.viewUri);
      startCommentStream(msg.data.viewUri);
    }
  };

  watchWs.onerror = () => {
    log('[offscreen] Watch WS error');
    chrome.runtime.sendMessage({ type: 'status', data: 'error' });
  };

  watchWs.onclose = () => {
    log('[offscreen] Watch WS closed');
    chrome.runtime.sendMessage({ type: 'status', data: 'disconnected' });
  };
}

// ============================================================
// Comment stream via mpn viewUri (protobuf)
// ============================================================

async function startCommentStream(viewUri) {
  chrome.runtime.sendMessage({ type: 'status', data: 'connected' });

  commentAbort = new AbortController();
  const signal = commentAbort.signal;

  try {
    // Step 1: Fetch viewUri to get segment URIs
    log('[offscreen] Fetching viewUri...');
    const res = await fetch(viewUri + '?at=now', { signal });
    const contentType = res.headers.get('content-type');
    log('[offscreen] viewUri content-type:', contentType);

    const buf = new Uint8Array(await res.arrayBuffer());
    log('[offscreen] viewUri response bytes:', buf.length, 'hex:', Array.from(buf.slice(0, 50)).map(b => b.toString(16).padStart(2, '0')).join(' '));

    // Decode protobuf to find segment URIs
    const fields = decodeProtobuf(buf);
    log('[offscreen] viewUri top-level fields:', Object.keys(fields));

    const uris = extractUris(fields);
    log('[offscreen] Found URIs in viewUri response:', uris);

    // Find segment URIs (typically contain /segment/)
    const segmentUris = uris.filter(u => u.includes('segment'));
    const nextUris = uris.filter(u => u.includes('next') || u.includes('at='));

    log('[offscreen] Segment URIs:', segmentUris.length, 'Next URIs:', nextUris.length);

    if (segmentUris.length > 0) {
      // Fetch latest segment
      await pollSegments(segmentUris[segmentUris.length - 1], signal);
    } else if (uris.length > 0) {
      // Try all URIs
      log('[offscreen] No segment URIs found, trying all URIs...');
      for (const uri of uris) {
        log('[offscreen] Trying URI:', uri.substring(0, 100));
        await fetchAndProcessSegment(uri, signal);
      }
      // Continue polling viewUri
      await pollViewUri(viewUri, signal);
    } else {
      log('[offscreen] No URIs found in viewUri response, dumping structure...');
      dumpProtobuf(fields, '', 0);
      // Poll the viewUri itself for changes
      await pollViewUri(viewUri, signal);
    }
  } catch (err) {
    if (!signal.aborted) {
      log('[offscreen] Comment stream error:', err.message);
    }
  }
}

async function pollViewUri(viewUri, signal) {
  while (!signal.aborted) {
    await sleep(3000, signal);
    try {
      const res = await fetch(viewUri + '?at=now', { signal });
      const buf = new Uint8Array(await res.arrayBuffer());
      const fields = decodeProtobuf(buf);
      const uris = extractUris(fields);

      const segmentUris = uris.filter(u => u.includes('segment'));
      if (segmentUris.length > 0) {
        await pollSegments(segmentUris[segmentUris.length - 1], signal);
        return;
      }

      // Try to extract comments directly from viewUri response
      const comments = extractComments(buf);
      for (const c of comments) {
        emitComment(c.text);
      }
    } catch (err) {
      if (signal.aborted) break;
      log('[offscreen] pollViewUri error:', err.message);
    }
  }
}

async function pollSegments(segmentUri, signal) {
  log('[offscreen] Polling segment:', segmentUri.substring(0, 100));

  while (!signal.aborted) {
    try {
      await fetchAndProcessSegment(segmentUri, signal);
    } catch (err) {
      if (signal.aborted) break;
      log('[offscreen] Segment poll error:', err.message);
    }
    await sleep(2000, signal);
  }
}

async function fetchAndProcessSegment(uri, signal) {
  const res = await fetch(uri, { signal });
  const buf = new Uint8Array(await res.arrayBuffer());
  log('[offscreen] Segment response bytes:', buf.length);

  if (buf.length > 20) {
    const comments = extractComments(buf);
    log('[offscreen] Extracted comments:', comments.length);
    for (const c of comments) {
      emitComment(c.text);
    }
  }
}

function emitComment(text) {
  if (!text || text.length === 0) return;
  chrome.runtime.sendMessage({
    type: 'comment',
    data: {
      text: text,
      mail: '',
      user_id: ''
    }
  });
}

function dumpProtobuf(fields, prefix, depth) {
  if (depth > 3) return;
  for (const [fn, values] of Object.entries(fields)) {
    for (const v of values) {
      if (v.type === 'varint') {
        log(prefix + `field ${fn}: varint = ${v.value}`);
      } else if (v.type === 'bytes') {
        const str = bytesToString(v.data);
        const isReadable = /^[\x20-\x7e\u0080-\uffff]+$/.test(str);
        if (isReadable && str.length < 200) {
          log(prefix + `field ${fn}: string = "${str}"`);
        } else {
          log(prefix + `field ${fn}: bytes(${v.data.length}) = ${Array.from(v.data.slice(0, 30)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
          const nested = tryDecodeNested(v.data);
          if (nested) {
            log(prefix + `field ${fn}: (nested message)`);
            dumpProtobuf(nested, prefix + '  ', depth + 1);
          }
        }
      }
    }
  }
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
