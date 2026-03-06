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
