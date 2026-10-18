const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, InteractionContextType } = require('discord.js');
const { updateChannelConfig } = require('../../channel-config.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('enable-auto-react-channel')
        .setDescription('実行したチャンネルのAuto-Reactを再有効化します')
        .setContexts(InteractionContextType.Guild) // サーバー内だけ
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    async execute(interaction) {
        const channel = interaction.channel;
        const guildId = interaction.guildId;

        let wasDisabled = false;
        let channelsData;
        try {
            channelsData = updateChannelConfig(data => {
                const disabledChannels = data[guildId]?.disableAutoReact;
                if (Array.isArray(disabledChannels) && disabledChannels.includes(channel.id)) {
                    wasDisabled = true;
                    data[guildId].disableAutoReact = disabledChannels.filter(id => id !== channel.id);
                }
            });
        } catch (error) {
            console.error('JSON保存エラー:', error);
            return await interaction.reply({
                content: 'データの保存処理中にエラーが発生しました。',
                flags: MessageFlags.Ephemeral
            });
        }

        // 無効化リストにこのチャンネルが無ければ、すでに有効
        if (!wasDisabled) {
            return await interaction.reply({
                content: `${channel} は既に有効（無効化リストに含まれていません）です。`,
                flags: MessageFlags.Ephemeral
            });
        }

        await interaction.reply({
            content: `このチャンネル (${channel}) のAuto-Reactを再有効化しました！`,
            flags: MessageFlags.Ephemeral
        });

        // GitHub APIを使って自動コミット
        if (interaction.client.commitJsonToGitHub) {
            await interaction.client.commitJsonToGitHub(
                'config-channels.json',
                channelsData,
                `auto: enable auto-react for channel ${channel.id} in guild ${guildId} [skip render]`
            );
        }
    },
};
