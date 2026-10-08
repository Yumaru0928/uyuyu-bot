// commands/utility/set-delete-channel.js
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('set-delete-log-channel')
        .setDescription('このチャンネルを削除ログの送信先として保存します')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    async execute(interaction) {
        const guildId = interaction.guildId;
        const channelId = interaction.channelId;

        // 設定保存ファイルのローカルパス
        const filePath = path.join(__dirname, '../../config-channels.json');

        // 1. 既存のJSONデータを読み込み
        let configData = {};
        if (fs.existsSync(filePath)) {
            try {
                configData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            } catch (error) {
                console.error('JSON読み込みエラー:', error);
            }
        }

        // 2. 該当サーバーのオブジェクト構造を初期化
        if (!configData[guildId] || typeof configData[guildId] !== 'object') {
            configData[guildId] = {};
        }

        // 3. 「削除ログ用」のキー（deleteLogChannel）にチャンネルIDを保存
        configData[guildId].deleteLogChannel = channelId;

        // 4. ローカルとGitHubの両方に書き込み
        try {
            // ① Renderの現在実行中のメモリ/一時ファイルシステム用に保存
            fs.writeFileSync(filePath, JSON.stringify(configData, null, 4), 'utf8');

            // ② ユーザーに返信（GitHub通信に数秒かかるため先にレスポンス）
            await interaction.reply({
                content: `削除ログ送信用チャンネルとして <#${channelId}> を保存しました！`,
                flags: MessageFlags.Ephemeral,
            });

            // ③ GitHub APIを使ってリポジトリへ自動コミット
            // ※ GitHubリポジトリ上のルート（トップ）にある config-channels.json を更新します
            if (interaction.client.commitJsonToGitHub) {
                await interaction.client.commitJsonToGitHub(
                    'config-channels.json',
                    configData,
                    `auto: update deleteLogChannel for guild ${guildId} [skip ci]`
                );
            }

        } catch (error) {
            console.error('JSON保存エラー:', error);
            if (!interaction.replied) {
                await interaction.reply({
                    content: '設定の保存中にエラーが発生しました。',
                    flags: MessageFlags.Ephemeral,
                });
            }
        }
    },
};