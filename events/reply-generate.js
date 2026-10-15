const { Events, AttachmentBuilder, MessageReferenceType } = require("discord.js");
const {
    GENERATED_FILE_PREFIX,
    NoImageError,
    urlToGenerativePart,
    mimeToExtension,
    generateImageWithFallback
} = require("../image-generate.js");

const LOADING = "<a:load:1559811422261747783>";

// /generate で作られた画像メッセージかどうか（添付ファイル名のプレフィックスで判定）
function findGeneratedImage(message) {
    return message.attachments.find(a => (a.name || "").startsWith(GENERATED_FILE_PREFIX)) || null;
}

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        if (message.author.bot || !message.reference || !message.reference.messageId) return;
        // 転送メッセージも reference を持つため、通常の返信以外は無視する
        if (message.reference.type === MessageReferenceType.Forward) return;

        try {
            const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
            if (repliedMessage.author.id !== message.client.user.id) return;

            // /generate の生成結果への返信だけを処理する（それ以外は reply-chat.js の担当）
            const generated = findGeneratedImage(repliedMessage);
            if (!generated) return;

            const request = message.content.trim();
            const extraImages = message.attachments.filter(a => (a.contentType || "").startsWith("image/"));

            if (!request && extraImages.size === 0) {
                await message.reply("追加してほしい内容を書いて返信してください！（参考画像の添付もできます）");
                return;
            }

            const initialReply = await message.reply(`${LOADING} 画像を作り直しています...`);

            let isCompleted = false;
            const slowTimer = setTimeout(async () => {
                if (!isCompleted) {
                    try {
                        await initialReply.edit(`${LOADING} 画像を生成しています…（少々お時間がかかります）`);
                    } catch (e) { }
                }
            }, 5000);

            try {
                // 元のプロンプト（/generate が残した「-# プロンプト:」行）を文脈として使う
                const promptMatch = repliedMessage.content.match(/^-# プロンプト: (.*)$/m);
                const originalPrompt = promptMatch ? promptMatch[1] : null;

                const instruction = [
                    "添付した1枚目の画像をベースに、次の追加要望を反映した画像を新しく生成してください。",
                    "要望に関係しない部分（構図・人物・雰囲気など）はできるだけ維持してください。",
                    originalPrompt ? `元のプロンプト: ${originalPrompt}` : null,
                    `追加要望: ${request || "添付した参考画像を反映してください。"}`
                ].filter(Boolean).join("\n");

                const contents = [
                    instruction,
                    await urlToGenerativePart(generated.url, generated.contentType || "image/png")
                ];
                for (const extra of extraImages.values()) {
                    contents.push(await urlToGenerativePart(extra.url, extra.contentType));
                }

                const result = await generateImageWithFallback(contents, async (label) => {
                    await initialReply.edit(`${LOADING} ${label} がレート制限か混雑中のため、次のモデルに切り替えています...`);
                });

                isCompleted = true;
                clearTimeout(slowTimer);

                const fileName = `${GENERATED_FILE_PREFIX}${Date.now()}.${mimeToExtension(result.image.mimeType)}`;
                const file = new AttachmentBuilder(result.image.buffer, { name: fileName });

                // 次の修正でも文脈が引き継がれるよう、元のプロンプトに今回の要望を足して残す
                const nextPrompt = [originalPrompt, request].filter(Boolean).join(" / ");
                const shortPrompt = nextPrompt.length > 500 ? `${nextPrompt.slice(0, 500)}…` : nextPrompt;
                const lines = [
                    `-# 🎨 ${result.modelLabel} で再生成`,
                    `-# プロンプト: ${shortPrompt.replace(/\n/g, " ")}`,
                    `-# このメッセージに返信すると、さらに修正できます`
                ];
                if (result.text) {
                    lines.unshift(result.text.slice(0, 1000));
                }

                await initialReply.edit({
                    content: lines.join("\n"),
                    files: [file]
                });
            } catch (error) {
                isCompleted = true;
                clearTimeout(slowTimer);

                if (error instanceof NoImageError) {
                    console.warn("[reply-generate] 画像が返りませんでした:", error.modelText);
                    const reason = error.modelText ? `\n> ${error.modelText.slice(0, 500)}` : "";
                    await initialReply.edit(`画像を生成できませんでした。要望の書き方を変えて試してみてください。${reason}`);
                    return;
                }

                throw error;
            }
        } catch (error) {
            console.error("Gemini Reply Generate Error:", error);
            try {
                await message.reply("現在、すべての画像生成モデルがAPI/レート制限のため一時的に利用できません。少し時間をおいてから再度お試しください。");
            } catch (e) { }
        }
    }
};
