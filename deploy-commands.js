// deploy-commands.js
const { REST, Routes } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

async function deployCommands() {
    let clientId, guildId, token;

    const configPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(configPath)) {
        try {
            const config = require('./config.json');
            clientId = config.clientId;
            guildId = config.guildId;
            token = config.token;
        } catch (e) {
            console.error('[Deploy Error] config.json の読み込みに失敗しました:', e);
        }
    }
    
    // 環境変数での上書き・補完
    clientId = clientId || process.env.CLIENT_ID;
    guildId = guildId || process.env.GUILD_ID;
    token = token || process.env.DISCORD_TOKEN;

    if (!token || !clientId) {
        console.error('[Deploy Error] トークンまたはクライアントIDが設定されていません。');
        return;
    }

    const commands = [];
    const foldersPath = path.join(__dirname, 'commands');
    
    if (fs.existsSync(foldersPath)) {
        const commandFolders = fs.readdirSync(foldersPath);

        for (const folder of commandFolders) {
            const commandsPath = path.join(foldersPath, folder);
            if (!fs.statSync(commandsPath).isDirectory()) continue;

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
    }

    const rest = new REST({ version: '10' }).setToken(token);

    try {
        console.log(`${commands.length} 件のスラッシュコマンドを登録します...`);

        // guildId が設定されている場合は即時反映されるギルドコマンドとして登録し、なければグローバル登録にする
        const route = guildId 
            ? Routes.applicationGuildCommands(clientId, guildId)
            : Routes.applicationCommands(clientId);

        const data = await rest.put(route, { body: commands });

        console.log(`${data.length} 件のスラッシュコマンドを登録しました (${guildId ? 'Guild Commands' : 'Global Commands'})`);
    } catch (error) {
        console.error('コマンドの登録中にエラーが発生しました:', error);
    }
}

module.exports = deployCommands;