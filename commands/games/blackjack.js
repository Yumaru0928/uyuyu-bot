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

// 最初の2枚で21（A + 10点札）＝ ブラックジャック
const isBlackjack = hand => hand.length === 2 && getHandValue(hand) === 21;

function createBlackjackEmbed({ description, playerHand, dealerHand, revealDealer, title = 'Blackjack' }) {
    const playerTotal = getHandValue(playerHand);
    const dealerTotal = getHandValue(dealerHand);

    // 伏せ札は「??」で表す（1か所だけで付ける）
    const dealerCards = revealDealer
        ? `${dealerHand.map(formatCard).join(' ')} (${dealerTotal})`
        : `${formatCard(dealerHand[0])} ??`;

    const playerCards = playerHand.map(formatCard).join(' ');

    return new EmbedBuilder()
        .setColor('#f2c94c')
        .setTitle(title)
        .setDescription(description)
        .addFields(
            { name: 'ディーラー', value: dealerCards, inline: false },
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

        // ディーラーが17以上になるまでカードを引き、勝敗の文章を返す
        const settle = () => {
            while (getHandValue(dealerHand) < 17) {
                dealerHand.push(drawCard());
            }

            const playerTotal = getHandValue(playerHand);
            const dealerTotal = getHandValue(dealerHand);

            if (playerTotal > 21) return '💥 バースト！ディーラーの勝ちです。';
            if (dealerTotal > 21) return '🤑 ディーラーがバースト！プレイヤーの勝ちです。';
            if (playerTotal > dealerTotal) return '🎉 プレイヤーの勝ちです！';
            if (playerTotal < dealerTotal) return '💸 ディーラーの勝ちです。';
            return '引き分けです。';
        };

        // 最初の2枚で決着がつく場合（ブラックジャック）は、ボタンを出さずに結果を表示する
        if (isBlackjack(playerHand) || isBlackjack(dealerHand)) {
            let description = '引き分けです。（どちらもブラックジャック）';
            if (isBlackjack(playerHand) && !isBlackjack(dealerHand)) {
                description = '🃏 **ブラックジャック！** プレイヤーの勝ちです！';
            } else if (!isBlackjack(playerHand)) {
                description = '💸 ディーラーがブラックジャック。ディーラーの勝ちです。';
            }

            await interaction.reply({
                embeds: [createBlackjackEmbed({
                    title: 'Blackjack 結果',
                    description,
                    playerHand,
                    dealerHand,
                    revealDealer: true,
                })],
            });
            return;
        }

        const initialEmbed = createBlackjackEmbed({
            description: 'カードを引くか、スタンドしてディーラーと対戦します。',
            playerHand,
            dealerHand,
            revealDealer: false,
        });

        // 返信したメッセージを受け取る（fetchReply は非推奨なので withResponse を使う）
        const replied = await interaction.reply({
            embeds: [initialEmbed],
            components: [actionRow],
            withResponse: true
        });

        const collector = replied.resource.message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60000,
        });

        const endRound = async (i, description) => {
            hitButton.setDisabled(true);
            standButton.setDisabled(true);

            const finalEmbed = createBlackjackEmbed({
                title: 'Blackjack 結果',
                description,
                playerHand,
                dealerHand,
                revealDealer: true,
            });

            await i.update({ embeds: [finalEmbed], components: [actionRow] });
            collector.stop();
        };

        collector.on('collect', async i => {
            if (i.user.id !== interaction.user.id) {
                await i.reply({ content: 'このゲームは実行した本人のみ操作できます。', flags: MessageFlags.Ephemeral });
                return;
            }

            if (i.customId === 'bj_hit') {
                playerHand.push(drawCard());
                const playerTotal = getHandValue(playerHand);

                if (playerTotal > 21) {
                    await endRound(i, settle());
                    return;
                }

                // 21になったら、それ以上引く意味がないので自動でスタンド（ディーラーが21なら引き分け）
                if (playerTotal === 21) {
                    await endRound(i, `🎯 21達成！\n${settle()}`);
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
                await endRound(i, settle());
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
