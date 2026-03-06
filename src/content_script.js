// content_script.js — Netflix上にコメントオーバーレイを描画
console.log('[niko-jikkyo] content_script loaded on', location.href);

const LANE_COUNT = 12;
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
  // 全レーン埋まっている場合は最も早く空くレーンを使う
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

  // 色指定
  const color = getColorFromMail(commentData.mail);
  if (color) el.style.color = color;

  // レーン割り当て
  const lane = findAvailableLane();
  const topPercent = (lane / LANE_COUNT) * 80 + 5; // 5%〜85%の範囲
  el.style.top = topPercent + '%';
  el.style.left = '100%';

  // レーンの使用時刻を記録（コメントが画面中央を通過するまで）
  lanes[lane] = Date.now() + COMMENT_DURATION * 0.4;

  overlay.appendChild(el);

  // アニメーション終了後にDOMから削除
  el.addEventListener('animationend', () => el.remove());
}

// backgroundからのメッセージを受信
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'comment') {
    console.log('[niko-jikkyo] Received comment:', msg.data.text?.substring(0, 30));
    renderComment(msg.data);
  }
});
