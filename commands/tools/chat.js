const {
    SlashCommandBuilder,
    ApplicationIntegrationType,
    InteractionContextType
} = require("discord.js");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("chat")
        .setDescription("対話テスト モデル：sarashina-3-mini")
        .addStringOption(option =>
            option.setName("prompt")
                .setDescription("AIに送るメッセージを入力してください")
                .setRequired(true)
        )
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
        const userPrompt = interaction.options.getString("prompt");

        // 生成や通信に数秒かかるため、タイムアウト（3秒）を防ぐために一時応答を行う
        await interaction.deferReply();

        try {
            // 例: OpenAI互換APIまたはエンドポイントへリクエストを送る場合
            const response = await fetch("https://api.sarashina.ai/v1/chat/completions", { // ※実際のAPIエンドポイントに変更してください
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${process.env.SARASHINA_API_KEY}` // 必要に応じて環境変数等を使用
                },
                body: JSON.stringify({
                    model: "sarashina-3-mini",
                    messages: [
                        { role: "user", content: userPrompt }
                    ],
                    temperature: 0.7
                })
            });

            if (!response.ok) {
                throw new Error(`APIエラー: ${response.statusText}`);
            }

            const data = await response.json();
            const replyText = data.choices?.[0]?.message?.content || "応答を取得できませんでした。";

            // Discordのメッセージ文字数制限（2000文字）に配慮して返答
            const finalContent = `**質問:** ${userPrompt}\n\n**sarashina-3-mini:**\n${replyText}`;
            if (finalContent.length > 2000) {
                await interaction.editReply(finalContent.slice(0, 1990) + "...");
            } else {
                await interaction.editReply(finalContent);
            }

        } catch (error) {
            console.error("Sarashina API Call Error:", error);
            await interaction.editReply("エラーが発生したため、sarashina-3-miniからの応答を取得できませんでした。");
        }
    }
};