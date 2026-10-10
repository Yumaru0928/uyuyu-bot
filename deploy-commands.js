const { REST, Routes } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

async function deployCommands() {
    let clientId, guildId, token;

    // config.json がローカルに存在するかチェック
    const configPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(configPath)) {
        const config = require('./config.json');
        clientId = config.clientId;
        guildId = config.guildId;
        token = config.token;
    } else {
        // Renderなどの環境変数から取得
        clientId = process.env.CLIENT_ID;
        guildId = process.env.GUILD_ID; // グローバル登録の場合は不要
        token = process.env.DISCORD_TOKEN;
    }

    if (!token || !clientId) {
        console.error('[Deploy Error] トークンまたはクライアントIDが設定されていません。');
        return;
    }

    const commands = [];
    const foldersPath = path.join(__dirname, 'commands');
    const commandFolders = fs.readdirSync(foldersPath);

    for (const folder of commandFolders) {
        const commandsPath = path.join(foldersPath, folder);
        const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
        for (const file of commandFiles) {
            const filePath = path.join(commandsPath, file);
            const command = require(filePath);
            if ('data' in command && 'execute' in command) {
                commands.push(command.data.toJSON());
            } else {
                console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
            }
        }
    }

    const rest = new REST({ version: '10' }).setToken(token);

    try {
        console.log(`${commands.length} 件のスラッシュコマンドを登録します`);

        const data = await rest.put(
            // guildId がある場合はギルドコマンド、無い場合（グローバル）は applicationCommands に変更可能
            guildId ? Routes.applicationGuildCommands(clientId, guildId) : Routes.applicationCommands(clientId),
            { body: commands },
        );

        console.log(`${data.length} 件のスラッシュコマンドを登録しました`);
    } catch (error) {
        console.error('コマンドの登録中にエラーが発生しました:', error);
    }
}

module.exports = deployCommands;