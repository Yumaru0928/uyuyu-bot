const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    ApplicationIntegrationType,
    InteractionContextType
} = require('discord.js');

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function buildDeck() {
    const deck = [];

    for (const suit of SUITS) {
        for (const rank of RANKS) {
            let value = Number(rank);
            if (rank === 'A') value = 11;
            if (['J', 'Q', 'K'].includes(rank)) value = 10;

            deck.push({ suit, rank, value });
        }
    }

    return deck;
}

function shuffleDeck(deck) {
    const shuffled = [...deck];

    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    return shuffled;
}

function getHandValue(hand) {
    let total = 0;
    let aces = 0;

    for (const card of hand) {
        total += card.value;
        if (card.rank === 'A') aces += 1;
    }

    while (total > 21 && aces > 0) {
        total -= 10;
        aces -= 1;
    }

    return total;
}

function formatCard(card) {
    return `${card.rank}${card.suit}`;
}

function createBlackjackEmbed({ description, playerHand, dealerHand, revealDealer, title = 'Blackjack' }) {
    const playerTotal = getHandValue(playerHand);
    const dealerTotal = getHandValue(dealerHand);

    const dealerCards = revealDealer
        ? dealerHand.map(formatCard).join(' ')
        : `${formatCard(dealerHand[0])} ??`;

    const playerCards = playerHand.map(formatCard).join(' ');

    return new EmbedBuilder()
        .setColor('#f2c94c')
        .setTitle(title)
        .setDescription(description)
        .addFields(
            { name: 'ディーラー', value: revealDealer ? `${dealerCards} (${dealerTotal})` : `${dealerCards} ??`, inline: false },
            { name: 'プレイヤー', value: `${playerCards} (${playerTotal})`, inline: false }
        );
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('blackjack')
        .setDescription('ブラックジャックを開始します。')
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
        let deck = shuffleDeck(buildDeck());

        const drawCard = () => {
            if (deck.length === 0) {
                deck = shuffleDeck(buildDeck());
            }

            return deck.pop();
        };

        const playerHand = [drawCard(), drawCard()];
        const dealerHand = [drawCard(), drawCard()];

        const hitButton = new ButtonBuilder()
            .setCustomId('bj_hit')
            .setLabel('Hit')
            .setStyle(ButtonStyle.Primary);

        const standButton = new ButtonBuilder()
            .setCustomId('bj_stand')
            .setLabel('Stand')
            .setStyle(ButtonStyle.Secondary);

        const actionRow = new ActionRowBuilder().addComponents(hitButton, standButton);

        const revealDealer = false;
        const initialEmbed = createBlackjackEmbed({
            description: 'カードを引くか、スタンドしてディーラーと対戦します。',
            playerHand,
            dealerHand,
            revealDealer,
        });

        const response = await interaction.reply({
            embeds: [initialEmbed],
            components: [actionRow],
            fetchReply: true
        });

        const collector = response.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60000,
        });

        const endRound = async (i, description, finalDealerHand = dealerHand, finalReveal = true) => {
            hitButton.setDisabled(true);
            standButton.setDisabled(true);

            const finalEmbed = createBlackjackEmbed({
                title: 'Blackjack 結果',
                description,
                playerHand,
                dealerHand: finalDealerHand,
                revealDealer: finalReveal,
            });

            await i.update({ embeds: [finalEmbed], components: [actionRow] });
            collector.stop();
        };

        collector.on('collect', async i => {
            if (i.user.id !== interaction.user.id) {
                await i.reply({ content: 'このゲームは実行した本人のみ操作できます。', flags: 64 });
                return;
            }

            if (i.customId === 'bj_hit') {
                playerHand.push(drawCard());
                const playerTotal = getHandValue(playerHand);

                if (playerTotal > 21) {
                    await endRound(i, '💥 バースト！ディーラーの勝ちです。');
                    return;
                }

                if (playerTotal === 21) {
                    await endRound(i, '🎯 21達成！プレイヤーの勝ちです。');
                    return;
                }

                const updateEmbed = createBlackjackEmbed({
                    description: 'カードを追加しました。もう一度選択してください。',
                    playerHand,
                    dealerHand,
                    revealDealer: false,
                });

                await i.update({ embeds: [updateEmbed], components: [actionRow] });
                return;
            }

            if (i.customId === 'bj_stand') {
                while (getHandValue(dealerHand) < 17) {
                    dealerHand.push(drawCard());
                }

                const playerTotal = getHandValue(playerHand);
                const dealerTotal = getHandValue(dealerHand);

                let resultText = '引き分けです。';

                if (dealerTotal > 21) {
                    resultText = '🤑 ディーラーがバースト！プレイヤーの勝ちです。';
                } else if (playerTotal > dealerTotal) {
                    resultText = '🎉 プレイヤーの勝ちです！';
                } else if (playerTotal < dealerTotal) {
                    resultText = '💸 ディーラーの勝ちです。';
                }

                await endRound(i, resultText, dealerHand, true);
            }
        });

        collector.on('end', (collected, reason) => {
            if (reason === 'time') {
                hitButton.setDisabled(true);
                standButton.setDisabled(true);

                const timeoutEmbed = new EmbedBuilder()
                    .setColor('#f2c94c')
                    .setTitle('Blackjack 結果')
                    .setDescription('⏰ 時間切れです。ゲームを終了しました。');

                interaction.editReply({ embeds: [timeoutEmbed], components: [actionRow] }).catch(() => {});
            }
        });
    },
};

