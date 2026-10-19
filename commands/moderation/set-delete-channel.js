// commands/moderation/set-delete-channel.js
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, InteractionContextType } = require('discord.js');
const { updateChannelConfig, ensureGuildConfig } = require('../../channel-config.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('set-delete-log-channel')
        .setDescription('このチャンネルを削除ログの送信先として保存します')
        .setContexts(InteractionContextType.Guild) // サーバー内だけ
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    async execute(interaction) {
        const guildId = interaction.guildId;
        const channelId = interaction.channelId;

        // 「削除ログ用」のキー（deleteLogChannel）にチャンネルIDを保存
        let configData;
        try {
            configData = updateChannelConfig(data => {
                ensureGuildConfig(data, guildId).deleteLogChannel = channelId;
            });
        } catch (error) {
            console.error('JSON保存エラー:', error);
            return await interaction.reply({
                content: '設定の保存中にエラーが発生しました。',
                flags: MessageFlags.Ephemeral,
            });
        }

        // ユーザーに返信（GitHub通信に数秒かかるため先にレスポンス）
        await interaction.reply({
            content: `削除ログ送信用チャンネルとして <#${channelId}> を保存しました！`,
            flags: MessageFlags.Ephemeral,
        });

        // GitHub APIを使ってリポジトリへ自動コミット
        if (interaction.client.commitJsonToGitHub) {
            await interaction.client.commitJsonToGitHub(
                'config-channels.json',
                configData,
                `auto: set delete log channel to ${channelId} in guild ${guildId} [skip render]`
            );
        }
    },
};
