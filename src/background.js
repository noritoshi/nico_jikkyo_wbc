// background.js — Service Worker: ニコニコAPIへの接続管理とコメント転送

const DEBUG = false; // デバッグログの有効/無効（リリース時はfalseに戻す）
function debugLog(...args) { if (DEBUG) console.log(...args); }

let currentStatus = 'disconnected';

// offscreenドキュメントの作成
async function ensureOffscreen() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'src/offscreen.html',
    reasons: ['WEB_RTC', 'USER_MEDIA'],
    justification: 'ニコニコ生放送のWebSocket接続およびマイク入力のため'
  });
}

// ニコニコ生放送ページからWebSocket URLを取得
async function fetchWatchData(channelId) {
  const url = `https://live.nicovideo.jp/watch/${channelId}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);

  const html = await res.text();

  // embedded-dataからJSONを取り出す
  const match = html.match(/data-props="([^"]+)"/);
  if (!match) throw new Error('embedded-data not found in page');

  const decoded = match[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  const data = JSON.parse(decoded);
  debugLog('[bg] Parsed embedded data keys:', Object.keys(data));

  // WebSocket URLを探す
  const wsUrl = data.site?.relive?.webSocketUrl
    || data.program?.supplier?.websocketUrl
    || data.site?.websocketUrl;

  const broadcastId = data.program?.nicoliveProgramId
    || data.program?.broadcastId;

  if (!wsUrl) throw new Error('WebSocket URL not found in embedded data');

  const isPremium = data.user?.accountType === 'premium'
    || data.user?.isPremium === true
    || (data.user?.premiumOrigin !== null && data.user?.premiumOrigin !== undefined && data.user?.premiumOrigin !== '0' && data.user?.premiumOrigin !== 0);
  debugLog('[bg] User info:', JSON.stringify(data.user));

  return { wsUrl, broadcastId, title: data.program?.title || channelId, isPremium };
}

// Netflixタブにcontent_scriptを注入（まだ注入されていない場合）
async function ensureContentScript() {
  const tabs = await chrome.tabs.query({ url: 'https://www.netflix.com/*' });
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/content_script.js']
      });
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['src/content_style.css']
      });
    } catch (e) {
      debugLog('[bg] Script injection skipped for tab', tab.id, e.message);
    }
  }
}

// 接続開始
async function connect(channelId) {
  try {
    debugLog('[bg] Fetching watch data for:', channelId);
    const watchData = await fetchWatchData(channelId);
    debugLog('[bg] Watch data:', JSON.stringify(watchData));

    await ensureContentScript();
    await ensureOffscreen();

    chrome.runtime.sendMessage({
      type: 'connect',
      data: watchData
    }).catch(() => {});

    // content_scriptにプレミアム情報を通知
    broadcastToContent({ type: 'premiumStatus', isPremium: watchData.isPremium });

    // 接続情報を保存
    await chrome.storage.local.set({
      lastChannel: channelId,
      programTitle: watchData.title,
      isPremium: watchData.isPremium
    });
  } catch (err) {
    console.error('Connection failed:', err);
    currentStatus = 'error';
    broadcastStatus('error', err.message);
  }
}

// 切断
function disconnect() {
  chrome.runtime.sendMessage({ type: 'disconnect' }).catch(() => {});
}

// ステータスをpopupとcontent_scriptに通知
function broadcastStatus(status, errorMsg) {
  currentStatus = status;
  // popupへ
  chrome.runtime.sendMessage({
    type: 'statusUpdate',
    data: { status, error: errorMsg }
  }).catch(() => {});
}

// メッセージハンドラ
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // popupからの接続要求
  if (msg.type === 'popup_connect') {
    connect(msg.channelId);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'popup_disconnect') {
    disconnect();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'popup_getStatus') {
    sendResponse({ status: currentStatus });
    return true;
  }

  // 音声認識キーワード取得（選手名をAI検索）
  if (msg.type === 'fetchVoiceKeyterms') {
    fetchVoiceKeyterms(msg.teamA, msg.teamB).then(sendResponse);
    return true;
  }

  // AI生成キャンセル
  if (msg.type === 'cancelAiComment') {
    if (geminiAbortController) geminiAbortController.abort();
    return;
  }

  // AI コメント生成リクエスト
  if (msg.type === 'generateAiComment') {
    callGeminiApi(msg.data).then((result) => {
      broadcastToContent({ type: 'aiCommentResult', data: result });
    });
    return;
  }

  // offscreenからのログ転送
  if (msg.type === 'log') {
    debugLog(msg.data);
    return;
  }

  // offscreenからのステータス更新
  if (msg.type === 'status') {
    currentStatus = msg.data;
    chrome.runtime.sendMessage({
      type: 'statusUpdate',
      data: { status: msg.data }
    }).catch(() => {});
    return;
  }

  // offscreenからの投稿結果 → content_scriptに転送
  if (msg.type === 'postCommentResult') {
    broadcastToContent({ type: 'postCommentResult', data: msg.data });
    return;
  }

  // offscreenからのコメント受信 → content_scriptに転送（port経由）+ ログ蓄積
  if (msg.type === 'comment') {
    // コメントログに蓄積（概要機能用、translucent=低レピュテーションは除外）
    const mail = msg.data.mail || '';
    if (!mail.includes('translucent')) {
      commentLog.push({ text: msg.data.text, mail, userId: msg.data.userId, time: Date.now() });
    }
    recordCommentBucket();
    pruneCommentLog();
    // content_scriptへの転送はtext,mailのみ（既存の描画に影響なし）
    broadcastToContent({ text: msg.data.text, mail: msg.data.mail });
    return;
  }

  // 概要の自動更新ON/OFF
  if (msg.type === 'toggleAutoSummary') {
    if (msg.enabled) {
      startAutoSummary();
    } else {
      stopAutoSummary();
    }
    return;
  }

  // 概要の手動取得
  if (msg.type === 'generateSummary') {
    generateSummary().then((result) => {
      broadcastToContent({ type: 'summaryResult', data: result });
    });
    return;
  }

  // 概要履歴リクエスト（グラフホバー用）
  if (msg.type === 'getSummaryHistory') {
    broadcastToContent({ type: 'summaryHistoryResult', data: summaryHistory });
    return;
  }

  // コメントグラフデータリクエスト
  if (msg.type === 'getCommentGraph') {
    const points = getGraphData();
    const total = points.reduce((a, b) => a + b, 0);
    console.log('[bg] getCommentGraph: buckets=' + commentBuckets.length + ' total=' + total);
    broadcastToContent({ type: 'commentGraphResult', data: points });
    return;
  }

  // ユーザー一覧リクエスト
  if (msg.type === 'getUserList') {
    broadcastToContent({ type: 'userListResult', data: buildUserList() });
    return;
  }

});

// content_scriptへのブロードキャスト（全ポートに送信）
function broadcastToContent(msg) {
  for (const port of contentPorts) {
    try { port.postMessage(msg); } catch (e) {}
  }
}

// ============================================================
// 音声認識キーワード: Gemini Web検索で選手名を取得
// ============================================================
async function fetchVoiceKeyterms(teamA, teamB) {
  const result = await chrome.storage.local.get(['geminiApiKey']);
  const apiKey = result.geminiApiKey;
  if (!apiKey) {
    return { error: 'Gemini API Keyが未設定です' };
  }

  const today = new Date().toISOString().split('T')[0];
  const prompt = `${today}時点のWBC (World Baseball Classic) 2026の情報を検索してください。

「${teamA}」と「${teamB}」の対戦について:
- 両チームの出場登録選手のうち、主要選手（スタメン・主力投手）を中心に最大30名をリストアップ
- 監督は含める。コーチは不要
- 日本人選手は「姓 名」（漢字）で出力（例: 大谷翔平）
- 外国人選手は「姓 名」（カタカナ）で出力（例: マイク・トラウト）
- 重複なし

以下のJSON形式のみを出力してください。説明不要。
\`\`\`json
{"keyterms": ["選手名1", "選手名2", ...]}
\`\`\``;

  try {
    const model = 'gemini-2.5-flash';
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 2048 } },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { error: `API エラー (${res.status}): ${errText.substring(0, 80)}` };
    }

    const json = await res.json();
    const resParts = json.candidates?.[0]?.content?.parts || [];
    let text = resParts.filter(p => !p.thought).map(p => p.text).join('');

    const jsonMatch = text.match(/```json\s*\n?([\s\S]*?)```/);
    if (!jsonMatch) {
      return { error: '選手情報の解析に失敗しました' };
    }

    const parsed = JSON.parse(jsonMatch[1].trim());
    const keyterms = (parsed.keyterms || []).slice(0, 30);
    if (keyterms.length === 0) {
      return { error: '選手情報が見つかりませんでした' };
    }

    // フルネームから姓だけも追加（「トーバー」単体でも認識させる）
    const surnames = [];
    for (const name of keyterms) {
      if (name.includes('・')) {
        // カタカナ名: 「エセキエル・トーバー」→「トーバー」
        const parts = name.split('・');
        const surname = parts[parts.length - 1];
        if (surname.length >= 3) surnames.push(surname);
      } else if (/^[\u4e00-\u9fff]/.test(name) && name.length >= 4) {
        // 漢字名: 「大谷翔平」→「大谷」(先頭2-3文字が姓の場合が多いが曖昧なので省略)
      }
    }

    // 野球用語・誤変換されやすい野球表現も追加
    const baseKeyterms = [
      'ホームラン', 'ツーベース', 'スリーベース', 'フォアボール', 'デッドボール',
      '三振', 'ダブルプレー', 'ゲッツー', 'ファインプレー', '犠牲フライ', '盗塁',
      'ストレート', 'フォーク', 'スライダー', 'カーブ', 'チェンジアップ',
      'WBC', '侍ジャパン',
      // 同音異義語で誤変換されやすい野球動詞・表現
      '打った', '打って', '打てる', '打てない', '打席', '打線', '打率',
      '投げた', '投げて', '投げる', '投手', '投球',
      '振った', '振って', '振れる', '空振り',
      '抑えた', '抑えて', '抑える', '押さえ',
      '走った', '走って', '走塁',
      '守った', '守って', '守備',
      '刺した', '刺して', '牽制',
    ];
    // 重複排除
    const allKeyterms = [...new Set([...keyterms, ...surnames, ...baseKeyterms])];

    await chrome.storage.local.set({ voiceKeyterms: allKeyterms });
    debugLog('[bg] Voice keyterms saved:', allKeyterms.length, 'items');
    return { keyterms: allKeyterms };
  } catch (e) {
    return { error: `通信エラー: ${e.message}` };
  }
}

// ============================================================
// 音声入力: Deepgram WebSocket (background service worker)
// ============================================================
let deepgramWs = null;
let deepgramAccum = { texts: [], words: [] }; // is_final蓄積バッファ

async function startDeepgram() {
  if (deepgramWs) stopDeepgram();

  const stored = await chrome.storage.local.get(['deepgramApiKey', 'voiceKeyterms']);
  const apiKey = stored.deepgramApiKey;
  if (!apiKey) {
    broadcastToContent({ type: 'voiceError', message: 'Deepgram API Keyが未設定です。ポップアップで設定してください。' });
    return;
  }

  const params = new URLSearchParams({
    language: 'ja', model: 'nova-3',
    punctuate: 'true', smart_format: 'true', endpointing: '300',
    interim_results: 'true', encoding: 'linear16', sample_rate: '16000', channels: '1',
  });
  // 保存済みキーワード（選手名等）をkeytermとして追加（URL長制限のため最大80件）
  const keyterms = (stored.voiceKeyterms || []).slice(0, 80);
  for (const kt of keyterms) {
    params.append('keyterm', kt);
  }
  const url = 'wss://api.deepgram.com/v1/listen?' + params.toString();

  debugLog('[bg-voice] Connecting to Deepgram via subprotocol auth');
  try {
    deepgramWs = new WebSocket(url, ['token', apiKey]);
  } catch (e) {
    debugLog('[bg-voice] WebSocket constructor error:', e.message);
    broadcastToContent({ type: 'voiceError', message: '音声認識の接続に失敗しました' });
    return;
  }

  deepgramWs.onopen = () => {
    debugLog('[bg-voice] Deepgram connected');
    deepgramAccum = { texts: [], words: [] };
    broadcastToContent({ type: 'voiceStatus', status: 'connected' });
  };

  let dgMsgCount = 0;
  deepgramWs.onmessage = (event) => {
    try {
      const result = JSON.parse(event.data);
      dgMsgCount++;
      if (dgMsgCount <= 5 || dgMsgCount % 20 === 0) {
        debugLog('[bg-voice] msg#' + dgMsgCount, 'type=' + result.type, 'is_final=' + result.is_final, 'speech_final=' + result.speech_final, 'transcript=' + (result.channel?.alternatives?.[0]?.transcript || '').substring(0, 30));
      }
      if (result.type !== 'Results') return;
      const alt = result.channel?.alternatives?.[0];
      if (!alt) return;
      const transcript = (alt.transcript || '').trim();
      const isFinal = result.is_final === true;
      const speechFinal = result.speech_final === true;

      if (isFinal && transcript) {
        // is_finalセグメントを蓄積
        deepgramAccum.texts.push(transcript);
        deepgramAccum.words.push(...(alt.words || []));
      }

      if (speechFinal) {
        // 発話完了: 蓄積した全セグメントを結合して送信
        const fullTranscript = deepgramAccum.texts.join('');
        const allWords = deepgramAccum.words;
        deepgramAccum = { texts: [], words: [] };
        if (fullTranscript) {
          broadcastToContent({ type: 'voiceTranscript', transcript: fullTranscript, words: allWords });
        }
      } else if (transcript) {
        // interim: 蓄積分 + 現在のinterimを結合して表示
        const interimText = deepgramAccum.texts.join('') + (isFinal ? '' : transcript);
        broadcastToContent({ type: 'voiceStatus', status: 'interim', text: interimText });
      }
    } catch (e) {
      debugLog('[bg-voice] Parse error:', e.message);
    }
  };

  deepgramWs.onerror = () => {
    debugLog('[bg-voice] WebSocket error');
  };

  deepgramWs.onclose = (event) => {
    debugLog('[bg-voice] Closed, code=' + event.code, 'reason=' + event.reason);
    deepgramWs = null;
    if (event.code === 1008 || event.code === 4001 || event.code === 4003) {
      broadcastToContent({ type: 'voiceError', message: 'Deepgram API Keyが無効です' });
    } else if (event.code !== 1000) {
      broadcastToContent({ type: 'voiceError', message: '音声認識の接続に失敗しました (code=' + event.code + ')' });
    }
  };
}

function stopDeepgram() {
  if (deepgramWs) {
    try {
      if (deepgramWs.readyState === WebSocket.OPEN) {
        deepgramWs.send(JSON.stringify({ type: 'CloseStream' }));
      }
      deepgramWs.close();
    } catch (_) {}
    deepgramWs = null;
  }
}

// Gemini API呼び出し
let geminiAbortController = null;

async function callGeminiApi(data) {
  const result = await chrome.storage.local.get(['geminiApiKey']);
  const apiKey = result.geminiApiKey;
  if (!apiKey) {
    return { error: 'API Keyが設定されていません。ポップアップで設定してください。' };
  }

  const systemPrompts = {
    normal: `あなたはニコニコ生放送の実況コメントを生成するアシスタントです。

現在の番組の直近のコメント:
{recentComments}

ユーザーの依頼: {userPrompt}

以下のルールに従ってコメントを1つ生成してください:
- 最大75文字
- ニコニコ生放送の実況らしい自然な口調
- 絵文字は使わない
- コメント本文のみを返してください（説明不要）`,

    webSearch: `あなたはニコニコ生放送の実況コメントを生成するアシスタントです。
Google検索で最新情報を調べて、それに基づいたコメントを生成してください。

現在の番組の直近のコメント:
{recentComments}

ユーザーの依頼: {userPrompt}

手順:
1. まずユーザーの依頼に関連する最新情報をWeb検索で調べる
2. 検索結果から得た事実に基づいてコメントを生成する

以下のルールに従ってコメントを1つ生成してください:
- 最大75文字
- ニコニコ生放送の実況らしい自然な口調
- 絵文字は使わない
- 検索で得た具体的な情報（スコア、選手名、出来事など）を盛り込む
- コメント本文のみを返してください（説明不要、検索結果の引用不要、[cite]タグ不要）`,

    shitaCA: `あなたはニコニコ生放送で愛される「コメントアート（CA）職人」です。
視聴者が一体感を感じるような、見栄えの良いテキストアートを作成してください。

■ ルール:
- 構成: 4〜6行（画面下部で最も見栄えが良い段数）
- 横幅: 各行最大75文字（全角35文字程度が安全）
- 禁止: 全角スペースのみの行は絶対に作らない。必ず何らかの記号や文字を含めること
- 出力: 説明・番号・「shita」等のコマンドは一切不要。テキストアート本体のみを出力

■ 使える文字（推奨順）:
1. 罫線素片（枠作りに最適、環境差が少ない）: ╔═╗║╚╝╠╣╦╩ ┌─┐│└┘┏━┓┃┗┛
2. ブロック要素（背景埋め、グラデーション）: █▓░▄▀
3. 幾何学記号（アクセント）: ★☆■□◆◇●○▲▼
4. カラー絵文字（⚾🏆など）は幅が環境依存でズレやすいため、使わないこと

■ デザイン指針:
- 罫線素片で枠を作り、テレビのテロップのような整った見た目にする
- 各行の横幅（文字数）を揃えて整ったシルエットにする
- 二重線枠（╔═╗）はテロップ感・高級感が出るのでおすすめ
- ブロック要素（█▓░）は枠内の背景や装飾に使う

■ 良い例:
╔════════════════╗
║★　侍ジャパン優勝！　★║
║　　おめでとう！！　　　║
╚════════════════╝

■ 悪い例（全角スペースだけの行がある）:

★☆★ 侍ジャパン ★☆★


ユーザーの依頼: {userPrompt}

テキストアートのみを出力:`
  };

  const template = systemPrompts[data.mode] || systemPrompts.normal;
  const prompt = template
    .replace('{userPrompt}', data.userPrompt || '')
    .replace('{recentComments}', data.recentComments || '（なし）');

  const parts = [{ text: prompt }];

  try {
    geminiAbortController = new AbortController();
    // モデル選択: shitaCA=thinking model, webSearch=flash+検索, 通常=lite
    const isShitaCA = data.mode === 'shitaCA';
    const isWebSearch = data.mode === 'webSearch';
    const model = isShitaCA ? 'gemini-2.5-flash'
      : isWebSearch ? 'gemini-2.5-flash'
      : 'gemini-3.1-flash-lite-preview';
    const genConfig = {};
    if (isShitaCA) {
      genConfig.maxOutputTokens = 16384;
      genConfig.temperature = 0.2;
      genConfig.thinkingConfig = { thinkingBudget: 4096 };
    } else if (isWebSearch) {
      genConfig.maxOutputTokens = 1024;
    } else {
      genConfig.maxOutputTokens = 1024;
    }
    const requestBody = {
      contents: [{ parts }],
      generationConfig: genConfig,
    };
    // Web検索モード: Google Search Groundingを有効化
    if (isWebSearch) {
      requestBody.tools = [{ googleSearch: {} }];
    }
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    // API呼び出し（500エラーor空出力で最大2回リトライ）
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: geminiAbortController.signal
      });

      if (res.status === 500) {
        if (attempt < 2) { await new Promise(r => setTimeout(r, 1000)); continue; }
        return { error: 'API サーバーエラーが続いています。しばらく待ってから再試行してください。' };
      }

      if (!res.ok) {
        const errText = await res.text();
        return { error: `API エラー (${res.status}): ${errText.substring(0, 100)}` };
      }

      const json = await res.json();
      // thinking modelはparts内に{thought:true}のパートと実際の出力パートがある
      const resParts = json.candidates?.[0]?.content?.parts || [];
      // 重複partsを除去してからテキスト結合
      const textParts = resParts.filter(p => !p.thought).map(p => p.text);
      const uniqueParts = textParts.filter((t, i) => i === 0 || t !== textParts[i - 1]);
      let text = uniqueParts.join('');
      // citation タグを除去 (例: [cite: 1, 2], [1], [2, 3])
      text = text.replace(/\s*\[cite:[^\]]*\]?/g, '').replace(/\s*\[\d+(?:,\s*\d+)*\]/g, '');

      // コードブロック(```)で囲まれている場合は中身だけ抽出
      const codeBlockMatch = text.match(/```[\s\S]*?\n([\s\S]*?)```/);
      if (codeBlockMatch) text = codeBlockMatch[1];
      text = text.trim();

      // 全角スペース・罫線のみで中身がない出力を検知してリトライ
      // eslint-disable-next-line no-irregular-whitespace
      const contentChars = text.replace(/[\s　╔═╗║╚╝╠╣╦╩┌─┐│└┘┏━┓┃┗┛]/g, '');
      if (!contentChars && attempt < 2) {
        debugLog('[bg] Empty CA output, retrying...', attempt);
        genConfig.temperature = Math.min((genConfig.temperature || 0.3) + 0.2, 1.0);
        requestBody.generationConfig = genConfig;
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      if (!text) {
        return { error: '生成結果が空でした' };
      }
      return { text };
    }
    return { error: '生成に失敗しました。再試行してください。' };
  } catch (e) {
    if (e.name === 'AbortError') {
      return { cancelled: true };
    }
    return { error: `通信エラー: ${e.message}` };
  } finally {
    geminiAbortController = null;
  }
}

// コメントログ（概要機能用：直近5分間、最大500件）
const commentLog = [];
const COMMENT_LOG_MAX_AGE = 5 * 60 * 1000; // 5分
const COMMENT_LOG_MAX_COUNT = 500;

function pruneCommentLog() {
  const cutoff = Date.now() - COMMENT_LOG_MAX_AGE;
  while (commentLog.length > 0 && commentLog[0].time < cutoff) {
    commentLog.shift();
  }
  while (commentLog.length > COMMENT_LOG_MAX_COUNT) {
    commentLog.shift();
  }
}

// コメント頻度ヒストグラム（グラフ用：10秒バケット×60=10分間）
const GRAPH_BUCKET_SEC = 10;
const GRAPH_BUCKET_COUNT = 60; // 10分間
const commentBuckets = []; // [{time, count}]

function recordCommentBucket() {
  const now = Math.floor(Date.now() / 1000 / GRAPH_BUCKET_SEC) * GRAPH_BUCKET_SEC * 1000;
  if (commentBuckets.length > 0 && commentBuckets[commentBuckets.length - 1].time === now) {
    commentBuckets[commentBuckets.length - 1].count++;
  } else {
    commentBuckets.push({ time: now, count: 1 });
  }
  // 古いバケットを削除
  const cutoff = now - GRAPH_BUCKET_COUNT * GRAPH_BUCKET_SEC * 1000;
  while (commentBuckets.length > 0 && commentBuckets[0].time < cutoff) {
    commentBuckets.shift();
  }
}

function getGraphData() {
  const now = Math.floor(Date.now() / 1000 / GRAPH_BUCKET_SEC) * GRAPH_BUCKET_SEC * 1000;
  const bucketMap = new Map();
  for (const b of commentBuckets) {
    bucketMap.set(b.time, b.count);
  }
  const points = [];
  for (let i = GRAPH_BUCKET_COUNT - 1; i >= 0; i--) {
    const t = now - i * GRAPH_BUCKET_SEC * 1000;
    points.push(bucketMap.get(t) || 0);
  }
  return points; // 60個の数値配列（古い→新しい）
}

// ユーザー傾向キャッシュ（概要生成時にGeminiが分析した結果）
let userTendencyCache = {};

// 概要生成
let summaryAbortController = null;

async function generateSummary() {
  const result = await chrome.storage.local.get(['geminiApiKey']);
  const apiKey = result.geminiApiKey;
  if (!apiKey) {
    return { error: 'API Keyが設定されていません。ポップアップで設定してください。' };
  }

  pruneCommentLog();
  if (commentLog.length < 5) {
    return { error: 'コメントが少なすぎます（最低5件必要）。しばらく待ってから再試行してください。' };
  }

  // コメントをフォーマット（相対時刻 + ユーザーID短縮 + テキスト）
  const now = Date.now();
  const formatted = commentLog.map(c => {
    const agoSec = Math.round((now - c.time) / 1000);
    const agoStr = agoSec >= 60 ? `${Math.floor(agoSec / 60)}分${agoSec % 60}秒前` : `${agoSec}秒前`;
    const uid = c.userId ? c.userId.replace('a:', '') : '???';
    return `[${agoStr}] ${uid}: ${c.text}`;
  }).join('\n');

  const elapsedMin = Math.round((now - commentLog[0].time) / 60000);
  const prompt = `あなたはニコニコ生放送のコメント分析アシスタントです。

以下は直近${elapsedMin || 1}分間のコメントログです（${commentLog.length}件）。
形式: [相対時刻] ユーザーID: コメント本文

${formatted}

以下の形式で分析結果を日本語で出力してください:

## 場の雰囲気
全体の盛り上がり度合い、主な話題、場の空気を2-3文で簡潔に。「直近○分間では」等の時間への言及は不要。

## 話題のトピック
箇条書きで主な話題を3-5個（各1行で簡潔に）

最後に、コメント数上位20名のみ、以下のJSON形式で傾向を出力してください。
JSONブロックは必ず \`\`\`json と \`\`\` で囲んでください。20名を超えないこと。

\`\`\`json
{"ユーザーID": "傾向5文字以内", "ユーザーID2": "傾向5文字以内"}
\`\`\`

傾向は以下の固定カテゴリから1つ選んでください:
"解説"=試合展開・戦術を説明, "ツッコミ"=面白がる・突っ込む, "応援"=特定チーム/選手を応援, "悲嘆"=嘆き・絶望, "盛り上げ"=草・www系, "予想"=展開・スコア予想, "雑談"=試合外の話題
注意: 説明や前置きは不要。上記フォーマットのみ出力してください。`;

  try {
    summaryAbortController = new AbortController();
    const model = 'gemini-2.5-flash';
    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingBudget: 2048 },
      },
    };
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: summaryAbortController.signal
    });

    if (!res.ok) {
      const errText = await res.text();
      return { error: `API エラー (${res.status}): ${errText.substring(0, 100)}` };
    }

    const json = await res.json();
    const resParts = json.candidates?.[0]?.content?.parts || [];
    let text = resParts.filter(p => !p.thought).map(p => p.text).join('');
    text = text.trim();

    if (!text) {
      return { error: '分析結果が空でした' };
    }

    // JSONブロックからユーザー傾向を抽出してキャッシュ
    const jsonMatch = text.match(/```json\s*\n?([\s\S]*?)```/);
    if (jsonMatch) {
      let jsonStr = jsonMatch[1].trim();
      // MAX_TOKENSで切れた不完全なJSONを修復（末尾の不完全エントリを削除して閉じる）
      if (!jsonStr.endsWith('}')) {
        const lastComplete = jsonStr.lastIndexOf('"');
        const lastComma = jsonStr.lastIndexOf(',', lastComplete);
        if (lastComma > 0) {
          jsonStr = jsonStr.substring(0, lastComma) + '}';
        }
      }
      try {
        const tendencies = JSON.parse(jsonStr);
        userTendencyCache = tendencies;
        debugLog('[bg] User tendencies cached:', Object.keys(tendencies).length, 'users');
      } catch (e) {
        debugLog('[bg] Failed to parse user tendencies JSON:', e.message);
      }
      // 概要テキストからJSONブロックを除去（表示用）
      text = text.replace(/```json[\s\S]*?```/, '').trim();
    }
    // MAX_TOKENSで```が閉じなかった場合もJSONを除去
    text = text.replace(/```json[\s\S]*$/, '').trim();

    // 「場の雰囲気」セクションだけ抽出して履歴に保存
    const moodMatch = text.match(/##\s*場の雰囲気\s*\n([\s\S]*?)(?=\n##|\n```|$)/);
    if (moodMatch) {
      addSummaryHistory(moodMatch[1].trim());
    }
    return { text, commentCount: commentLog.length };
  } catch (e) {
    if (e.name === 'AbortError') {
      return { cancelled: true };
    }
    return { error: `通信エラー: ${e.message}` };
  } finally {
    summaryAbortController = null;
  }
}

// 概要履歴（タイムスタンプ付き、グラフホバー用）
const summaryHistory = []; // [{time, text}]
const SUMMARY_HISTORY_MAX = 20;

function addSummaryHistory(text) {
  summaryHistory.push({ time: Date.now(), text });
  while (summaryHistory.length > SUMMARY_HISTORY_MAX) summaryHistory.shift();
}

// 概要の自動更新タイマー（3分間隔）
const AUTO_SUMMARY_INTERVAL = 3 * 60 * 1000; // 3分
let autoSummaryTimer = null;
let autoSummaryEnabled = false;

function startAutoSummary() {
  if (autoSummaryTimer) return;
  autoSummaryEnabled = true;
  // 初回は即座に実行
  runAutoSummary();
  autoSummaryTimer = setInterval(runAutoSummary, AUTO_SUMMARY_INTERVAL);
  debugLog('[bg] Auto-summary started (interval: 3min)');
}

function stopAutoSummary() {
  autoSummaryEnabled = false;
  if (autoSummaryTimer) {
    clearInterval(autoSummaryTimer);
    autoSummaryTimer = null;
  }
  if (summaryAbortController) summaryAbortController.abort();
  debugLog('[bg] Auto-summary stopped');
}

async function runAutoSummary() {
  if (!autoSummaryEnabled) return;
  // 生成中なら前回をキャンセルして再実行
  if (summaryAbortController) summaryAbortController.abort();

  // まずステータスを送信
  broadcastToContent({ type: 'summaryStatus', data: 'generating' });

  const result = await generateSummary();
  if (result.cancelled) return; // 自動更新OFF等でキャンセルされた場合
  broadcastToContent({ type: 'summaryResult', data: result });
}

// ユーザー一覧を構築（コメントログから集計 + AI傾向キャッシュをマージ）
function buildUserList() {
  pruneCommentLog();
  const userMap = new Map();
  for (const c of commentLog) {
    const uid = c.userId || '???';
    if (!userMap.has(uid)) {
      userMap.set(uid, { userId: uid, count: 0, firstTime: c.time, lastTime: c.time, comments: [] });
    }
    const u = userMap.get(uid);
    u.count++;
    u.lastTime = c.time;
    u.comments.push(c.text);
  }
  // コメント数降順でソート
  const users = Array.from(userMap.values()).sort((a, b) => b.count - a.count);
  // AI傾向キャッシュをマージ
  for (const u of users) {
    const shortId = u.userId.replace('a:', '');
    u.tendency = userTendencyCache[shortId] || null;
  }
  return { users, totalComments: commentLog.length };
}

// content_scriptからのport接続を管理（tabs権限不要）
const contentPorts = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'niko-jikkyo') {
    contentPorts.add(port);
    port.onDisconnect.addListener(() => {
      contentPorts.delete(port);
      // port切断時に音声も停止
      if (contentPorts.size === 0) stopDeepgram();
    });
    // content_scriptからのport メッセージ（音声データなど）
    let voiceAudioCount = 0;
    port.onMessage.addListener((msg) => {
      if (msg.type === 'voiceStart') {
        voiceAudioCount = 0;
        debugLog('[bg-voice] Received voiceStart from content_script');
        startDeepgram();
      } else if (msg.type === 'voiceAudio') {
        voiceAudioCount++;
        if (voiceAudioCount <= 3 || voiceAudioCount % 50 === 0) {
          // 音声レベルを確認（最大絶対値）
          let maxAbs = 0;
          if (msg.data) {
            for (let i = 0; i < Math.min(msg.data.length, 200); i++) {
              const v = Math.abs(msg.data[i]);
              if (v > maxAbs) maxAbs = v;
            }
          }
          debugLog('[bg-voice] voiceAudio #' + voiceAudioCount, 'len=' + (msg.data ? msg.data.length : 0), 'wsState=' + (deepgramWs ? deepgramWs.readyState : 'null'), 'maxAbs=' + maxAbs);
        }
        if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN && msg.data) {
          deepgramWs.send(new Int16Array(msg.data).buffer);
        }
      } else if (msg.type === 'voiceStop') {
        debugLog('[bg-voice] Received voiceStop, audioChunks sent:', voiceAudioCount);
        stopDeepgram();
      }
    });
  }
});
