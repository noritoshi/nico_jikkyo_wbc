// content_script.js — Netflix上にコメントオーバーレイを描画

// 二重注入ガード
if (window.__nikoJikkyoLoaded) { /* already loaded */ } else {
window.__nikoJikkyoLoaded = true;

let commentsHidden = false;
let aiGeneratedText = '';
let aiIsEditing = false;
let aiGenerating = false;
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

  // Netflixが自動でフォーカスを奪うのを阻止
  let userTyping = false;
  let userClicked = false;
  document.addEventListener('mousedown', () => { userClicked = true; }, true);
  document.addEventListener('mouseup', () => {
    setTimeout(() => { userClicked = false; }, 100);
  }, true);
  input.addEventListener('focus', () => { userTyping = true; });
  // Netflix側の要素がフォーカスを受け取る瞬間に横取り
  document.addEventListener('focusin', (e) => {
    if (!userTyping || userClicked) return;
    // AIパネル内の要素にフォーカスが移る場合は許可
    const aiPanel = document.getElementById('niko-jikkyo-ai-panel');
    if (aiPanel && aiPanel.contains(e.target)) return;
    if (e.target !== input) {
      e.target.blur();
      input.focus();
    }
  }, true);
  input.addEventListener('blur', () => {
    if (userClicked) userTyping = false;
  });
  // Escキーで明示的にフォーカスを外す
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      userTyping = false;
      input.blur();
    }
  });

  const inputRow = document.createElement('div');
  inputRow.id = 'niko-jikkyo-input-row';
  inputRow.appendChild(input);

  // AIボタン
  const aiBtn = document.createElement('button');
  aiBtn.id = 'niko-jikkyo-ai-btn';
  aiBtn.textContent = 'AI';
  aiBtn.addEventListener('click', () => {
    const panel = document.getElementById('niko-jikkyo-ai-panel');
    if (panel) panel.classList.toggle('open');
  });
  inputRow.appendChild(aiBtn);

  // コメント非表示トグルボタン
  const toggleBtn = document.createElement('button');
  toggleBtn.id = 'niko-jikkyo-toggle';
  toggleBtn.textContent = '非表示';
  toggleBtn.addEventListener('click', () => {
    commentsHidden = !commentsHidden;
    toggleBtn.textContent = commentsHidden ? '表示' : '非表示';
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
        <option value="shitaCA">下積みCA</option>
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
    aiStatus.innerHTML = '<span class="niko-ai-loading"></span> AIが思考中...';
    aiStatus.style.color = '#ffcc00';
    aiGenerateBtn.textContent = 'キャンセル';
    aiGenerateBtn.classList.add('niko-ai-cancel');
    aiPreviewArea.style.display = 'none';

    // 直近コメントを収集（表示済みから最新20件）
    const recentTexts = recentRendered.slice(-20).map(c => c.text).join('\n');

    chrome.runtime.sendMessage({
      type: 'generateAiComment',
      data: {
        mode: aiModeSelect.value,
        userPrompt: userPrompt,
        recentComments: recentTexts
      }
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
      const lines = text.split('\n').filter(l => l.length > 0);
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

    // プレビューに表示
    if (preview && previewArea && status) {
      aiGeneratedText = msg.data.text;
      aiIsEditing = false;
      preview.textContent = msg.data.text;
      preview.style.display = 'block';
      if (editArea) editArea.style.display = 'none';
      if (editBtn) editBtn.textContent = '編集';
      previewArea.style.display = 'block';
      status.textContent = '';
    }
    return;
  }
  // 通常のコメント表示
  renderComment(msg);
});

} // end of guard
