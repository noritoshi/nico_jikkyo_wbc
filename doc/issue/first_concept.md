# アプリの目的
このアプリはChrome Extensionです。
Netflixの動画、WBC2026の映像の上に、ニコニコ生放送の実況コメントを流すためのアプリです。

# アプリの当初機能
- シーク機能はない
- 最新のコメントのみを流す
- ニコニコ生放送のチャネルを指定して、最新の動画を流せる

## ニコニコAPIの実際の接続フロー

WBCの試合中継チャンネルに接続する場合、ブラウザが実際にやっていること：

```
1. GET https://live.nicovideo.jp/watch/ch2650071
   → HTMLの中に埋め込まれた embedded_data (JSON) を取得
   → ここにWebSocket URLとsupplied_tokenが入っている

2. WebSocket接続
   wss://a.live2.nicovideo.jp/unama/wsapi/v2/watch/...
   
3. 接続後すぐにメッセージ送信（視聴開始の宣言）
   {"type":"startWatching", "data":{"stream":...}}
   
4. サーバーから返ってくる roomMessage に
   別のWebSocket URL（コメントサーバー）が含まれる
   
5. そのコメントサーバーにも接続
   → ここからコメントがリアルタイムで流れてくる
```

**2段階のWebSocket接続**が必要なのがポイント。

---

## Chrome拡張がCORSを回避できる理由

通常のWebページからニコニコAPIを叩くとCORSエラーになりますが：

```
content_script.js → manifest.jsonに "host_permissions" を書けば
                     クロスオリジンリクエストが通る

background.js    → Service Workerとして動くので
                    さらに制限が緩い
```

ニコニコへのログイン状態（Cookie）もブラウザが持っているので、`credentials: 'include'` をつければそのまま使える。

---

## ファイル構成と役割分担

```
content_script.js   Netflix(netflix.com)に注入
                    ├── video要素を監視
                    ├── オーバーレイdivを挿入
                    └── background.jsからコメントを受け取って描画

background.js       Service Worker
                    ├── ニコニコAPIへの接続（CORS回避）
                    ├── 2段階WebSocket管理
                    └── コメントをcontent_scriptに転送
                        (chrome.tabs.sendMessage)

manifest.json       permissions:
                    - "cookies" (nicovideo.jpのsession取得)
                    - "host_permissions": nicovideo.jp, netflix.com
```

---

## コメント描画の実装方針

```javascript
// コメント1件につきこういうdivを生成してCSSアニメーション
const el = document.createElement('div')
el.textContent = commentText
el.style.cssText = `
  position: absolute;
  top: ${ランダムなY位置}%;
  left: 100%;                    // 右端からスタート
  animation: scroll-left 7s linear forwards;
  white-space: nowrap;
  color: white;
  text-shadow: 1px 1px 2px black;
`
overlay.appendChild(el)
// アニメーション終了後にDOMから削除
el.addEventListener('animationend', () => el.remove())
```

```css
@keyframes scroll-left {
  from { transform: translateX(0) }
  to   { transform: translateX(calc(-100% - 100vw)) }
}
```

---

## DevToolsでの事前調査手順

Claude Codeで実装前に、実際のAPIレスポンスを確認するのが確実です：

```
1. ニコニコにログインした状態で ch2650071 を開く
2. DevTools → Network → WS タブを開く
3. ページリロード
4. WebSocketの通信内容を確認
   → "type":"room" のメッセージにコメントサーバーURLが入っている
   → "type":"chat" がコメント本体
```

---

## 実装上の注意点

**embedded_dataの取得**
ページHTMLに `<script id="embedded-data" data-props="...">` という形で埋め込まれているので、content_scriptかbackground.jsでfetchして正規表現かDOMパースで取り出す。

**コメントのY位置の重なり防止**
単純なランダムだと重なるので、使用中のY帯を管理する配列を持っておくのが実用的。

**Netflixのフルスクリーン対応**
フルスクリーン時はdocument.fullscreenElementが変わるので、オーバーレイの親要素をそこに付け替える処理が必要。

---

これだけ把握していればClaude Codeで一気に実装できると思います。まず`manifest.json`と`background.js`の接続部分から始めるのがおすすめです。
