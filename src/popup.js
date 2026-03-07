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

// Gemini API Key
const apiKeyInput = document.getElementById('gemini-api-key');
const btnSaveKey = document.getElementById('btn-save-key');
const keyStatus = document.getElementById('key-status');

chrome.storage.local.get(['geminiApiKey'], (result) => {
  if (result.geminiApiKey) {
    apiKeyInput.value = result.geminiApiKey;
    keyStatus.textContent = '保存済み';
    keyStatus.style.color = '#00ff66';
  }
});

btnSaveKey.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    chrome.storage.local.remove('geminiApiKey');
    keyStatus.textContent = '削除しました';
    keyStatus.style.color = '#888';
  } else {
    chrome.storage.local.set({ geminiApiKey: key });
    keyStatus.textContent = '保存しました';
    keyStatus.style.color = '#00ff66';
  }
  setTimeout(() => { keyStatus.textContent = key ? '保存済み' : ''; }, 2000);
});
