const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, InteractionContextType } = require('discord.js');
const { updateChannelConfig, ensureGuildConfig } = require('../../channel-config.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('disable-auto-react-channel')
        .setDescription('実行したチャンネルのAuto-Reactを無効化します')
        .setContexts(InteractionContextType.Guild) // サーバー内だけ
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    async execute(interaction) {
        const channel = interaction.channel;
        const guildId = interaction.guildId;

        let alreadyDisabled = false;
        let channelsData;
        try {
            channelsData = updateChannelConfig(data => {
                const guildConfig = ensureGuildConfig(data, guildId);
                if (!Array.isArray(guildConfig.disableAutoReact)) guildConfig.disableAutoReact = [];

                if (guildConfig.disableAutoReact.includes(channel.id)) {
                    alreadyDisabled = true;
                } else {
                    guildConfig.disableAutoReact.push(channel.id);
                }
            });
        } catch (error) {
            console.error('JSON保存エラー:', error);
            return await interaction.reply({
                content: 'データの保存処理中にエラーが発生しました。',
                flags: MessageFlags.Ephemeral
            });
        }

        if (alreadyDisabled) {
            return await interaction.reply({
                content: `${channel} は既に無効化リストに追加されています。`,
                flags: MessageFlags.Ephemeral
            });
        }

        // ユーザーへ先に返信（GitHub通信に数秒かかるため）
        await interaction.reply({
            content: `このチャンネル (${channel}) をAuto-React無効化リストに追加しました！`,
            flags: MessageFlags.Ephemeral
        });

        // GitHub APIへ自動コミット（dataブランチ対応 & [skip render] 追加）
        if (interaction.client.commitJsonToGitHub) {
            await interaction.client.commitJsonToGitHub(
                'config-channels.json',
                channelsData,
                `auto: disable auto-react for channel ${channel.id} in guild ${guildId} [skip render]`
            );
        }
    },
};
