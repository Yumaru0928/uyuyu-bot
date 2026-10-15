// index.js
const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, Events, GatewayIntentBits, Partials, MessageFlags, ActivityType } = require('discord.js');
const deployCommands = require('./deploy-commands.js');

// 分離したWebサーバー（web.js）を読み込む
const app = require('./web.js');

// ===================================================
// ★ Express サーバーの起動（Renderポート開口用）
// ===================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Web Server] Listening on port ${PORT}`));

// ===================================================
// ★ ① 先に Discord Client を初期化する（ここが重要！）
// ===================================================
const client = new Client({
    intents: Object.values(GatewayIntentBits).reduce((a, b) => a | b),
    partials: [Partials.Message, Partials.Channel],
});

// ===================================================
// ★ ② client が定義されたあとに各種イベントを読み込む
// ===================================================
const messageDeleteEvent = require('./events/delete-message-log.js');
const senduyuyu = require('./events/send-uyuyu.js');
const replyChatEvent = require('./events/reply-chat.js'); 



// その他の個別イベント登録
client.on(messageDeleteEvent.name, (...args) => messageDeleteEvent.execute(...args));
client.on(senduyuyu.name, (...args) => senduyuyu.execute(...args));
client.on(replyChatEvent.name, (...args) => replyChatEvent.execute(...args)); 

// ★ Express に client インスタンスを登録
app.set('client', client);

client.commands = new Collection();
// 以降のコードはそのまま...

client.on('ready', () => {
    console.log(`${client.user.tag}でログインしました。`);

    // 送信先のログチャンネルIDを指定
    const targetLogChannelId = '1557198844113068102'; // ここにログを流したいDiscordチャンネルのIDを入れる
    const logChannel = client.channels.cache.get(targetLogChannelId);

    if (logChannel) {
        // console.log をフック（上書き）する
        const originalConsoleLog = console.log;
        console.log = function (...args) {
            originalConsoleLog.apply(console, args); // 通常通りRenderのコンソールにも出す
            
            // Discordに送信（文字数が長すぎないように調整）
            const messageText = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
            if (messageText.trim()) {
                logChannel.send(`ℹ️ [LOG]: \`\`\`${messageText.slice(0, 1900)}\`\`\``).catch(() => {});
            }
        };

        // console.error も同様にフックして通知させたい場合
        const originalConsoleError = console.error;
        console.error = function (...args) {
            originalConsoleError.apply(console, args);
            
            const errorText = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
            if (errorText.trim()) {
                logChannel.send(`🚨 [ERROR]: \`\`\`${errorText.slice(0, 1900)}\`\`\``).catch(() => {});
            }
        };
    }
    const activities = [
        { name: `/help`, type: ActivityType.Watching },
        { name: 'うゆゆ をプレイ中', type: ActivityType.Playing },
        { name: 'うゆゆガチャ：/uyuyu-gacha をプレイ中', type: ActivityType.Playing }
    ];

    let index = 0;
    setInterval(() => {
        client.user.setActivity(activities[index]);
        index = (index + 1) % activities.length;
    }, 10000);
});

// ===================================================
// ★ GitHubコミット用関数（dataブランチ対応版）
// ===================================================
async function commitJsonToGitHub(filePath, contentData, commitMessage = "auto: update json [skip render]") {
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    const GITHUB_REPO = process.env.GITHUB_REPO;
    const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "data";

    if (!GITHUB_TOKEN || !GITHUB_REPO) {
        console.error("[GitHub Sync] GITHUB_TOKEN または GITHUB_REPO が設定されていません。");
        return;
    }

    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;
    const headers = {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
    };

    try {
        let sha = null;
        const getRes = await fetch(`${url}?ref=${GITHUB_BRANCH}`, { headers });
        if (getRes.ok) {
            const fileData = await getRes.json();
            sha = fileData.sha;
        }

        const jsonString = JSON.stringify(contentData, null, 2);
        const contentBase64 = Buffer.from(jsonString, 'utf-8').toString('base64');

        const body = {
            message: commitMessage,
            content: contentBase64,
            branch: GITHUB_BRANCH,
            ...(sha && { sha }),
        };

        const putRes = await fetch(url, {
            method: "PUT",
            headers,
            body: JSON.stringify(body),
        });

        if (putRes.ok) {
            console.log(`[GitHub Sync] ${GITHUB_BRANCH} ブランチの ${filePath} へのコミットに成功しました。`);
        } else {
            const err = await putRes.text();
            console.error("[GitHub Sync Error]", err);
        }
    } catch (error) {
        console.error("[GitHub Sync Failed]", error);
    }
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
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: 'このコマンドの実行中にエラーが発生しました！', flags: MessageFlags.Ephemeral });
        } else {
            await interaction.reply({ content: 'このコマンドの実行中にエラーが発生しました！', flags: MessageFlags.Ephemeral });
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
        await deployCommands();
        await client.login(token);
    } catch (error) {
        console.error('起動時にエラーが発生しました:', error);
    }
}

main();