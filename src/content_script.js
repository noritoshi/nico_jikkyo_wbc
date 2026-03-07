// content_script.js — Netflix上にコメントオーバーレイを描画

// 二重注入ガード
if (window.__nikoJikkyoLoaded) { /* already loaded */ } else {
window.__nikoJikkyoLoaded = true;

const LANE_COUNT = 12;
const myPostedComments = new Set(); // 自分が投稿したコメントテキスト
const recentRendered = []; // 表示済みコメント（重複排除用）
const COMMENT_DURATION = 7000; // ms
const lanes = new Array(LANE_COUNT).fill(0); // 各レーンの解放時刻

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

  const position = getPositionFromMail(mail);

  if (position === 'ue' || position === 'shita') {
    // 上固定・下固定コメント
    el.classList.add('niko-comment-fixed');
    if (position === 'ue') {
      el.style.top = '5%';
    } else {
      el.style.bottom = '15%';
      el.style.top = 'auto';
    }
    el.style.left = '50%';
    el.style.transform = 'translateX(-50%)';
    el.style.animation = 'niko-fade 5s linear forwards';
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
    { name: null, label: '流' },
    { name: 'ue', label: '上' },
    { name: 'shita', label: '下' },
  ];
  const posGroup = document.createElement('div');
  posGroup.className = 'niko-style-group';
  for (const p of positions) {
    const btn = document.createElement('button');
    btn.className = 'niko-style-btn' + (p.name === null ? ' active' : '');
    btn.textContent = p.label;
    btn.addEventListener('click', () => {
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
  input.placeholder = 'コメントを入力（Enter で送信）';
  input.maxLength = 75;

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing && input.value.trim()) {
      const text = input.value.trim();
      myPostedComments.add(text);
      const data = { text, isAnonymous: true };
      if (commentStyle.color) data.color = commentStyle.color;
      if (commentStyle.size) data.size = commentStyle.size;
      if (commentStyle.position) data.position = commentStyle.position;
      chrome.runtime.sendMessage({ type: 'postComment', data });
      input.value = '';
    }
  });

  input.addEventListener('keyup', (e) => e.stopPropagation());
  input.addEventListener('keypress', (e) => e.stopPropagation());

  bar.appendChild(input);
  document.body.appendChild(bar);
  return bar;
}

createCommentInput();

// backgroundからのコメント受信（port接続方式）
const port = chrome.runtime.connect({ name: 'niko-jikkyo' });
port.onMessage.addListener((msg) => {
  // 投稿結果
  if (msg.type === 'postCommentResult') {
    if (msg.data.error) {
      const input = document.getElementById('niko-jikkyo-input');
      if (input) {
        input.placeholder = 'ニコニコにログインすると投稿できます';
        input.disabled = true;
        setTimeout(() => {
          input.placeholder = 'コメントを入力（Enter で送信）';
          input.disabled = false;
        }, 3000);
      }
    }
    return;
  }
  // 通常のコメント表示
  renderComment(msg);
});

} // end of guard
