// 例: commands/utility/set-channel.js
const { SlashCommandBuilder } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('set-log-channel')
        .setDescription('このチャンネルを削除ログの送信先として保存します'),
    async execute(interaction) {
        const guildId = interaction.guildId;
        const channelId = interaction.channelId;

        // 設定保存ファイルのパス
        const filePath = path.join(__dirname, '../../config-channels.json');

        // 既存のデータを読み込み（ファイルがなければ空オブジェクト）
        let configData = {};
        if (fs.existsSync(filePath)) {
            configData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }

        // サーバーIDごとに実行されたチャンネルIDを書き込み
        configData[guildId] = channelId;

        // JSONファイルへ保存
        fs.writeFileSync(filePath, JSON.stringify(configData, null, 2));

        await interaction.reply({
            content: `ログ送信用チャンネルとして <#${channelId}> を保存しました！`,
            ephemeral: true,
        });
    },
};