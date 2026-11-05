const {
    SlashCommandBuilder,
    ApplicationIntegrationType,
    InteractionContextType,
    AttachmentBuilder,
    MessageFlags
} = require("discord.js");
const {
    LOADING,
    NO_MENTIONS,
    CHAT_MODELS,
    CHAT_SYSTEM_INSTRUCTION,
    getAI,
    describeError,
    withModelFallback,
    urlToGenerativePart
} = require("../../gemini.js");
const { buildReplyMessages } = require("../../latex-render.js");
const { QUESTION_HEADER, registerAiMessage } = require("../../ai-messages.js");

// スレッドの元メッセージに表示する質問の最大文字数（超えた分は prompt.txt に逃がす）
const QUESTION_MAX = 1700;

async function generateWithFallback(selectedModel, contents, onFallback) {
    const modelsToTry = [selectedModel, ...CHAT_MODELS.filter(m => m !== selectedModel)];
    return withModelFallback(
        modelsToTry,
        model => getAI().models.generateContent({
            model,
            config: { systemInstruction: CHAT_SYSTEM_INSTRUCTION },
            contents
        }),
        onFallback,
        "chat"
    );
}

function threadName(prompt) {
    const flat = prompt.replace(/\s+/g, " ").trim();
    return [...flat].slice(0, 90).join("") || "AIチャット";
}

/**
 * スレッドの元になるメッセージ（最初の質問）を /chat の返信として表示し、そこからスレッドを作る。
 * 作れなかったときは理由を本人にだけ伝えて null を返す（呼び出し側は通常の返信で続ける）。
 */
async function openThread(interaction, prompt, attachment) {
    let reason = null;
    if (!interaction.inGuild() || !interaction.channel) {
        reason = "DM ではスレッドを作成できません";
    } else if (interaction.channel.isThread()) {
        reason = "スレッドの中では新しいスレッドを作成できません";
    }

    if (!reason) {
        try {
            const chars = [...prompt];
            const tooLong = chars.length > QUESTION_MAX;
            const shown = tooLong
                ? `${chars.slice(0, QUESTION_MAX).join("")}…\n（全文は添付の prompt.txt）`
                : prompt;
            const starter = await interaction.editReply({
                content: `${QUESTION_HEADER}\n>>> ${shown}${attachment ? `\n📎 ${attachment.name}` : ""}`,
                files: tooLong ? [new AttachmentBuilder(Buffer.from(prompt, "utf-8"), { name: "prompt.txt" })] : [],
                allowedMentions: NO_MENTIONS
            });
            return await starter.startThread({ name: threadName(prompt), autoArchiveDuration: 1440 });
        } catch (error) {
            console.warn("[chat] スレッドを作成できませんでした:", error.message);
            reason = "スレッドを作成できませんでした（Bot に「公開スレッドの作成」「スレッドでメッセージを送信」の権限があるか確認してください）";
            // 質問を表示していた返信を元に戻す（prompt.txt も外す）
            await interaction.editReply({
                content: `${LOADING} AIの応答を待っています...`,
                attachments: [],
                allowedMentions: NO_MENTIONS
            }).catch(() => { });
        }
    }

    await interaction.followUp({
        content: `⚠️ ${reason}。通常の返信で回答します。`,
        flags: MessageFlags.Ephemeral
    }).catch(() => { });
    return null;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName("chat")
        .setDescription("Gemini モデルと対話します")
        .addStringOption(option =>
            option.setName("prompt")
                .setDescription("AIに送るメッセージを入力してください")
                .setRequired(true)
        )
        .addBooleanOption(option =>
            option.setName("thread")
                .setDescription("スレッドを作成して、その中で会話を続けますか？")
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName("model")
                .setDescription("使用するGeminiモデルを選択してください（省略時はデフォルト）")
                .setRequired(false)
                .addChoices(
                    { name: 'Gemini 3.8 Flash', value: 'gemini-3.8-flash' },
                    { name: 'Gemini 3.6 Flash', value: 'gemini-3.6-flash' },
                    { name: 'Gemini 3.5 Flash Lite', value: 'gemini-3.5-flash-lite' },
                    { name: 'Gemini 3.1 Flash Lite', value: 'gemini-3.1-flash-lite' },
                    { name: 'Gemini 3.1 Pro Preview', value: 'gemini-3.1-pro-preview' },
                    { name: 'Gemini 4 Argon', value: 'gemini-4-argon' }
                )
        )
        .addAttachmentOption(option =>
            option.setName("attachment")
                .setDescription("一緒に送信するファイル（画像、PDF、テキストなど）")
                .setRequired(false)
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
        const wantThread = interaction.options.getBoolean("thread");
        const selectedModel = interaction.options.getString("model") || CHAT_MODELS[0];
        const attachment = interaction.options.getAttachment("attachment");

        await interaction.deferReply();

        // スレッドを作る場合は、先に作ってしまって、回答はスレッドの中に出す
        const thread = wantThread ? await openThread(interaction, userPrompt, attachment) : null;

        let statusMessage = null;   // スレッド内の「応答を待っています」メッセージ（のちに回答の1通目になる）
        const editFirst = options => thread ? statusMessage.edit(options) : interaction.editReply(options);

        let isCompleted = false;
        let delivered = false;
        let slowTimer = null;

        try {
            if (thread) {
                statusMessage = await thread.send({
                    content: `${LOADING} AIの応答を待っています...`,
                    allowedMentions: NO_MENTIONS
                });
            }

            slowTimer = setTimeout(async () => {
                if (!isCompleted) {
                    try {
                        await editFirst(`${LOADING} AIが考え込んでいます…（少々お時間がかかります）`);
                    } catch (e) { }
                }
            }, 5000);

            let contents = userPrompt;

            if (attachment) {
                const mimeType = attachment.contentType || "application/octet-stream";
                const filePart = await urlToGenerativePart(attachment.url, mimeType);
                contents = [userPrompt, filePart];
            }

            const response = await generateWithFallback(
                selectedModel,
                contents,
                model => editFirst({
                    content: `${LOADING} モデル ${model} がレート制限か混雑中のため、次のモデルに切り替えています...`,
                    allowedMentions: NO_MENTIONS
                })
            );

            isCompleted = true;
            clearTimeout(slowTimer);

            const replyText = response.text || "応答を取得できませんでした。";

            const messages = await buildReplyMessages(replyText);
            // 数式画像がある応答では「(続き)」を付けない
            const showContinuation = !messages.hasLatexImage;

            let prevId = null;
            for (let i = 0; i < messages.length; i++) {
                const m = messages[i];
                const options = {
                    content: (i === 0 || !m.content || !showContinuation) ? m.content : `(続き)\n${m.content}`,
                    files: m.files,
                    allowedMentions: NO_MENTIONS
                };

                let sent;
                if (i === 0) {
                    sent = await editFirst(options);
                    delivered = true;
                } else if (thread) {
                    sent = await thread.send(options);
                } else if (messages.hasLatexImage) {
                    // followUp だと「/chat を使用しました」のリプライ表示が付くので、
                    // 画像がある場合は通常のメッセージとして送る
                    try {
                        sent = await interaction.channel.send(options);
                    } catch (e) {
                        // Bot がチャンネルにいない場合（ユーザーインストールのDMなど）は followUp に戻す
                        sent = await interaction.followUp(options);
                    }
                } else {
                    sent = await interaction.followUp(options);
                }

                // AI の回答として記録する（スレッドの外だけ。スレッド内は履歴を全部読むので不要）
                if (!thread) registerAiMessage(sent.id, i === 0 ? null : prevId);
                prevId = sent.id;
            }
        } catch (error) {
            isCompleted = true;
            clearTimeout(slowTimer);
            console.error("Gemini API Call Error:", error);

            try {
                if (delivered) {
                    // すでに回答を表示できている場合は、エラー文で上書きしない
                    await interaction.followUp({
                        content: "⚠️ 回答の一部を送信できませんでした。",
                        flags: MessageFlags.Ephemeral
                    });
                } else {
                    const options = { content: `⚠️ ${describeError(error, "AI")}`, files: [], allowedMentions: NO_MENTIONS };
                    // スレッドの中の「待っています」メッセージがあればそれを書き換える。
                    // なければ（スレッド内に送れなかった場合など）/chat の返信を書き換える
                    if (thread && statusMessage) await statusMessage.edit(options);
                    else await interaction.editReply(options);
                }
            } catch (replyError) {
                console.error("[chat] エラー応答の送信に失敗しました:", replyError.message);
            }
        }
    }
};