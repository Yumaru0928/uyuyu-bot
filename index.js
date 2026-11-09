// index.js
const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, Events, GatewayIntentBits, Partials, MessageFlags, ActivityType } = require('discord.js');

// console.log / console.warn / console.error をDiscordのチャンネルにも転送する（詳細は console-forward.js）
// 他のファイルを読み込む前に差し替えておくと、events や commands の console もすべて対象になる
const consoleForward = require('./console-forward.js');
consoleForward.install();

const deployCommands = require('./deploy-commands.js');
const { updateChannelConfig } = require('./channel-config.js');
const aiMessages = require('./ai-messages.js');

// 分離したWebサーバー（web.js）を読み込む
const app = require('./web.js');

// ===================================================
// ★ Express サーバーの起動（Renderポート開口用）
// ===================================================
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`[Web Server] Listening on port ${PORT}`));

// 自宅PC（マイクラサーバー）の常駐スクリプトからのWebSocket接続を受け付ける（/agent）
const agentBridge = require('./utils/agent-bridge.js');
agentBridge.attach(server);

// ===================================================
// ★ ① 先に Discord Client を初期化する（ここが重要！）
// ===================================================
const client = new Client({
    // 使う機能に必要なインテントだけを要求する（特権インテントは MessageContent のみ）
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel],
    // 既定では @everyone / @here / ロールのメンションでは通知しない（ユーザーへの返信メンションは従来どおり）
    allowedMentions: { parse: ['users'], repliedUser: true },
});

// ログを流したいDiscordチャンネルのID（Renderの環境変数 CONSOLE_LOG_CHANNEL_ID があればそちらを優先）
// Botがログインする前の出力も、ログイン後にまとめて送られる
const targetLogChannelId = process.env.CONSOLE_LOG_CHANNEL_ID || '1558496985315672085';
if (!process.env.CONSOLE_LOG_CHANNEL_ID) {
    console.warn('[Console Forward] CONSOLE_LOG_CHANNEL_ID が未設定のため、既定のチャンネルにログを送ります。削除ログと同じチャンネルの場合は、専用のチャンネルを環境変数で指定してください。');
}
consoleForward.attach(client, targetLogChannelId);

// 想定外のエラーでプロセスごと落ちないようにする
client.on(Events.Error, error => console.error('[Client Error]', error));
process.on('unhandledRejection', reason => console.error('[Unhandled Rejection]', reason));
process.on('uncaughtException', error => console.error('[Uncaught Exception]', error));

// Render の再起動・再デプロイ（SIGTERM）の前に、保存待ちの AI メッセージの記録を data ブランチへ書き出す
process.once('SIGTERM', async () => {
    console.log('[Shutdown] SIGTERM を受け取りました。保存待ちの記録を書き出します...');
    await Promise.race([
        aiMessages.flush().catch(error => console.error('[Shutdown] 記録の保存に失敗しました:', error)),
        new Promise(resolve => setTimeout(resolve, 10000)),
    ]);
    process.exit(0);
});

// ===================================================
// ★ ② client が定義されたあとに各種イベントを読み込む
// ===================================================
const messageDeleteEvent = require('./events/delete-message-log.js');
const senduyuyu = require('./events/send-uyuyu.js');
const replyChatEvent = require('./events/reply-chat.js');
const honeypotEvent = require('./events/honeypot.js');


// その他の個別イベント登録
client.on(messageDeleteEvent.name, (...args) => messageDeleteEvent.execute(...args));
client.on(senduyuyu.name, (...args) => senduyuyu.execute(...args));
client.on(replyChatEvent.name, (...args) => replyChatEvent.execute(...args));
client.on(honeypotEvent.name, (...args) => honeypotEvent.execute(...args));

// ★ Express に client インスタンスを登録
app.set('client', client);

client.commands = new Collection();
// 以降のコードはそのまま...

client.on('ready', () => {
    console.log(`${client.user.tag}でログインしました。`);

    const activities = [
        { name: `/help`, type: ActivityType.Watching },
        { name: 'うゆゆ をプレイ中', type: ActivityType.Playing },
        { name: 'うゆゆガチャ：/uyuyu-gacha をプレイ中', type: ActivityType.Playing }
    ];

    // マイクラサーバーの状態に応じて、ステータスの表示を1つ追加する
    //   running  … サーバーが起動していて入れる状態
    //   starting … 起動処理中
    //   それ以外（停止中・自宅PCオフライン）は追加しない
    const minecraftActivity = () => {
        switch (agentBridge.getState()) {
            case 'running':
                return { name: 'マイクラサーバー 🟢起動中', type: ActivityType.Playing };
            case 'starting':
                return { name: 'マイクラサーバー 🟡起動処理中', type: ActivityType.Playing };
            default:
                return null;
        }
    };

    let index = 0;
    const updateActivity = () => {
        const list = [...activities];
        const mc = minecraftActivity();
        if (mc) list.push(mc);

        index %= list.length; // 項目数が増減しても範囲外にならないようにする
        client.user.setActivity(list[index]);
        index = (index + 1) % list.length;
    };

    updateActivity();
    setInterval(updateActivity, 10000);
});

// ===================================================
// ★ GitHub との設定同期（dataブランチ）
//   Render は再起動・再デプロイでファイルが元に戻るため、設定ファイルを data ブランチに保存しておき、
//   起動時にそこから読み戻す。
// ===================================================
const GITHUB_TIMEOUT_MS = 15000;

function githubSettings() {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO;
    if (!token || !repo) return null;
    return {
        repo,
        branch: process.env.GITHUB_BRANCH || "data",
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github.v3+json",
            "Content-Type": "application/json",
        },
    };
}

async function commitJsonToGitHubNow(filePath, contentData, commitMessage) {
    const github = githubSettings();
    if (!github) {
        console.error("[GitHub Sync] GITHUB_TOKEN または GITHUB_REPO が設定されていません。");
        return;
    }

    const url = `https://api.github.com/repos/${github.repo}/contents/${filePath}`;

    try {
        let sha = null;
        const getRes = await fetch(`${url}?ref=${github.branch}`, {
            headers: github.headers,
            signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
        });
        if (getRes.ok) {
            const fileData = await getRes.json();
            sha = fileData.sha;
        }

        const jsonString = JSON.stringify(contentData, null, 2);
        const contentBase64 = Buffer.from(jsonString, 'utf-8').toString('base64');

        const body = {
            message: commitMessage,
            content: contentBase64,
            branch: github.branch,
            ...(sha && { sha }),
        };

        const putRes = await fetch(url, {
            method: "PUT",
            headers: github.headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
        });

        if (putRes.ok) {
            console.log(`[GitHub Sync] ${github.branch} ブランチの ${filePath} へのコミットに成功しました。`);
        } else {
            const err = await putRes.text();
            console.error("[GitHub Sync Error]", err);
        }
    } catch (error) {
        console.error("[GitHub Sync Failed]", error);
    }
}

// 同時に複数の変更が来ても、sha の食い違い（409）にならないよう 1 件ずつ順番にコミットする
let commitQueue = Promise.resolve();

function commitJsonToGitHub(filePath, contentData, commitMessage = "auto: update json [skip render]") {
    commitQueue = commitQueue.then(() => commitJsonToGitHubNow(filePath, contentData, commitMessage));
    return commitQueue;
}

// data ブランチの設定ファイルを読み戻して、ローカルの設定に反映する。
// ・失敗しても起動は続ける（ローカルのファイルをそのまま使う）
// ・サーバーごとに data ブランチの内容を優先し、data に無いサーバーはローカルの内容を残す
async function restoreConfigFromGitHub(filePath = 'config-channels.json') {
    const github = githubSettings();
    if (!github) return;

    try {
        const res = await fetch(`https://api.github.com/repos/${github.repo}/contents/${filePath}?ref=${github.branch}`, {
            headers: github.headers,
            signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
        });
        if (!res.ok) {
            console.warn(`[GitHub Sync] ${github.branch} ブランチの ${filePath} を取得できませんでした (HTTP ${res.status})。ローカルの設定を使います。`);
            return;
        }

        const file = await res.json();
        const remote = JSON.parse(Buffer.from(file.content || '', 'base64').toString('utf-8'));
        if (!remote || typeof remote !== 'object' || Array.isArray(remote)) {
            console.warn(`[GitHub Sync] ${filePath} の形式が正しくないため、読み戻しをスキップしました。`);
            return;
        }

        const guildIds = Object.keys(remote);
        updateChannelConfig(local => {
            for (const guildId of guildIds) local[guildId] = remote[guildId];
        });
        console.log(`[GitHub Sync] ${github.branch} ブランチから ${guildIds.length} サーバー分の設定を読み戻しました。`);
    } catch (error) {
        console.error('[GitHub Sync] 設定の読み戻しに失敗しました。ローカルの設定を使います:', error);
    }
}

// AI メッセージの記録（返信への反応判定や「続き」のつなぎに使う）も data ブランチに保存する。
// 変更があってから 2 分ほどまとめて 1 回コミットする（詳しくは ai-messages.js）
const AI_MESSAGES_FILE = 'ai-messages.json';

async function restoreAiMessagesFromGitHub(filePath = AI_MESSAGES_FILE) {
    const github = githubSettings();
    if (!github) return;

    try {
        const res = await fetch(`https://api.github.com/repos/${github.repo}/contents/${filePath}?ref=${github.branch}`, {
            headers: github.headers,
            signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
        });
        if (res.status === 404) {
            console.log(`[GitHub Sync] ${filePath} はまだ ${github.branch} ブランチにありません（初回起動）。`);
            return;
        }
        if (!res.ok) {
            console.warn(`[GitHub Sync] ${filePath} を取得できませんでした (HTTP ${res.status})。AI メッセージの記録なしで起動します。`);
            return;
        }

        const file = await res.json();
        const count = aiMessages.importRecords(JSON.parse(Buffer.from(file.content || '', 'base64').toString('utf-8')));
        console.log(`[GitHub Sync] AI メッセージの記録を ${count} 件読み戻しました。`);
    } catch (error) {
        console.error('[GitHub Sync] AI メッセージの記録の読み戻しに失敗しました:', error);
    }
}

if (githubSettings()) {
    aiMessages.setSaveHandler(data =>
        commitJsonToGitHub(AI_MESSAGES_FILE, data, 'auto: update ai-messages [skip render]'));
}

client.commitJsonToGitHub = commitJsonToGitHub;

// ===================================================
// ★ コマンドファイルの読み込み
// ===================================================
const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
    const commandsPath = path.join(foldersPath, folder);
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const command = require(filePath);
        if ('data' in command && 'execute' in command) {
            command.category = folder;
            client.commands.set(command.data.name, command);
        } else {
            console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
        }
    }
}

// ===================================================
// ★ イベント・インタラクション処理
// ===================================================

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const command = interaction.client.commands.get(interaction.commandName);

    if (!command) {
        console.error(`${interaction.commandName} に一致するコマンドが見つかりませんでした。`);
        return;
    }

    try {
        await command.execute(interaction);
    } catch (error) {
        console.error(error);
        const payload = { content: 'このコマンドの実行中にエラーが発生しました！', flags: MessageFlags.Ephemeral };
        try {
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(payload);
            } else {
                await interaction.reply(payload);
            }
        } catch (replyError) {
            // 期限切れなどで返信できなくても、ここで落とさない
            console.error('[Interaction] エラー応答の送信に失敗しました:', replyError.message);
        }
    }
});

// ===================================================
// ★ トークン取得・Bot起動処理（ローカル/環境変数両対応）
// ===================================================
let token;
const configPath = path.join(__dirname, 'config.json');

if (fs.existsSync(configPath)) {
    const config = require('./config.json');
    token = config.token;
} else {
    token = process.env.DISCORD_TOKEN;
}

async function main() {
    try {
        await restoreConfigFromGitHub();
        await restoreAiMessagesFromGitHub();
        await deployCommands();
        await client.login(token);
    } catch (error) {
        console.error('起動時にエラーが発生しました:', error);
    }
}

main();