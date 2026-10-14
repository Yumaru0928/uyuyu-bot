const { Events } = require('discord.js');
const { GoogleGenAI } = require("@google/genai");
const fs = require("node:fs");
const path = require("node:path");

const configPath = path.join(__dirname, "..", "config.json");
let apiKey = process.env.GEMINI_API_KEY;

if (fs.existsSync(configPath)) {
    const config = require(configPath);
    apiKey = config.GEMINI_API_KEY || config.apiKey || apiKey;
}

const ai = new GoogleGenAI({ apiKey: apiKey });

function splitMessage(text, maxLength = 1900) {
    const chunks = [];
    let currentIndex = 0;
    while (currentIndex < text.length) {
        chunks.push(text.slice(currentIndex, currentIndex + maxLength));
        currentIndex += maxLength;
    }
    return chunks;
}

async function urlToGenerativePart(url, mimeType) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`ファイルの取得に失敗しました: ${response.statusText}`);
    const buffer = await response.arrayBuffer();
    return {
        inlineData: {
            data: Buffer.from(buffer).toString("base64"),
            mimeType
        },
    };
}

async function buildChatHistory(message) {
    const history = [];
    let currentMessage = message;

    while (currentMessage && history.length < 10) {
        const isBot = currentMessage.author.id === message.client.user.id;
        const role = isBot ? "model" : "user";
        
        let cleanContent = currentMessage.content;
        if (isBot) {
            cleanContent = cleanContent.replace(/^\(続き\)\s*/, "");
        }

        if (cleanContent.trim()) {
            history.unshift({
                role: role,
                parts: [{ text: cleanContent }]
            });
        }

        if (currentMessage.reference && currentMessage.reference.messageId) {
            try {
                currentMessage = await currentMessage.channel.messages.fetch(currentMessage.reference.messageId);
            } catch (e) {
                break;
            }
        } else {
            break;
        }
    }

    return history;
}

async function generateWithFallback(contents, history, initialMessage) {
    const modelsToTry = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite','gemini-3.1-pro-preview'];
    let lastError = null;

    for (const modelName of modelsToTry) {
        try {
            const chat = ai.chats.create({
                model: modelName,
                history: history
            });
            return await chat.sendMessage({ message: contents });
        } catch (error) {
            lastError = error;
            if (error.status === 404 || error.status === 503 || error.status === 429 || (error.message && (error.message.includes('503') || error.message.includes('not found') || error.message.includes('overloaded')))) {
                console.warn(`[リプライ] モデル ${modelName} が利用できないか混雑中のため、次のモデルにフォールバックします...`);
                try {
                    await initialMessage.edit(`<a:load:1559811422261747783> モデル ${modelName} がレート制限か混雑中のため、次のモデルに切り替えています...`);
                } catch (e) {}
                continue;
            }
            throw error;
        }
    }
    throw lastError;
}

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        if (message.author.bot || !message.reference) return;

        try {
            const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
            if (repliedMessage.author.id !== message.client.user.id) return;

            const initialReply = await message.reply("<a:load:1559811422261747783> AIの応答を待っています...");

            let isCompleted = false;
            const slowTimer = setTimeout(async () => {
                if (!isCompleted) {
                    try {
                        await initialReply.edit("<a:load:1559811422261747783> AIが考え込んでいます…（少々お時間がかかります）");
                    } catch (e) {}
                }
            }, 5000);

            // 添付ファイルの処理（画像、PDF、テキストなど任意の種類に対応）
            let contents = message.content;
            const attachment = message.attachments.first();

            if (attachment) {
                const mimeType = attachment.contentType || "application/octet-stream";
                const filePart = await urlToGenerativePart(attachment.url, mimeType);
                contents = [message.content || "このファイルについて教えてください。", filePart];
            }

            const fullHistory = await buildChatHistory(message);
            const history = fullHistory.slice(0, -1);

            const result = await generateWithFallback(contents, history, initialReply);

            isCompleted = true;
            clearTimeout(slowTimer);

            const replyText = result.text || "応答を取得できませんでした。";
            const textChunks = splitMessage(replyText);

            for (let i = 0; i < textChunks.length; i++) {
                const chunk = textChunks[i];
                // **Gemini:** を除き、本文のみを出力
                const content = (i === 0) ? `${chunk}` : `(続き)\n${chunk}`;

                if (i === 0) {
                    await initialReply.edit({ content: content });
                } else {
                    await message.channel.send({ content: content });
                }
            }

        } catch (error) {
            console.error("Gemini Reply Chat Error:", error);
            try {
                await message.reply("現在、すべてのGeminiモデルがAPI/レート制限のため一時的に利用できません。少し時間をおいてから再度お試しください。");
            } catch (e) {}
        }
    }
};