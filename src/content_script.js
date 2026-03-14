// content_script.js — Netflix上にコメントオーバーレイを描画

// 二重注入ガード
if (window.__nikoJikkyoLoaded) { /* already loaded */ } else {
window.__nikoJikkyoLoaded = true;

let commentsHidden = false;
let aiGeneratedText = '';
let aiIsEditing = false;
let aiGenerating = false;
let voiceActive = false;
let voiceAutoPost = true; // true=自動投稿, false=手動入力
let voiceErrorUntil = 0; // エラー表示中のタイムスタンプ（stopped上書き防止）
let voiceAudioContext = null;
let voiceMediaStream = null;
let voiceScriptProcessor = null;

// WBC 2026 キーワード（Deepgram keywords boost）
const VOICE_KEYWORDS = [
  // 侍ジャパン主要選手
  '大谷翔平:2', '山本由伸:2', '鈴木誠也:2', '吉田正尚:2',
  '村上宗隆:2', '牧秀悟:2', '源田壮亮:2', '宮城大弥:2',
  '佐々木朗希:2', '今永昇太:2', 'ダルビッシュ:2', '栗林良吏:2',
  '甲斐拓也:2', '近藤健介:2', '岡本和真:2', '戸郷翔征:2',
  // 野球用語
  'ホームラン:1.5', 'ヒット:1', 'ツーベース:1.5', 'スリーベース:1.5',
  'ストライク:1', 'ボール:1', 'アウト:1', 'セーフ:1',
  'フォアボール:1', 'デッドボール:1.5', '三振:1.5',
  'ダブルプレー:1.5', 'ゲッツー:1.5', 'エラー:1',
  'ファインプレー:1.5', '犠牲フライ:1.5', '盗塁:1.5',
  'ピッチャー:1', 'バッター:1', 'キャッチャー:1',
  'ストレート:1', 'フォーク:1', 'スライダー:1', 'カーブ:1', 'チェンジアップ:1',
  // WBC・大会用語
  'WBC:2', 'ワールドベースボールクラシック:2', '侍ジャパン:2',
  '決勝:1.5', '準決勝:1.5', '予選:1',
  // 実況・応援表現
  'ナイスバッティング:1', 'ナイスピッチング:1',
  'ナイスキャッチ:1', 'すごい:1', 'やばい:1',
];

const DEFAULT_PLACEHOLDER = 'コメントを入力（Enter で送信）';
const MIC_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>';
const MIC_SVG_OFF = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="12" rx="3"/><line x1="4" x2="20" y1="4" y2="20"/></svg>';

function stopVoiceAudio() {
  stopVoiceBatchSend();
  if (voiceMediaStream) {
    voiceMediaStream.getTracks().forEach(t => t.stop());
    voiceMediaStream = null;
  }
  if (voiceScriptProcessor) {
    try { voiceScriptProcessor.disconnect(); } catch (_) {}
    voiceScriptProcessor = null;
  }
  if (voiceAudioContext) {
    try { voiceAudioContext.close(); } catch (_) {}
    voiceAudioContext = null;
  }
}

// --- Voice: Deepgram REST API (content_scriptから直接送信) ---
const V_BASE_DUR = 0.8, V_CPS = 3, V_MAX_LEN = 75;

function vElongateWord(word, dur) {
  if (dur <= V_BASE_DUR) return word;
  const m = word.match(/(.*?)(([ーあいうえおアイウエオぁぃぅぇぉァィゥェォっッ])\3*)$/);
  if (!m) return word;
  return m[1] + m[3].repeat(m[2].length + Math.round((dur - V_BASE_DUR) * V_CPS));
}

function vProcessTranscript(transcript, words) {
  let r = transcript;
  for (const w of words) {
    const e = vElongateWord(w.word, w.end - w.start);
    if (e !== w.word) r = r.replace(w.word, e);
  }
  return r.slice(0, V_MAX_LEN).replace(/[。、，．]/g, '').replace(/！/g, '!').replace(/？/g, '?').trim();
}

function voiceShowError(msg) {
  voiceActive = false;
  stopVoiceAudio();
  voiceErrorUntil = Date.now() + 3000;
  const micBtn = document.getElementById('niko-jikkyo-mic-btn');
  const modeBtn = document.getElementById('niko-jikkyo-voice-mode');
  const input = document.getElementById('niko-jikkyo-input');
  if (micBtn) { micBtn.classList.remove('active'); micBtn.innerHTML = MIC_SVG + ' 音声'; }
  if (modeBtn) modeBtn.style.display = 'none';
  if (input) {
    input.classList.add('voice-error');
    input.placeholder = msg;
    input.value = '';
    setTimeout(() => { input.placeholder = DEFAULT_PLACEHOLDER; input.classList.remove('voice-error'); }, 3000);
  }
}

// --- Voice: Deepgram REST API (バッチ送信方式) ---
let voiceApiKey = '';
let voiceSendTimer = null;
let voiceAudioChunks = []; // PCMバッファ蓄積

const V_SEND_INTERVAL = 2500; // 2.5秒ごとにAPIへ送信

function startVoiceBatchSend(apiKey) {
  voiceApiKey = apiKey;
  voiceAudioChunks = [];
  const input = document.getElementById('niko-jikkyo-input');
  if (input) input.placeholder = voiceAutoPost ? '音声認識中...' : '音声認識中...（Enterで送信）';
  console.log('[niko-voice] REST batch mode started');

  voiceSendTimer = setInterval(() => {
    if (!voiceActive || voiceAudioChunks.length === 0) return;
    // 蓄積したPCMチャンクを結合して送信
    const totalLen = voiceAudioChunks.reduce((s, c) => s + c.length, 0);
    const combined = new Int16Array(totalLen);
    let offset = 0;
    for (const chunk of voiceAudioChunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    voiceAudioChunks = [];
    sendAudioToDeepgram(combined.buffer);
  }, V_SEND_INTERVAL);
}

function stopVoiceBatchSend() {
  if (voiceSendTimer) {
    clearInterval(voiceSendTimer);
    voiceSendTimer = null;
  }
  voiceAudioChunks = [];
}

async function sendAudioToDeepgram(audioBuffer) {
  const params = new URLSearchParams({
    language: 'ja', model: 'nova-3',
    punctuate: 'true', smart_format: 'true',
    encoding: 'linear16', sample_rate: '16000', channels: '1',
  });
  const url = 'https://api.deepgram.com/v1/listen?' + params.toString();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Token ' + voiceApiKey,
        'Content-Type': 'application/octet-stream',
      },
      body: audioBuffer,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        voiceShowError('Deepgram API Keyが無効です');
        return;
      }
      console.warn('[niko-voice] API error:', res.status, errText.substring(0, 200));
      return;
    }
    const json = await res.json();
    const alt = json.results?.channels?.[0]?.alternatives?.[0];
    if (!alt) return;
    let transcript = (alt.transcript || '').trim();
    if (!transcript) return;

    transcript = vProcessTranscript(transcript, alt.words || []);
    if (!transcript) return;

    console.log('[niko-voice] Transcript:', transcript);
    const input = document.getElementById('niko-jikkyo-input');
    if (voiceAutoPost) {
      postUserComment(transcript);
      if (input) input.value = '';
    } else {
      if (input) { input.value = transcript; input.focus(); }
    }
  } catch (e) {
    console.warn('[niko-voice] REST error:', e.message);
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// 概要履歴キャッシュ（グラフホバー用）
let summaryHistoryCache = []; // [{time, text}]

function drawCommentGraph(points) {
  const canvas = document.getElementById('niko-comment-graph');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const pad = { top: 2, bottom: 12, left: 6, right: 6 };
  const gw = w - pad.left - pad.right;
  const gh = h - pad.top - pad.bottom;
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(...points, 1);
  const n = points.length;
  if (n === 0) return;
  // バー設定
  const gap = 2;
  const barW = Math.max(2, (gw - gap * (n - 1)) / n);
  // 棒グラフ描画
  for (let i = 0; i < n; i++) {
    const ratio = points[i] / max;
    const barH = Math.max(ratio > 0 ? 2 : 0, ratio * gh);
    const x = pad.left + i * (barW + gap);
    const y = pad.top + gh - barH;
    // 強度に応じた透明度（0.15〜1.0）
    const alpha = 0.15 + ratio * 0.85;
    const r = 2;
    // 角丸バー
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + barW - r, y);
    ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
    ctx.lineTo(x + barW, y + barH);
    ctx.lineTo(x, y + barH);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fillStyle = `rgba(34, 211, 238, ${alpha.toFixed(2)})`;
    ctx.fill();
  }
  // 時間軸ラベル
  ctx.fillStyle = '#475569';
  ctx.font = '9px SF Mono, Menlo, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('-10m', pad.left + 10, h - 1);
  ctx.fillText('-5m', pad.left + gw * 0.5, h - 1);
  ctx.fillText('now', pad.left + gw - 10, h - 1);
  // 最大値ラベル
  ctx.textAlign = 'right';
  ctx.fillText(max + '/10s', w - 2, pad.top + 9);
}
let isPremiumUser = false;
const premiumPosBtns = [];
const LANE_COUNT = 12;
const FIXED_LANE_COUNT = 8; // 固定コメント用レーン数
const FIXED_DURATION = 5000; // 固定コメント表示時間(ms)
const myPostedComments = new Set(); // 自分が投稿したコメントテキスト
const recentRendered = []; // 表示済みコメント（重複排除用）
const COMMENT_DURATION = 7000; // ms
const lanes = new Array(LANE_COUNT).fill(0); // 各レーンの解放時刻
const ueLanes = new Array(FIXED_LANE_COUNT).fill(0); // 上固定レーン解放時刻
const shitaLanes = new Array(FIXED_LANE_COUNT).fill(0); // 下固定レーン解放時刻

function getOverlay() {
  let overlay = document.getElementById('niko-jikkyo-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'niko-jikkyo-overlay';
    document.body.appendChild(overlay);
  }
  return overlay;
}

// 空いているレーンを探す
function findAvailableLane() {
  const now = Date.now();
  let best = 0;
  let bestTime = lanes[0];

  for (let i = 0; i < LANE_COUNT; i++) {
    if (lanes[i] <= now) return i;
    if (lanes[i] < bestTime) {
      best = i;
      bestTime = lanes[i];
    }
  }
  return best;
}

// mailコマンドから色を取得
function getColorFromMail(mail) {
  const colors = {
    red: '#ff0000',
    pink: '#ff8080',
    orange: '#ffc000',
    yellow: '#ffff00',
    green: '#00ff00',
    cyan: '#00ffff',
    blue: '#0000ff',
    purple: '#c000ff',
    white: '#ffffff'
  };
  if (!mail) return null;
  for (const [name, hex] of Object.entries(colors)) {
    if (mail.includes(name)) return hex;
  }
  return null;
}

function getPositionFromMail(mail) {
  if (!mail) return null;
  if (mail.includes('ue')) return 'ue';
  if (mail.includes('shita')) return 'shita';
  return null;
}

function getSizeFromMail(mail) {
  if (!mail) return null;
  if (mail.includes('big')) return 'big';
  if (mail.includes('small')) return 'small';
  return null;
}

function renderComment(commentData) {
  // 3秒以内の同一テキストは重複として無視
  const now = Date.now();
  if (recentRendered.some(c => c.text === commentData.text && now - c.time < 3000)) return;
  recentRendered.push({ text: commentData.text, time: now });
  if (recentRendered.length > 50) recentRendered.splice(0, 25);

  const overlay = getOverlay();
  const el = document.createElement('div');
  el.className = 'niko-comment';
  if (myPostedComments.has(commentData.text)) {
    el.classList.add('niko-comment-mine');
    myPostedComments.delete(commentData.text);
  }
  el.textContent = commentData.text;

  const mail = commentData.mail || '';
  const color = getColorFromMail(mail);
  if (color) el.style.color = color;

  const size = getSizeFromMail(mail);
  if (size === 'big') el.style.fontSize = '44px';
  else if (size === 'small') el.style.fontSize = '20px';

  if (mail.includes('translucent')) el.style.opacity = '0.5';

  const position = getPositionFromMail(mail);

  if (position === 'ue' || position === 'shita') {
    // 上固定・下固定コメント（レーン管理で重ならないようにする）
    el.classList.add('niko-comment-fixed');
    const fixedLanes = position === 'ue' ? ueLanes : shitaLanes;
    const now = Date.now();
    let slot = -1;
    for (let i = 0; i < FIXED_LANE_COUNT; i++) {
      if (fixedLanes[i] <= now) { slot = i; break; }
    }
    if (slot === -1) {
      // 全スロット使用中 → 最も古いスロットを上書き
      let oldest = 0;
      for (let i = 1; i < FIXED_LANE_COUNT; i++) {
        if (fixedLanes[i] < fixedLanes[oldest]) oldest = i;
      }
      slot = oldest;
    }
    fixedLanes[slot] = now + FIXED_DURATION;

    const fontSize = size === 'big' ? 44 : size === 'small' ? 20 : 32;
    const lineHeight = fontSize * 1.3;
    if (position === 'ue') {
      el.style.top = (5 + slot * lineHeight / window.innerHeight * 100) + '%';
    } else {
      el.style.bottom = (20 + slot * lineHeight / window.innerHeight * 100) + '%';
      el.style.top = 'auto';
    }
    el.style.left = '50%';
    el.style.transform = 'translateX(-50%)';
    el.style.animation = `niko-fade ${FIXED_DURATION}ms linear forwards`;
    overlay.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  } else {
    // 通常の流れるコメント
    const lane = findAvailableLane();
    const topPercent = (lane / LANE_COUNT) * 80 + 5;
    el.style.top = topPercent + '%';
    el.style.left = '100%';
    lanes[lane] = Date.now() + COMMENT_DURATION * 0.4;
    overlay.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  }
}

// 現在の装飾設定
const commentStyle = { color: null, position: null, size: null };

// コメント投稿（装飾設定を適用）
function postUserComment(text) {
  myPostedComments.add(text);
  // サイズ上限（音声入力の長時間セッションで肥大化を防止）
  if (myPostedComments.size > 100) {
    const arr = Array.from(myPostedComments);
    myPostedComments.clear();
    for (let i = 50; i < arr.length; i++) myPostedComments.add(arr[i]);
  }
  const data = { text, isAnonymous: true };
  if (commentStyle.color) data.color = commentStyle.color;
  if (commentStyle.size) data.size = commentStyle.size;
  if (commentStyle.position) data.position = commentStyle.position;
  chrome.runtime.sendMessage({ type: 'postComment', data });
}

// コメント入力欄の作成
function createCommentInput() {
  let bar = document.getElementById('niko-jikkyo-input-bar');
  if (bar) return bar;

  bar = document.createElement('div');
  bar.id = 'niko-jikkyo-input-bar';

  // 装飾バー
  const styleBar = document.createElement('div');
  styleBar.id = 'niko-jikkyo-style-bar';

  // 色ボタン
  const colors = [
    { name: null, label: '白', hex: '#ffffff' },
    { name: 'red', label: '赤', hex: '#ff0000' },
    { name: 'pink', label: '桃', hex: '#ff8080' },
    { name: 'orange', label: '橙', hex: '#ffc000' },
    { name: 'yellow', label: '黄', hex: '#ffff00' },
    { name: 'green', label: '緑', hex: '#00ff00' },
    { name: 'cyan', label: '水', hex: '#00ffff' },
    { name: 'blue', label: '青', hex: '#0000ff' },
    { name: 'purple', label: '紫', hex: '#c000ff' },
  ];
  const colorGroup = document.createElement('div');
  colorGroup.className = 'niko-style-group';
  for (const c of colors) {
    const btn = document.createElement('button');
    btn.className = 'niko-color-btn' + (c.name === null ? ' active' : '');
    btn.style.background = c.hex;
    btn.title = c.label;
    btn.addEventListener('click', () => {
      commentStyle.color = c.name;
      colorGroup.querySelectorAll('.niko-color-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    colorGroup.appendChild(btn);
  }
  styleBar.appendChild(colorGroup);

  // 位置ボタン
  const positions = [
    { name: null, label: '流', premium: false },
    { name: 'ue', label: '上', premium: true },
    { name: 'shita', label: '下', premium: true },
  ];
  const posGroup = document.createElement('div');
  posGroup.className = 'niko-style-group';
  for (const p of positions) {
    const btn = document.createElement('button');
    btn.className = 'niko-style-btn' + (p.name === null ? ' active' : '');
    btn.textContent = p.label;
    if (p.premium) {
      btn.disabled = !isPremiumUser;
      btn.title = isPremiumUser ? '' : 'プレミアム会員限定';
      premiumPosBtns.push(btn);
    }
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      commentStyle.position = p.name;
      posGroup.querySelectorAll('.niko-style-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    posGroup.appendChild(btn);
  }
  styleBar.appendChild(posGroup);

  // サイズボタン
  const sizes = [
    { name: null, label: '中' },
    { name: 'big', label: '大' },
    { name: 'small', label: '小' },
  ];
  const sizeGroup = document.createElement('div');
  sizeGroup.className = 'niko-style-group';
  for (const s of sizes) {
    const btn = document.createElement('button');
    btn.className = 'niko-style-btn' + (s.name === null ? ' active' : '');
    btn.textContent = s.label;
    btn.addEventListener('click', () => {
      commentStyle.size = s.name;
      sizeGroup.querySelectorAll('.niko-style-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    sizeGroup.appendChild(btn);
  }
  styleBar.appendChild(sizeGroup);

  bar.appendChild(styleBar);

  // テキスト入力
  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'niko-jikkyo-input';
  input.placeholder = DEFAULT_PLACEHOLDER;
  input.maxLength = 75;

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing && input.value.trim()) {
      postUserComment(input.value.trim());
      input.value = '';
    }
  });

  input.addEventListener('keyup', (e) => e.stopPropagation());
  input.addEventListener('keypress', (e) => e.stopPropagation());

  // Netflixが自動でフォーカスを奪うのを阻止
  let userTyping = false;
  let userClicked = false;
  let lastFocusedInput = null; // 最後にフォーカスしていたniko入力要素
  document.addEventListener('mousedown', () => { userClicked = true; }, true);
  document.addEventListener('mouseup', () => {
    setTimeout(() => { userClicked = false; }, 100);
  }, true);
  // niko入力要素（コメント欄・AI入力欄・AI編集欄）のフォーカスを追跡
  bar.addEventListener('focusin', (e) => {
    if (e.target.matches('input, textarea, select')) {
      userTyping = true;
      lastFocusedInput = e.target;
    }
  });
  // Netflix側の要素がフォーカスを受け取る瞬間に横取り
  document.addEventListener('focusin', (e) => {
    if (!userTyping || userClicked) return;
    // niko入力バー内の要素なら許可
    if (bar.contains(e.target)) return;
    if (lastFocusedInput) {
      e.target.blur();
      lastFocusedInput.focus();
    }
  }, true);
  bar.addEventListener('focusout', (e) => {
    if (userClicked) userTyping = false;
  });
  // Escキーで明示的にフォーカスを外す
  bar.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      userTyping = false;
      if (lastFocusedInput) lastFocusedInput.blur();
    }
  });

  const inputRow = document.createElement('div');
  inputRow.id = 'niko-jikkyo-input-row';
  inputRow.appendChild(input);

  // マイクボタン（音声入力）
  const micBtn = document.createElement('button');
  micBtn.id = 'niko-jikkyo-mic-btn';
  micBtn.innerHTML = MIC_SVG + ' 音声';

  // 音声モード切替（自動投稿 / 手動入力）
  const voiceModeBtn = document.createElement('button');
  voiceModeBtn.id = 'niko-jikkyo-voice-mode';
  voiceModeBtn.textContent = '自動';
  voiceModeBtn.title = '自動投稿: 発話完了時に自動でコメント投稿';
  voiceModeBtn.addEventListener('click', () => {
    voiceAutoPost = !voiceAutoPost;
    voiceModeBtn.textContent = voiceAutoPost ? '自動' : '手動';
    voiceModeBtn.title = voiceAutoPost
      ? '自動投稿: 発話完了時に自動でコメント投稿'
      : '手動入力: 入力欄にテキストを入力（Enterで送信）';
    voiceModeBtn.classList.toggle('manual', !voiceAutoPost);
  });

  micBtn.addEventListener('click', async () => {
    voiceActive = !voiceActive;
    if (voiceActive) {
      try {
        // マイクキャプチャ
        voiceMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        voiceAudioContext = new AudioContext({ sampleRate: 16000 });
        const source = voiceAudioContext.createMediaStreamSource(voiceMediaStream);
        voiceScriptProcessor = voiceAudioContext.createScriptProcessor(4096, 1, 1);
        source.connect(voiceScriptProcessor);
        voiceScriptProcessor.connect(voiceAudioContext.destination);

        // Deepgram API Key を取得してREST APIバッチ送信を開始
        const stored = await chrome.storage.local.get(['deepgramApiKey']);
        if (!stored.deepgramApiKey) {
          voiceActive = false;
          stopVoiceAudio();
          voiceShowError('Deepgram API Keyが未設定です。ポップアップで設定してください。');
          return;
        }

        startVoiceBatchSend(stored.deepgramApiKey);

        // PCM データをバッファに蓄積（定期的にREST APIへ送信）
        voiceScriptProcessor.onaudioprocess = (e) => {
          if (!voiceActive) return;
          const float32 = e.inputBuffer.getChannelData(0);
          const int16 = new Int16Array(float32.length);
          for (let i = 0; i < float32.length; i++) {
            const s = Math.max(-1, Math.min(1, float32[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }
          voiceAudioChunks.push(int16);
        };

        micBtn.classList.add('active');
        micBtn.innerHTML = MIC_SVG_OFF + ' 停止';
        voiceModeBtn.style.display = '';
      } catch (err) {
        console.warn('[niko-voice] getUserMedia failed:', err.name, err.message);
        voiceActive = false;
        stopVoiceAudio();
        voiceShowError(err.name === 'NotAllowedError'
          ? 'マイクへのアクセスが拒否されました'
          : 'マイクエラー: ' + err.message);
      }
    } else {
      // 停止
      stopVoiceAudio();
      micBtn.classList.remove('active');
      micBtn.innerHTML = MIC_SVG + ' 音声';
      voiceModeBtn.style.display = 'none';
      input.placeholder = DEFAULT_PLACEHOLDER;
      input.value = '';
    }
  });
  inputRow.appendChild(micBtn);
  voiceModeBtn.style.display = 'none';
  inputRow.appendChild(voiceModeBtn);

  // AIボタン
  const aiBtn = document.createElement('button');
  aiBtn.id = 'niko-jikkyo-ai-btn';
  aiBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg> AI';
  aiBtn.addEventListener('click', () => {
    const panel = document.getElementById('niko-jikkyo-ai-panel');
    if (panel) panel.classList.toggle('open');
  });
  inputRow.appendChild(aiBtn);

  // 概要ボタン
  const summaryBtn = document.createElement('button');
  summaryBtn.id = 'niko-jikkyo-summary-btn';
  summaryBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> 実況';
  summaryBtn.addEventListener('click', () => {
    const panel = document.getElementById('niko-jikkyo-summary-panel');
    if (panel) {
      panel.classList.toggle('open');
      // 開いた時にユーザー一覧とグラフを取得
      if (panel.classList.contains('open')) {
        chrome.runtime.sendMessage({ type: 'getUserList' }).catch(() => {});
        chrome.runtime.sendMessage({ type: 'getCommentGraph' }).catch(() => {});
      }
    }
  });
  inputRow.appendChild(summaryBtn);

  // コメント非表示トグルボタン
  const nikoSvgEye = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const nikoSvgEyeOff = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>';
  const toggleBtn = document.createElement('button');
  toggleBtn.id = 'niko-jikkyo-toggle';
  toggleBtn.innerHTML = nikoSvgEye + ' 非表示';
  toggleBtn.addEventListener('click', () => {
    commentsHidden = !commentsHidden;
    toggleBtn.innerHTML = commentsHidden ? (nikoSvgEyeOff + ' 表示') : (nikoSvgEye + ' 非表示');
    toggleBtn.classList.toggle('active', commentsHidden);
    const overlay = document.getElementById('niko-jikkyo-overlay');
    if (overlay) overlay.style.visibility = commentsHidden ? 'hidden' : 'visible';
  });
  inputRow.appendChild(toggleBtn);
  bar.appendChild(inputRow);

  // AIパネル
  const aiPanel = document.createElement('div');
  aiPanel.id = 'niko-jikkyo-ai-panel';
  aiPanel.innerHTML = `
    <div class="niko-ai-row">
      <label>方式:</label>
      <select id="niko-ai-mode">
        <option value="normal">通常コメント</option>
        <option value="webSearch">Web検索コメント</option>
        <option value="shitaCA" disabled>下積みコメントアート（プレミアム）</option>
      </select>
    </div>
    <div class="niko-ai-row">
      <input type="text" id="niko-ai-prompt" placeholder="依頼を入力（例: 野球のAAを作って）" maxlength="200">
      <button id="niko-ai-generate">生成</button>
    </div>
    <div id="niko-ai-preview-area" style="display:none;">
      <div class="niko-ai-label">プレビュー</div>
      <pre id="niko-ai-preview"></pre>
      <textarea id="niko-ai-edit" style="display:none;"></textarea>
      <div class="niko-ai-actions">
        <button id="niko-ai-edit-btn">編集</button>
        <button id="niko-ai-post-btn">投稿</button>
      </div>
    </div>
    <div id="niko-ai-status"></div>
  `;
  bar.appendChild(aiPanel);

  // 右サイドパネル（概要 + ユーザー一覧を同時表示）
  const summaryPanel = document.createElement('div');
  summaryPanel.id = 'niko-jikkyo-summary-panel';
  summaryPanel.innerHTML = `
    <div class="niko-side-header">
      <span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>DASHBOARD</span>
      <div class="niko-summary-auto">
        <label><input type="checkbox" id="niko-summary-auto-toggle"> 自動更新</label>
      </div>
    </div>
    <div class="niko-side-section niko-graph-section">
      <div class="niko-side-section-title">Comment Graph</div>
      <div class="niko-graph-container">
        <canvas id="niko-comment-graph" width="288" height="60"></canvas>
        <div id="niko-graph-tooltip" class="niko-graph-tooltip" style="display:none;"></div>
      </div>
    </div>
    <div class="niko-side-section">
      <div class="niko-side-section-title">AI Summary</div>
      <div id="niko-summary-content" style="display:none;">
        <pre id="niko-summary-text"></pre>
      </div>
      <div id="niko-summary-status">「自動更新」ONで3分間隔で更新</div>
    </div>
    <div class="niko-side-section niko-side-section-grow">
      <div class="niko-side-section-title">Users</div>
      <div id="niko-user-list"></div>
      <div id="niko-user-status"></div>
    </div>
  `;
  // input-barではなくbodyに直接追加（サイドパネルは独立配置）
  document.body.appendChild(summaryPanel);

  // サイドパネル内のキーイベントがNetflixに伝播しないようにする
  summaryPanel.addEventListener('keydown', (e) => e.stopPropagation());
  summaryPanel.addEventListener('keyup', (e) => e.stopPropagation());
  summaryPanel.addEventListener('keypress', (e) => e.stopPropagation());

  // 自動更新トグル
  const autoToggle = summaryPanel.querySelector('#niko-summary-auto-toggle');
  autoToggle.addEventListener('change', () => {
    chrome.runtime.sendMessage({ type: 'toggleAutoSummary', enabled: autoToggle.checked });
    const status = document.getElementById('niko-summary-status');
    if (autoToggle.checked) {
      if (status) {
        status.innerHTML = '<span class="niko-ai-loading"></span> コメントを分析中...';
        status.style.color = '#00bcd4';
      }
    } else {
      if (status) {
        status.textContent = '自動更新を停止しました';
        status.style.color = '#888';
      }
    }
  });

  // ユーザー一覧の定期更新（10秒間隔、パネルが開いている時のみ）
  let userListTimer = null;
  function startUserListUpdate() {
    if (userListTimer) return;
    userListTimer = setInterval(() => {
      if (summaryPanel.classList.contains('open')) {
        chrome.runtime.sendMessage({ type: 'getUserList' }).catch(() => {});
      }
    }, 10000);
  }
  startUserListUpdate();

  // コメントグラフの定期更新（5秒間隔）
  setInterval(() => {
    if (summaryPanel.classList.contains('open')) {
      chrome.runtime.sendMessage({ type: 'getCommentGraph' }).catch(() => {});
    }
  }, 5000);
  // 初回取得
  setTimeout(() => chrome.runtime.sendMessage({ type: 'getCommentGraph' }).catch(() => {}), 500);

  // 概要履歴の定期取得（グラフホバー用、30秒間隔）
  setInterval(() => {
    if (summaryPanel.classList.contains('open')) {
      chrome.runtime.sendMessage({ type: 'getSummaryHistory' }).catch(() => {});
    }
  }, 30000);
  setTimeout(() => chrome.runtime.sendMessage({ type: 'getSummaryHistory' }).catch(() => {}), 1000);

  // グラフホバーでAI概要ツールチップ表示
  const graphCanvas = summaryPanel.querySelector('#niko-comment-graph');
  const graphTooltip = summaryPanel.querySelector('#niko-graph-tooltip');
  if (graphCanvas && graphTooltip) {
    const GRAPH_DURATION = 10 * 60 * 1000; // 10分
    graphCanvas.addEventListener('mousemove', (e) => {
      const rect = graphCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const ratio = x / rect.width;
      // 0=10分前, 1=now
      const hoverTime = Date.now() - GRAPH_DURATION * (1 - ratio);
      // 最も近い概要を探す
      let closest = null;
      let minDist = Infinity;
      for (const s of summaryHistoryCache) {
        const dist = Math.abs(s.time - hoverTime);
        if (dist < minDist) { minDist = dist; closest = s; }
      }
      if (closest && minDist < 5 * 60 * 1000) { // 5分以内
        const ago = Math.round((Date.now() - closest.time) / 60000);
        const agoStr = ago <= 0 ? '直近' : `${ago}分前`;
        graphTooltip.textContent = `${agoStr}の雰囲気:\n${closest.text}`;
        graphTooltip.style.display = 'block';
      } else {
        graphTooltip.style.display = 'none';
      }
    });
    graphCanvas.addEventListener('mouseleave', () => {
      graphTooltip.style.display = 'none';
    });
  }

  // AIパネルのイベント
  const aiPromptInput = aiPanel.querySelector('#niko-ai-prompt');
  const aiGenerateBtn = aiPanel.querySelector('#niko-ai-generate');
  const aiPreviewArea = aiPanel.querySelector('#niko-ai-preview-area');
  const aiPreview = aiPanel.querySelector('#niko-ai-preview');
  const aiEditArea = aiPanel.querySelector('#niko-ai-edit');
  const aiEditBtn = aiPanel.querySelector('#niko-ai-edit-btn');
  const aiPostBtn = aiPanel.querySelector('#niko-ai-post-btn');
  const aiModeSelect = aiPanel.querySelector('#niko-ai-mode');
  const aiStatus = aiPanel.querySelector('#niko-ai-status');

  // AIパネル内のキーイベントがNetflixに伝播しないようにする
  aiPanel.addEventListener('keydown', (e) => e.stopPropagation());
  aiPanel.addEventListener('keyup', (e) => e.stopPropagation());
  aiPanel.addEventListener('keypress', (e) => e.stopPropagation());

  aiGenerateBtn.addEventListener('click', () => {
    // キャンセル処理
    if (aiGenerating) {
      chrome.runtime.sendMessage({ type: 'cancelAiComment' });
      aiGenerating = false;
      aiGenerateBtn.textContent = '生成';
      aiGenerateBtn.classList.remove('niko-ai-cancel');
      aiStatus.textContent = 'キャンセルしました';
      aiStatus.style.color = '#888';
      setTimeout(() => { aiStatus.textContent = ''; }, 2000);
      return;
    }

    const userPrompt = aiPromptInput.value.trim();
    if (!userPrompt) return;

    aiGenerating = true;
    const isWebSearch = aiModeSelect.value === 'webSearch';
    aiStatus.innerHTML = isWebSearch
      ? '<span class="niko-ai-loading"></span> Web検索中...'
      : '<span class="niko-ai-loading"></span> AIが思考中...';
    aiStatus.style.color = '#ffcc00';
    aiGenerateBtn.textContent = 'キャンセル';
    aiGenerateBtn.classList.add('niko-ai-cancel');
    aiPreviewArea.style.display = 'none';

    // 直近コメントを収集（表示済みから最新20件）
    const recentTexts = recentRendered.slice(-20).map(c => c.text).join('\n');

    const msgData = {
      mode: aiModeSelect.value,
      userPrompt: userPrompt,
      recentComments: recentTexts
    };

    chrome.runtime.sendMessage({
      type: 'generateAiComment',
      data: msgData
    });
  });

  // Enter で生成
  aiPromptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      aiGenerateBtn.click();
    }
  });

  // 編集ボタン
  aiEditBtn.addEventListener('click', () => {
    aiIsEditing = !aiIsEditing;
    if (aiIsEditing) {
      aiEditArea.value = aiGeneratedText;
      aiEditArea.style.display = 'block';
      aiPreview.style.display = 'none';
      aiEditBtn.textContent = 'プレビュー';
    } else {
      aiGeneratedText = aiEditArea.value;
      aiPreview.textContent = aiGeneratedText;
      aiEditArea.style.display = 'none';
      aiPreview.style.display = 'block';
      aiEditBtn.textContent = '編集';
    }
  });

  // 投稿ボタン
  aiPostBtn.addEventListener('click', () => {
    const text = aiIsEditing ? aiEditArea.value.trim() : aiGeneratedText;
    if (!text) return;

    const mode = aiModeSelect.value;
    if (mode === 'shitaCA') {
      // 下積みCA: 各行をshitaコメントとして100ms間隔で連続送信
      const lines = text.split('\n').filter(l => l.replace(/[\s\u3000]/g, '').length > 0).reverse();
      lines.forEach((line, i) => {
        setTimeout(() => {
          myPostedComments.add(line);
          chrome.runtime.sendMessage({
            type: 'postComment',
            data: { text: line, isAnonymous: true, position: 'shita' }
          });
        }, i * 100);
      });
      aiStatus.textContent = `${lines.length}行を投稿しました`;
      aiStatus.style.color = '#00ff66';
    } else {
      // 通常コメント
      myPostedComments.add(text);
      chrome.runtime.sendMessage({
        type: 'postComment',
        data: { text, isAnonymous: true }
      });
      aiStatus.textContent = '投稿しました';
      aiStatus.style.color = '#00ff66';
    }
    setTimeout(() => { aiStatus.textContent = ''; }, 3000);
  });

  document.body.appendChild(bar);
  return bar;
}

createCommentInput();

// ストレージからプレミアム情報を復元
chrome.storage.local.get(['isPremium'], (result) => {
  if (result.isPremium) {
    isPremiumUser = true;
    premiumPosBtns.forEach(btn => { btn.disabled = false; btn.title = ''; });
    const shitaOption = document.querySelector('#niko-ai-mode option[value="shitaCA"]');
    if (shitaOption) { shitaOption.disabled = false; shitaOption.textContent = '下積みコメントアート'; }
  }
});

// backgroundからのコメント受信（port接続方式）
const port = chrome.runtime.connect({ name: 'niko-jikkyo' });
port.onMessage.addListener((msg) => {
  // プレミアム情報
  if (msg.type === 'premiumStatus') {
    isPremiumUser = msg.isPremium;
    // 位置ボタン（上/下）の有効化
    premiumPosBtns.forEach(btn => {
      btn.disabled = !isPremiumUser;
      btn.title = isPremiumUser ? '' : 'プレミアム会員限定';
    });
    // AIパネルのプレミアム限定モード
    const shitaOption = document.querySelector('#niko-ai-mode option[value="shitaCA"]');
    if (shitaOption) {
      shitaOption.disabled = !isPremiumUser;
      shitaOption.textContent = isPremiumUser ? '下積みコメントアート' : '下積みコメントアート（プレミアム）';
    }
    return;
  }
  // 投稿結果
  if (msg.type === 'postCommentResult') {
    if (msg.data.error) {
      const input = document.getElementById('niko-jikkyo-input');
      if (input) {
        input.placeholder = 'ニコニコにログインすると投稿できます';
        input.disabled = true;
        setTimeout(() => {
          input.placeholder = DEFAULT_PLACEHOLDER;
          input.disabled = false;
        }, 3000);
      }
    }
    return;
  }
  // AI生成結果
  if (msg.type === 'aiCommentResult') {
    const generateBtn = document.getElementById('niko-ai-generate');
    const previewArea = document.getElementById('niko-ai-preview-area');
    const preview = document.getElementById('niko-ai-preview');
    const editArea = document.getElementById('niko-ai-edit');
    const editBtn = document.getElementById('niko-ai-edit-btn');
    const status = document.getElementById('niko-ai-status');
    aiGenerating = false;
    if (generateBtn) {
      generateBtn.textContent = '生成';
      generateBtn.classList.remove('niko-ai-cancel');
    }

    if (msg.data.cancelled) return;

    if (msg.data.error) {
      if (status) {
        status.textContent = msg.data.error;
        status.style.color = '#ff4444';
      }
      return;
    }

    // プレビューに表示（空白のみの行を除去）
    if (preview && previewArea && status) {
      const cleaned = msg.data.text.split('\n')
        .filter(line => line.replace(/[\s\u3000]/g, '').length > 0)
        .join('\n');
      if (!cleaned) {
        status.textContent = '生成に失敗しました。もう一度お試しください。';
        status.style.color = '#ff4444';
        return;
      }
      aiGeneratedText = cleaned;
      aiIsEditing = false;
      preview.textContent = cleaned;
      preview.style.display = 'block';
      if (editArea) editArea.style.display = 'none';
      if (editBtn) editBtn.textContent = '編集';
      previewArea.style.display = 'block';
      status.textContent = '';
    }
    return;
  }
  // 概要生成中ステータス
  if (msg.type === 'summaryStatus') {
    const status = document.getElementById('niko-summary-status');
    if (status && msg.data === 'generating') {
      status.innerHTML = '<span class="niko-ai-loading"></span> コメントを分析中...';
      status.style.color = '#00bcd4';
    }
    return;
  }
  // 概要結果（自動更新 or 手動）
  if (msg.type === 'summaryResult') {
    const content = document.getElementById('niko-summary-content');
    const textEl = document.getElementById('niko-summary-text');
    const status = document.getElementById('niko-summary-status');
    if (msg.data.cancelled) return;
    if (msg.data.error) {
      if (status) { status.textContent = msg.data.error; status.style.color = '#ff4444'; }
      return;
    }
    if (textEl && content && status) {
      textEl.textContent = msg.data.text;
      content.style.display = 'block';
      const now = new Date();
      const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
      status.textContent = `${timeStr} 更新 | ${msg.data.commentCount || 0}件のコメントを分析`;
      status.style.color = '#00bcd4';
    }
    return;
  }
  // 概要履歴結果
  if (msg.type === 'summaryHistoryResult') {
    summaryHistoryCache = msg.data || [];
    return;
  }
  // コメントグラフ結果
  if (msg.type === 'commentGraphResult') {
    drawCommentGraph(msg.data);
    return;
  }
  // ユーザー一覧結果
  if (msg.type === 'userListResult') {
    const listEl = document.getElementById('niko-user-list');
    const statusEl = document.getElementById('niko-user-status');
    if (!listEl) return;
    const { users, totalComments } = msg.data;
    if (!users || users.length === 0) {
      listEl.innerHTML = '<div class="niko-user-empty">コメントがありません</div>';
      if (statusEl) statusEl.textContent = '';
      return;
    }
    const now = Date.now();
    let html = '';
    for (const u of users.slice(0, 20)) {
      const uid = u.userId.replace('a:', '').substring(0, 8);
      const agoSec = Math.round((now - u.lastTime) / 1000);
      const agoStr = agoSec >= 60 ? `${Math.floor(agoSec / 60)}分前` : `${agoSec}秒前`;
      const tendencyHtml = u.tendency
        ? `<span class="niko-user-tendency">${escapeHtml(u.tendency)}</span>` : '';
      const latestComment = u.comments[u.comments.length - 1] || '';
      html += `<div class="niko-user-row">
        <div class="niko-user-info niko-user-toggle" data-uid="${escapeHtml(uid)}">
          <span class="niko-user-id">${uid}</span>
          <span class="niko-user-count">${u.count}件</span>
          ${tendencyHtml}
          <span class="niko-user-ago">${agoStr}</span>
        </div>
        <div class="niko-user-latest">
          <div class="niko-user-comment">${escapeHtml(latestComment)}</div>
        </div>
        <div class="niko-user-all-comments" style="display:none;">`;
      // 全コメントを表示（最新が上）
      for (let i = u.comments.length - 1; i >= 0; i--) {
        html += `<div class="niko-user-comment">${escapeHtml(u.comments[i])}</div>`;
      }
      html += `</div></div>`;
    }
    listEl.innerHTML = html;
    // ユーザー名クリックでコメント一覧を展開/折りたたみ
    listEl.querySelectorAll('.niko-user-toggle').forEach(el => {
      el.addEventListener('click', () => {
        const row = el.closest('.niko-user-row');
        const latest = row.querySelector('.niko-user-latest');
        const all = row.querySelector('.niko-user-all-comments');
        const isOpen = all.style.display !== 'none';
        latest.style.display = isOpen ? '' : 'none';
        all.style.display = isOpen ? 'none' : '';
        row.classList.toggle('niko-user-expanded', !isOpen);
      });
    });
    if (statusEl) {
      statusEl.textContent = `${users.length}人 / ${totalComments}コメント（直近5分間）`;
      statusEl.style.color = '#00bcd4';
    }
    return;
  }
  // 通常のコメント表示
  renderComment(msg);
});

} // end of guard
