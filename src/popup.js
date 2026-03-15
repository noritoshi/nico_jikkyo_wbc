// popup.js — チャンネルID入力と接続制御

const channelInput = document.getElementById('channel-id');
const btnConnect = document.getElementById('btn-connect');
const btnDisconnect = document.getElementById('btn-disconnect');
const statusEl = document.getElementById('status');

const STATUS_TEXT = {
  disconnected: '未接続',
  connecting: '接続中...',
  connected: '接続済み',
  error: 'エラー'
};

function updateUI(status, errorMsg) {
  statusEl.className = 'status ' + status;
  statusEl.textContent = errorMsg
    ? `${STATUS_TEXT[status] || status}: ${errorMsg}`
    : (STATUS_TEXT[status] || status);

  btnConnect.disabled = status === 'connecting' || status === 'connected';
  btnDisconnect.disabled = status === 'disconnected' || status === 'error';
  channelInput.disabled = status === 'connecting' || status === 'connected';
}

// 前回のチャンネルIDを復元
chrome.storage.local.get(['lastChannel'], (result) => {
  if (result.lastChannel) {
    channelInput.value = result.lastChannel;
  }
});

// 現在のステータスを取得
chrome.runtime.sendMessage({ type: 'popup_getStatus' }, (res) => {
  if (res && res.status) {
    updateUI(res.status);
  }
});

// 接続ボタン
btnConnect.addEventListener('click', () => {
  const channelId = channelInput.value.trim();
  if (!channelId) return;

  updateUI('connecting');
  chrome.runtime.sendMessage({
    type: 'popup_connect',
    channelId: channelId
  });
});

// 切断ボタン
btnDisconnect.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'popup_disconnect' });
  updateUI('disconnected');
});

// ステータス更新を受信
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'statusUpdate') {
    updateUI(msg.data.status, msg.data.error);
  }
});

// API Key セクションの初期化（共通ヘルパー）
function setupApiKeySection(inputId, btnId, statusId, storageKey) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  const status = document.getElementById(statusId);

  chrome.storage.local.get([storageKey], (result) => {
    if (result[storageKey]) {
      input.value = result[storageKey];
      status.textContent = '保存済み';
      status.style.color = '#00ff66';
    }
  });

  btn.addEventListener('click', () => {
    const key = input.value.trim();
    if (!key) {
      chrome.storage.local.remove(storageKey);
      status.textContent = '削除しました';
      status.style.color = '#888';
    } else {
      chrome.storage.local.set({ [storageKey]: key });
      status.textContent = '保存しました';
      status.style.color = '#00ff66';
    }
    setTimeout(() => { status.textContent = key ? '保存済み' : ''; }, 2000);
  });
}

setupApiKeySection('gemini-api-key', 'btn-save-key', 'key-status', 'geminiApiKey');
setupApiKeySection('deepgram-api-key', 'btn-save-dg-key', 'dg-key-status', 'deepgramApiKey');

// 音声認識キーワード（選手名取得）
const teamAInput = document.getElementById('team-a');
const teamBInput = document.getElementById('team-b');
const btnFetch = document.getElementById('btn-fetch-keyterms');
const btnClear = document.getElementById('btn-clear-keyterms');
const keytermStatus = document.getElementById('keyterm-status');
const keytermList = document.getElementById('keyterm-list');

// 野球用語（baseKeytermsと同じリスト — タグ表示の色分け用）
const BASE_KEYTERMS = new Set([
  'ホームラン', 'ツーベース', 'スリーベース', 'フォアボール', 'デッドボール',
  '三振', 'ダブルプレー', 'ゲッツー', 'ファインプレー', '犠牲フライ', '盗塁',
  'ストレート', 'フォーク', 'スライダー', 'カーブ', 'チェンジアップ',
  'WBC', '侍ジャパン',
]);

function renderKeyterms(keyterms, customKeyterms) {
  if ((!keyterms || keyterms.length === 0) && (!customKeyterms || customKeyterms.length === 0)) {
    keytermList.innerHTML = '';
    btnClear.style.display = 'none';
    return;
  }
  btnClear.style.display = '';
  const customSet = new Set(customKeyterms || []);
  const all = keyterms || [];
  keytermList.innerHTML = all.map(kt => {
    const isCustom = customSet.has(kt);
    const cls = isCustom ? 'keyterm-tag custom' : BASE_KEYTERMS.has(kt) ? 'keyterm-tag base' : 'keyterm-tag';
    const removeBtn = isCustom ? `<span class="keyterm-remove" data-kt="${kt}">×</span>` : '';
    return `<span class="${cls}">${kt}${removeBtn}</span>`;
  }).join('');
  // 個別削除ハンドラ
  keytermList.querySelectorAll('.keyterm-remove').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const kt = el.dataset.kt;
      removeCustomKeyterm(kt);
    });
  });
}

// 前回の入力を復元
chrome.storage.local.get(['voiceTeamA', 'voiceTeamB', 'voiceKeyterms', 'voiceCustomKeyterms'], (result) => {
  if (result.voiceTeamA) teamAInput.value = result.voiceTeamA;
  if (result.voiceTeamB) teamBInput.value = result.voiceTeamB;
  if (result.voiceKeyterms && result.voiceKeyterms.length > 0) {
    keytermStatus.textContent = `${result.voiceKeyterms.length}件のキーワード設定済み`;
    keytermStatus.style.color = '#00ff66';
    renderKeyterms(result.voiceKeyterms, result.voiceCustomKeyterms);
  }
});

btnFetch.addEventListener('click', () => {
  const teamA = teamAInput.value.trim();
  const teamB = teamBInput.value.trim();
  if (!teamA || !teamB) {
    keytermStatus.textContent = '2チーム名を入力してください';
    keytermStatus.style.color = '#E94560';
    return;
  }

  btnFetch.disabled = true;
  keytermStatus.textContent = 'AIが選手情報を検索中...';
  keytermStatus.style.color = '#FFCC00';
  keytermList.innerHTML = '';

  // チーム名を保存
  chrome.storage.local.set({ voiceTeamA: teamA, voiceTeamB: teamB });

  chrome.runtime.sendMessage({
    type: 'fetchVoiceKeyterms',
    teamA, teamB
  }, (res) => {
    btnFetch.disabled = false;
    if (res && res.error) {
      keytermStatus.textContent = res.error;
      keytermStatus.style.color = '#E94560';
    } else if (res && res.keyterms) {
      keytermStatus.textContent = `${res.keyterms.length}件のキーワードを設定しました`;
      keytermStatus.style.color = '#00ff66';
      chrome.storage.local.get(['voiceCustomKeyterms'], (r) => {
        renderKeyterms(res.keyterms, r.voiceCustomKeyterms);
      });
    }
  });
});

btnClear.addEventListener('click', () => {
  chrome.storage.local.remove(['voiceKeyterms', 'voiceCustomKeyterms']);
  keytermList.innerHTML = '';
  btnClear.style.display = 'none';
  keytermStatus.textContent = 'キーワードをクリアしました';
  keytermStatus.style.color = '#64748B';
  setTimeout(() => { keytermStatus.textContent = ''; }, 2000);
});

// カスタムキーワード追加
const customKeytermInput = document.getElementById('custom-keyterm');
const btnAddKeyterm = document.getElementById('btn-add-keyterm');

function addCustomKeyterm(word) {
  word = word.trim();
  if (!word) return;
  chrome.storage.local.get(['voiceKeyterms', 'voiceCustomKeyterms'], (result) => {
    const keyterms = result.voiceKeyterms || [];
    const custom = result.voiceCustomKeyterms || [];
    if (keyterms.includes(word)) {
      keytermStatus.textContent = `「${word}」は既に登録済みです`;
      keytermStatus.style.color = '#FFCC00';
      setTimeout(() => updateKeytermStatusCount(keyterms.length), 2000);
      return;
    }
    custom.push(word);
    keyterms.push(word);
    chrome.storage.local.set({ voiceKeyterms: keyterms, voiceCustomKeyterms: custom }, () => {
      renderKeyterms(keyterms, custom);
      keytermStatus.textContent = `「${word}」を追加（計${keyterms.length}件）`;
      keytermStatus.style.color = '#00ff66';
    });
  });
}

function removeCustomKeyterm(word) {
  chrome.storage.local.get(['voiceKeyterms', 'voiceCustomKeyterms'], (result) => {
    const keyterms = (result.voiceKeyterms || []).filter(k => k !== word);
    const custom = (result.voiceCustomKeyterms || []).filter(k => k !== word);
    chrome.storage.local.set({ voiceKeyterms: keyterms, voiceCustomKeyterms: custom }, () => {
      renderKeyterms(keyterms, custom);
      updateKeytermStatusCount(keyterms.length);
    });
  });
}

function updateKeytermStatusCount(count) {
  if (count > 0) {
    keytermStatus.textContent = `${count}件のキーワード設定済み`;
    keytermStatus.style.color = '#00ff66';
  } else {
    keytermStatus.textContent = '';
  }
}

btnAddKeyterm.addEventListener('click', () => {
  addCustomKeyterm(customKeytermInput.value);
  customKeytermInput.value = '';
});

customKeytermInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    addCustomKeyterm(customKeytermInput.value);
    customKeytermInput.value = '';
  }
});
