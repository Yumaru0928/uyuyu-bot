// index.js
const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, Events, GatewayIntentBits, Partials, MessageFlags, ActivityType } = require('discord.js');
const token = process.env.DISCORD_BOT_TOKEN
const deployCommands = require('./deploy-commands.js');

// eventファイルの読み込み
const messageDeleteEvent = require('./events/delete-message-log.js');
const senduyuyu = require('./events/send-uyuyu.js');

const client = new Client({
    intents: Object.values(GatewayIntentBits).reduce((a, b) => a | b),
    partials: [Partials.Message, Partials.Channel],
});

client.commands = new Collection();

client.on('ready', () => {
    console.log(`${client.user.tag}でログインしました。`);
    const activities = [
        { name: `/help`, type: ActivityType.Watching },
        { name: 'うゆゆ をプレイ中', type: ActivityType.Playing },
        { name: 'うゆゆガチャ：/uyuyu-gacha をプレイ中', type: ActivityType.Playing }
    ];

    let index = 0;
    // 10秒ごとにステータスを変更
    setInterval(() => {
        client.user.setActivity(activities[index]);
        index = (index + 1) % activities.length;
    }, 10000);
});

// ===================================================
// ★ GitHubコミット用関数
// ===================================================
async function commitJsonToGitHub(filePath, contentData, commitMessage = "auto: update json [skip ci]") {
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    const GITHUB_REPO = process.env.GITHUB_REPO; // 例: "user/repo"
    const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

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
        // 1. 最新ファイルのSHAを取得（上書きに必要）
        let sha = null;
        const getRes = await fetch(`${url}?ref=${GITHUB_BRANCH}`, { headers });
        if (getRes.ok) {
            const fileData = await getRes.json();
            sha = fileData.sha;
        }

        // 2. データをBase64変換
        const jsonString = JSON.stringify(contentData, null, 2);
        const contentBase64 = Buffer.from(jsonString, 'utf-8').toString('base64');

        // 3. GitHub APIへ送信
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
            console.log(`[GitHub Sync] ${filePath} のコミットに成功しました。`);
        } else {
            const err = await putRes.text();
            console.error("[GitHub Sync Error]", err);
        }
    } catch (error) {
        console.error("[GitHub Sync Failed]", error);
    }
}

// 他のコマンド等から client.commitJsonToGitHub(...) として呼び出せるように client に生やしておく
client.commitJsonToGitHub = commitJsonToGitHub;

// index.js のコマンド読み込みループ部分
const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
    const commandsPath = path.join(foldersPath, folder);
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const command = require(filePath);
        if ('data' in command && 'execute' in command) {
            // ★ コマンドオブジェクトに所属フォルダ名をセット
            command.category = folder;
            client.commands.set(command.data.name, command);
        } else {
            console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
        }
    }
}

client.on(messageDeleteEvent.name, (...args) => messageDeleteEvent.execute(...args));
client.on(senduyuyu.name, (...args) => senduyuyu.execute(...args));

// コマンド実行（InteractionCreate）
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

// Botの起動・デプロイ実行処理
async function main() {
    try {
        await deployCommands();
        await client.login(token);
    } catch (error) {
        console.error('起動時にエラーが発生しました:', error);
    }
}

main();

const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// public フォルダ（HTML/CSS/画像など）を静的ファイルとして公開
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));

// --- ここから下に Discord.js の Bot 起動処理などを記述 ---