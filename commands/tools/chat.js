const {
    SlashCommandBuilder,
    ApplicationIntegrationType,
    InteractionContextType
} = require("discord.js");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("chat")
        .setDescription("sarashina3-mini モデルと対話します")
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

        // Discordの3秒タイムアウトを防ぐため、一時応答（思考中）にする
        await interaction.deferReply();

        try {
            const response = await fetch("https://api.sarashina.ai/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${process.env.SARASHINA_API_KEY}`
                },
                body: JSON.stringify({
                    model: "sarashina3-mini", // ※ 正式なモデル名
                    messages: [
                        { role: "user", content: userPrompt }
                    ],
                    temperature: 0.7
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error("APIエラーの詳細:", errorText);
                throw new Error(`APIエラー: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            const replyText = data.choices?.[0]?.message?.content || "応答を取得できませんでした。";

            // Discordのメッセージ文字数制限（2000文字）に配慮して返答
            const finalContent = `**質問:** ${userPrompt}\n\n**sarashina3-mini:**\n${replyText}`;
            if (finalContent.length > 2000) {
                await interaction.editReply(finalContent.slice(0, 1990) + "...");
            } else {
                await interaction.editReply(finalContent);
            }

        } catch (error) {
            console.error("Sarashina API Call Error:", error);
            await interaction.editReply("エラーが発生したため、sarashina3-miniからの応答を取得できませんでした。");
        }
    }
};