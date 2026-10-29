const { Events, MessageReferenceType } = require('discord.js');
const {
    LOADING,
    NO_MENTIONS,
    CHAT_MODELS,
    CHAT_SYSTEM_INSTRUCTION,
    getAI,
    describeError,
    withModelFallback,
    urlToGenerativePart,
    splitMessage,
    processLongCodeBlocks,
    createCooldown
} = require('../gemini.js');
const { buildReplyMessages } = require('../latex-render.js');

// 同じ人の連続した返信は 5 秒に 1 回まで（API 枠の使い切り防止）
const isCoolingDown = createCooldown(5000);

const MAX_HISTORY = 10;

// 返信先から親をさかのぼって、会話履歴を作る（今回の発言は含めない）
async function buildChatHistory(repliedMessage) {
    const raw = [];
    let current = repliedMessage;

    while (current && raw.length < MAX_HISTORY) {
        const isBot = current.author.id === current.client.user.id;

        let text = current.content || '';
        if (isBot) text = text.replace(/^\(続き\)\s*/, '');
        if (text.trim()) raw.unshift({ role: isBot ? 'model' : 'user', text });

        const ref = current.reference;
        if (!ref || !ref.messageId || ref.type === MessageReferenceType.Forward) break;
        try {
            current = await current.channel.messages.fetch(ref.messageId);
        } catch (e) {
            break;
        }
    }

    // Gemini は先頭が user でないとエラーになることがあるので、先頭の model は捨てる。
    // 同じロールが続く場合は 1 つにまとめる。
    const history = [];
    for (const item of raw) {
        const last = history[history.length - 1];
        if (last && last.role === item.role) {
            last.parts[0].text += `\n\n${item.text}`;
        } else if (history.length === 0 && item.role === 'model') {
            continue;
        } else {
            history.push({ role: item.role, parts: [{ text: item.text }] });
        }
    }
    return history;
}

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        if (message.author.bot || !message.reference || !message.reference.messageId) return;
        // 転送メッセージも reference を持つため、通常の返信以外は無視する
        if (message.reference.type === MessageReferenceType.Forward) return;

        let initialReply = null;
        let slowTimer = null;
        let finished = false;

        try {
            let repliedMessage;
            try {
                repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
            } catch (e) {
                return; // 返信先が削除済みなど。何もしない
            }
            if (repliedMessage.author.id !== message.client.user.id) return;

            // 本文も添付も無い返信（スタンプだけなど）は AI に送れない
            const text = message.content.trim();
            const attachment = message.attachments.first();
            if (!text && !attachment) return;

            if (isCoolingDown(message.author.id)) {
                await message.react('⏳').catch(() => { });
                return;
            }

            getAI(); // API キー未設定ならここで GeminiConfigError

            initialReply = await message.reply(`${LOADING} AIの応答を待っています...`);

            slowTimer = setTimeout(() => {
                if (finished) return;
                initialReply.edit(`${LOADING} AIが考え込んでいます…（少々お時間がかかります）`).catch(() => { });
            }, 5000);

            let contents = text;
            if (attachment) {
                const mimeType = attachment.contentType || 'application/octet-stream';
                const filePart = await urlToGenerativePart(attachment.url, mimeType);
                contents = [text || 'このファイルについて教えてください。', filePart];
            }

            const history = await buildChatHistory(repliedMessage);

            const result = await withModelFallback(
                CHAT_MODELS,
                model => getAI().chats.create({
                    model,
                    config: { systemInstruction: CHAT_SYSTEM_INSTRUCTION },
                    history
                }).sendMessage({ message: contents }),
                model => initialReply.edit({
                    content: `${LOADING} モデル ${model} がレート制限か混雑中のため、次のモデルに切り替えています...`,
                    allowedMentions: NO_MENTIONS
                }),
                'リプライ'
            );

            finished = true;
            clearTimeout(slowTimer);

            const messages = await buildReplyMessages(replyText);
            const showContinuation = !messages.hasLatexImage;

            for (let i = 0; i < messages.length; i++) {
                const m = messages[i];
                if (i === 0) {
                    await initialReply.edit({ content: m.content, files: m.files, allowedMentions: NO_MENTIONS });
                } else {
                    await message.channel.send({
                        content: (m.content && showContinuation) ? `(続き)\n${m.content}` : (m.content || undefined),
                        files: m.files,
                        allowedMentions: NO_MENTIONS
                    });
                }
            }
        } catch (error) {
            finished = true;
            clearTimeout(slowTimer);
            console.error('Gemini Reply Chat Error:', error);

            const notice = describeError(error, 'AI');
            try {
                if (initialReply) {
                    // ローディング表示を残さず、エラー文に書き換える
                    await initialReply.edit({ content: notice, files: [], allowedMentions: NO_MENTIONS });
                } else {
                    await message.reply(notice);
                }
            } catch (e) { }
        } finally {
            finished = true;
            clearTimeout(slowTimer);
        }
    }
};
