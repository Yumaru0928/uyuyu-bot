# うゆゆBot

Discord Bot「うゆゆBot」と、サーバー設定用のWebダッシュボードです（Node.js / discord.js / Express）。
公式サイト: https://uyuyu-bot.onrender.com/

## 主な機能
- 「うゆゆ」などを含むメッセージに絵文字でリアクション（チャンネルごとにオフ可）
- メッセージ削除ログ
- コマンド: `/chat` `/generate` `/uyuyu-gacha` `/slot` `/blackjack` `/high-low` `/dice` `/color` `/avatar` `/calculate-darts-checkout` ほか（`/help` で一覧）
- ダッシュボード（`/dashboard`）: 削除ログの送信先と Auto-React をサーバーごとに設定

## 動かし方
```
npm install
npm start
```
Node.js 20 以上が必要です。ローカルでは `config.json`、Render などでは環境変数で設定します（どちらもGit管理外）。

## 環境変数
| 名前 | 用途 |
| --- | --- |
| `DISCORD_TOKEN` | Botのトークン（必須） |
| `CLIENT_ID` / `CLIENT_SECRET` | Discordアプリ。コマンド登録とダッシュボードのログインに使用 |
| `GUILD_ID` | 設定するとコマンドをそのサーバーだけに登録（開発用）。本番のグローバル登録では未設定にする |
| `CALLBACK_URL` | ダッシュボードのOAuth2コールバックURL |
| `SESSION_SECRET` | セッション署名とログイン保持Cookieの暗号化鍵（本番は必ず設定） |
| `GEMINI_API_KEY` | `/chat` と返信チャット |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` | `/generate`（FLUX.1 schnell） |
| `GITHUB_TOKEN` / `GITHUB_REPO` / `GITHUB_BRANCH` | 設定ファイルをGitHubの `data` ブランチへ保存・起動時に読み戻し |
| `CONSOLE_LOG_CHANNEL_ID` | ログ転送先のDiscordチャンネル（専用チャンネル推奨） |
| `LOADING_EMOJI` | ローディング表示用の絵文字（省略可） |
| `PUBLIC_BASE_URL` | 通知Webhookの受け口になる公開HTTPSのURL（例: `https://uyuyu-bot.onrender.com`）。省略すると `CALLBACK_URL` のオリジンを使う |
| `YOUTUBE_WEBSUB_SECRET` | YouTube通知: WebSubの署名用の任意の文字列（推奨: 32文字以上のランダム値）。未設定ならYouTube通知は無効 |
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | Twitch通知: [Twitch Developers](https://dev.twitch.tv/console) で作ったアプリの値 |
| `TWITCH_EVENTSUB_SECRET` | Twitch通知: EventSubの署名用の任意の文字列（10〜100文字）。変更すると既存の購読は作り直しになる |

## 構成
- `index.js` … 起動、イベント・コマンドの読み込み、GitHub同期
- `web.js` / `views/` / `public/` … Webサイトとダッシュボード
- `utils/notify/` … YouTube / Twitch の通知（`index.js` が本体、`youtube.js` `twitch.js` が各サービスの購読・受信、`x.js` は未実装の枠）
- `remember.js` … ログイン状態を暗号化Cookieに保存
- `gemini.js` … Gemini呼び出しの共通処理
- `channel-config.js` … `config-channels.json` の読み書き
- `emojis.js` … うゆゆ絵文字のID一覧
- `console-forward.js` … consoleの出力をDiscordチャンネルにも転送
- `commands/` … スラッシュコマンド（フォルダ名が `/help` のカテゴリになる）
- `events/` … メッセージ作成・削除などのイベント処理
