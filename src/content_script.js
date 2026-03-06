// content_script.js — Netflix上にコメントオーバーレイを描画
console.log('[niko-jikkyo] content_script loaded on', location.href);

const LANE_COUNT = 12;
const COMMENT_DURATION = 7000; // ms
const lanes = new Array(LANE_COUNT).fill(0); // 各レーンの解放時刻

// コメント表示: vposベースのdelayに従ってタイミング通りに表示
function enqueueComment(commentData) {
  const delay = commentData.delay || 0;
  if (delay <= 0) {
    renderComment(commentData);
  } else {
    setTimeout(() => renderComment(commentData), delay);
  }
}

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

function renderComment(commentData) {
  const overlay = getOverlay();
  const el = document.createElement('div');
  el.className = 'niko-comment';
  el.textContent = commentData.text;

  const color = getColorFromMail(commentData.mail);
  if (color) el.style.color = color;

  const lane = findAvailableLane();
  const topPercent = (lane / LANE_COUNT) * 80 + 5;
  el.style.top = topPercent + '%';
  el.style.left = '100%';

  lanes[lane] = Date.now() + COMMENT_DURATION * 0.4;

  overlay.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

// backgroundからのメッセージを受信
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'comment') {
    enqueueComment(msg.data);
  }
});
