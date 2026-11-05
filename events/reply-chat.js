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
    createCooldown
} = require('../gemini.js');
const { buildReplyMessages } = require('../latex-render.js');
const {
    QUESTION_HEADER,
    registerAiMessage,
    isAiMessage,
    getPrevAiMessageId,
    getAiThreadStarter
} = require('../ai-messages.js');

// 同じ人の連続した返信は 5 秒に 1 回まで（API 枠の使い切り防止）
const isCoolingDown = createCooldown(5000);

const MAX_HISTORY = 20;             // 返信をさかのぼって読む最大メッセージ数
const MAX_THREAD_HISTORY = 200;     // AI スレッドで読み込む最大メッセージ数（巨大なスレッド対策）
const MAX_ATTACHMENT_MB = 20;       // Gemini にインラインで送れるサイズの目安

// ローディング表示とエラー文（履歴に入れない）
const isStatusText = text => text.startsWith(LOADING) || text.startsWith('⚠️');

// ボットの発言を、AI に見せる元の形に戻す
function cleanBotText(text) {
    return text
        .replace(/^\(続き\)\s*/, '')
        // 画像化のために付けた ```latex ブロックは、元の $$ ... $$ に戻す
        .replace(/```latex\n([\s\S]*?)\n```/g, (_, tex) => `$$\n${tex}\n$$`);
}

// Gemini は先頭が user でないとエラーになることがあるので、先頭の model は捨てる。
// 同じロールが続く場合は 1 つにまとめる。
function normalizeHistory(raw) {
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

// 返信先から親をさかのぼって、会話履歴を作る（今回の発言は含めない）
async function buildChatHistory(repliedMessage) {
    const raw = [];
    let current = repliedMessage;

    while (current && raw.length < MAX_HISTORY) {
        const isBot = current.author.id === current.client.user.id;

        let text = current.content || '';
        if (isBot) text = cleanBotText(text);
        if (text.trim()) raw.unshift({ role: isBot ? 'model' : 'user', text });

        // 回答の「続き」は返信ではないので、記録をたどって1つ前のメッセージへ。
        // それ以外は返信先（reference）へ。
        let nextId = isBot ? getPrevAiMessageId(current.id) : null;
        if (!nextId) {
            const ref = current.reference;
            if (!ref || !ref.messageId || ref.type === MessageReferenceType.Forward) break;
            nextId = ref.messageId;
        }
        try {
            current = await current.channel.messages.fetch(nextId);
        } catch (e) {
            break;
        }
    }

    return normalizeHistory(raw);
}

// ---------- AI スレッド ----------
// 最初の質問を読み取る。長すぎて prompt.txt に逃がしている場合は、そちらを読む
async function readQuestion(starter) {
    const file = starter.attachments.find(a => a.name === 'prompt.txt');
    if (file) {
        try {
            const res = await fetch(file.url);
            if (res.ok) return (await res.text()).trim();
        } catch (e) { /* 本文のほうを使う */ }
    }
    return starter.content.replace(QUESTION_HEADER, '').replace(/^\s*>>> ?/, '').trim();
}

// スレッド内のメッセージを、beforeId より前のものから古い順に最大 cap 件読む
async function fetchThreadMessages(thread, beforeId, cap) {
    const collected = [];
    let before = beforeId;
    while (collected.length < cap) {
        const batch = await thread.messages.fetch({ before, limit: 100 });
        if (batch.size === 0) break;
        const items = [...batch.values()];
        collected.push(...items);
        before = items.reduce((min, m) => (BigInt(m.id) < BigInt(min) ? m.id : min), items[0].id);
        if (batch.size < 100) break;
    }
    return collected
        .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1))   // 新しい順
        .slice(0, cap)
        .reverse();                                                  // 古い順
}

// AI スレッドの履歴: 最初の質問 + スレッド内のすべてのメッセージ（今回の発言は含めない）
async function buildThreadHistory(thread, starter, currentId) {
    const raw = [{ role: 'user', text: await readQuestion(starter) }];

    for (const m of await fetchThreadMessages(thread, currentId, MAX_THREAD_HISTORY)) {
        if (m.system) continue;
        const isBot = m.author.id === m.client.user.id;
        if (m.author.bot && !isBot) continue;   // 他の Bot の発言は入れない

        let text = m.content || '';
        if (isBot) {
            if (isStatusText(text)) continue;
            text = cleanBotText(text);
        } else if (m.attachments.size) {
            text += `\n[添付ファイル: ${[...m.attachments.values()].map(a => a.name).join(', ')}]`;
        }
        if (text.trim()) raw.push({ role: isBot ? 'model' : 'user', text });
    }
    return normalizeHistory(raw);
}

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        if (message.author.bot) return;
        const botId = message.client.user.id;

        // /chat で作った AI スレッドの中なら、返信しなくても全部の発言に反応する
        const threadStarter = await getAiThreadStarter(message.channel, botId);

        let repliedMessage = null;
        if (!threadStarter) {
            const ref = message.reference;
            if (!ref || !ref.messageId) return;
            // 転送メッセージも reference を持つため、通常の返信以外は無視する
            if (ref.type === MessageReferenceType.Forward) return;

            try {
                repliedMessage = await message.channel.messages.fetch(ref.messageId);
            } catch (e) {
                return; // 返信先が削除済みなど。何もしない
            }
            // AI の回答への返信だけに反応する。
            // 他のコマンドの出力・ローディング表示・エラー文などへの返信は無視
            if (repliedMessage.author.id !== botId || !isAiMessage(repliedMessage.id)) return;
        }

        let initialReply = null;
        let slowTimer = null;
        let finished = false;
        let delivered = false;   // 最初のメッセージを送れたか

        try {
            // 本文も添付も無い返信（スタンプだけなど）は AI に送れない
            const text = message.content.trim();
            const attachment = message.attachments.first();
            if (!text && !attachment) return;

            if (attachment && attachment.size > MAX_ATTACHMENT_MB * 1024 * 1024) {
                await message.reply({
                    content: `添付ファイルが大きすぎます（${MAX_ATTACHMENT_MB}MB まで）。`,
                    allowedMentions: NO_MENTIONS
                });
                return;
            }

            if (isCoolingDown(message.author.id)) {
                await message.react('⏳').catch(() => { });
                return;
            }

            getAI(); // API キー未設定ならここで GeminiConfigError

            // スレッドの中は一本道の会話なので、返信の形にしない（返信アイコンを出さない）
            const send = options => threadStarter ? message.channel.send(options) : message.reply(options);

            initialReply = await send({
                content: `${LOADING} AIの応答を待っています...`,
                allowedMentions: NO_MENTIONS
            });

            slowTimer = setTimeout(() => {
                if (finished) return;
                initialReply.edit(`${LOADING} AIが考え込んでいます…（少々お時間がかかります）`).catch(() => { });
            }, 5000);

            const history = threadStarter
                ? await buildThreadHistory(message.channel, threadStarter, message.id)
                : await buildChatHistory(repliedMessage);

            // 履歴の末尾が user だと user が連続して API エラーになることがある
            // （画像だけのボット発言が履歴から抜けた場合など）ので、今回の発言にまとめる
            let userText = text;
            const lastTurn = history[history.length - 1];
            if (lastTurn?.role === 'user') {
                history.pop();
                userText = `${lastTurn.parts[0].text}\n\n${text}`.trim();
            }

            let contents = userText;
            if (attachment) {
                const mimeType = attachment.contentType || 'application/octet-stream';
                const filePart = await urlToGenerativePart(attachment.url, mimeType);
                contents = [userText || 'このファイルについて教えてください。', filePart];
            }

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
                }).catch(() => { }),
                'リプライ'
            );

            finished = true;
            clearTimeout(slowTimer);

            const replyText = (result.text ?? '').trim();
            const messages = await buildReplyMessages(replyText);
            const showContinuation = !messages.hasLatexImage;

            let prevId = null;
            for (let i = 0; i < messages.length; i++) {
                const m = messages[i];
                let sent;
                if (i === 0) {
                    sent = await initialReply.edit({ content: m.content, files: m.files, allowedMentions: NO_MENTIONS });
                    delivered = true;
                } else {
                    sent = await message.channel.send({
                        content: (m.content && showContinuation) ? `(続き)\n${m.content}` : (m.content || undefined),
                        files: m.files,
                        allowedMentions: NO_MENTIONS
                    });
                }
                // AI の回答として記録する（スレッドの外だけ。スレッド内は履歴を全部読むので不要）
                if (!threadStarter) registerAiMessage(sent.id, i === 0 ? null : prevId);
                prevId = sent.id;
            }
        } catch (error) {
            finished = true;
            clearTimeout(slowTimer);
            console.error('Gemini Reply Chat Error:', error);

            // すでに回答を表示できている場合は、エラー文で上書きしない
            if (delivered) {
                await message.channel.send({
                    content: '⚠️ 回答の一部を送信できませんでした。',
                    allowedMentions: NO_MENTIONS
                }).catch(() => { });
                return;
            }

            const notice = `⚠️ ${describeError(error, 'AI')}`;
            try {
                if (initialReply) {
                    // ローディング表示を残さず、エラー文に書き換える
                    await initialReply.edit({ content: notice, files: [], allowedMentions: NO_MENTIONS });
                } else {
                    await message.reply({ content: notice, allowedMentions: NO_MENTIONS });
                }
            } catch (e) { }
        } finally {
            finished = true;
            clearTimeout(slowTimer);
        }
    }
};