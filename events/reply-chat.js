const { Events } = require('discord.js');
const { GoogleGenAI } = require("@google/genai");
const fs = require("node:fs");
const path = require("node:path");

// config.json から API キーを安全に読み込む
const configPath = path.join(__dirname, "..", "config.json");
let apiKey = process.env.GEMINI_API_KEY;

if (fs.existsSync(configPath)) {
    const config = require(configPath);
    apiKey = config.GEMINI_API_KEY || config.apiKey || apiKey;
}

const ai = new GoogleGenAI({ apiKey: apiKey });

// 2000文字の制限に合わせてテキストを分割する関数
function splitMessage(text, maxLength = 1900) {
    const chunks = [];
    let currentIndex = 0;
    while (currentIndex < text.length) {
        chunks.push(text.slice(currentIndex, currentIndex + maxLength));
        currentIndex += maxLength;
    }
    return chunks;
}

// 過去の返信チェーンを辿って、会話の履歴（コンテキスト）を組み立てる関数
async function buildChatHistory(message) {
    const history = [];
    let currentMessage = message;

    while (currentMessage && history.length < 10) {
        const isBot = currentMessage.author.id === message.client.user.id;
        const role = isBot ? "model" : "user";
        
        let cleanContent = currentMessage.content;
        if (isBot) {
            cleanContent = cleanContent.replace(/^\*\*Gemini:\*\*\s*/, "").replace(/^\(続き\)\s*/, "");
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

// フォールバック付きでGeminiにチャットを送信する共通関数
async function generateWithFallback(prompt, history) {
    const modelsToTry = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
    let lastError = null;

    for (const modelName of modelsToTry) {
        try {
            const chat = ai.chats.create({
                model: modelName,
                history: history
            });
            return await chat.sendMessage({ message: prompt });
        } catch (error) {
            lastError = error;
            if (error.status === 503 || error.status === 429 || (error.message && (error.message.includes('503') || error.message.includes('overloaded')))) {
                console.warn(`モデル ${modelName} が混雑中のため、次のモデルにフォールバックします...`);
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
        // 1. ボット自身のメッセージ、またはリプライ（返信）ではないものは無視
        if (message.author.bot || !message.reference) return;

        try {
            // 返信先のメッセージを取得
            const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
            
            // 2. 返信先がこのボットのメッセージではない場合は無視
            if (repliedMessage.author.id !== message.client.user.id) return;

            // タイピングインジケータを表示
            await message.channel.sendTyping();

            // 3. 過去の会話履歴を構築（最新の入力以外を履歴にする）
            const fullHistory = await buildChatHistory(message);
            const history = fullHistory.slice(0, -1);

            // 4. Geminiへ送信して返信を取得
            const result = await generateWithFallback(message.content, history);

            const replyText = result.text || "応答を取得できませんでした。";
            const textChunks = splitMessage(replyText);

            // 5. 分割して返信
            for (let i = 0; i < textChunks.length; i++) {
                const chunk = textChunks[i];
                const content = (i === 0) ? `**Gemini:**\n${chunk}` : `(続き)\n${chunk}`;

                if (i === 0) {
                    await message.reply({ content: content });
                } else {
                    await message.channel.send({ content: content });
                }
            }

        } catch (error) {
            console.error("Gemini Reply Chat Error:", error);
            await message.reply("エラーが発生したため、応答を取得できませんでした。");
        }
    }
};