const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType
} = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('high-low')
        .setDescription('High&Lowゲームを開始します。')
        // User Install (Bot不在環境) 対応設定
        .setIntegrationTypes([
            ApplicationIntegrationType.GuildInstall,
            ApplicationIntegrationType.UserInstall
        ])
        .setContexts([
            InteractionContextType.Guild,
            InteractionContextType.BotDM,
            InteractionContextType.PrivateChannel
        ]),

    async execute(interaction) {
        const collectnumber = Math.floor(Math.random() * 100) + 1;
        let firstnumber;
        do {
            firstnumber = Math.floor(Math.random() * 100) + 1;
        } while (firstnumber === collectnumber); // 同じ数字にならないよう、違う数字が出るまで引き直す

        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('High&Lowゲーム')
            .setDescription('1~100のランダム数字が表示されます。次の数字がHigh(大きい)かLow(小さい)かを予想してください。')
            .addFields(
                { name: '最初の数字', value: `${firstnumber}`, inline: true },
                { name: '正解の数字', value: `???`, inline: true }
            );

        const highButton = new ButtonBuilder()
            .setCustomId('high')
            .setLabel('High')
            .setStyle(ButtonStyle.Primary);

        const lowButton = new ButtonBuilder()
            .setCustomId('low')
            .setLabel('Low')
            .setStyle(ButtonStyle.Danger);

        const row = new ActionRowBuilder().addComponents(highButton, lowButton);

        // 返信したメッセージを受け取る（fetchReply は非推奨なので withResponse を使う）
        const replied = await interaction.reply({
            embeds: [embed],
            components: [row],
            withResponse: true
        });

        const collector = replied.resource.message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 30000,
        });

        collector.on('collect', async i => {
            if (i.user.id !== interaction.user.id) {
                await i.reply({ content: 'このゲームは実行した本人のみ操作できます。', flags: MessageFlags.Ephemeral });
                return;
            }

            const isHigh = firstnumber < collectnumber;
            const userChoice = i.customId;
            let resultText = '';

            if ((userChoice === 'high' && isHigh) || (userChoice === 'low' && !isHigh)) {
                resultText = `🎉 **正解！** (正解の数字: **${collectnumber}**)`;
            } else {
                resultText = `❌ **不正解...** (正解の数字: **${collectnumber}**)`;
            }

            highButton.setDisabled(true);
            lowButton.setDisabled(true);

            const resultEmbed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle('High&Lowゲーム 結果')
                .setDescription(resultText)
                .addFields(
                    { name: '最初の数字', value: `${firstnumber}`, inline: true },
                    { name: '正解の数字', value: `${collectnumber}`, inline: true }
                );

            await i.update({ embeds: [resultEmbed], components: [row] });
            collector.stop();
        });

        collector.on('end', (collected, reason) => {
            if (reason === 'time') {
                highButton.setDisabled(true);
                lowButton.setDisabled(true);

                const timeoutEmbed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('High&Lowゲーム 結果')
                    .setDescription('⏰ **時間切れ！** ゲームが終了しました。');

                interaction.editReply({ embeds: [timeoutEmbed], components: [row] }).catch(() => {});
            }
        });
    },
};