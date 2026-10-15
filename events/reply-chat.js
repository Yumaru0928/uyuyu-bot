const { Events, AttachmentBuilder } = require('discord.js');
const { GoogleGenAI } = require("@google/genai");
const fs = require("node:fs");
const path = require("node:path");
const { GENERATED_FILE_PREFIX } = require("../image-generate.js");

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

// 言語名から適切な拡張子をマッピングする関数
function getExtension(lang) {
    if (!lang) return "txt";
    const lowerLang = lang.toLowerCase().trim();
    const map = {
        javascript: "js",
        js: "js",
        typescript: "ts",
        ts: "ts",
        python: "py",
        py: "py",
        html: "html",
        css: "css",
        c: "c",
        cpp: "cpp",
        java: "java",
        json: "json",
        markdown: "md",
        md: "md",
        txt: "txt"
    };
    return map[lowerLang] || lowerLang;
}

// ページが分かれてしまうほど長いコードブロックを検出し、ファイル化する関数
function processLongCodeBlocks(replyText) {
    const attachments = [];
    let processedText = replyText;
    const codeBlockRegex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
    let match;
    let fileCount = 0;

    while ((match = codeBlockRegex.exec(replyText)) !== null) {
        const language = match[1] || "";
        const codeContent = match[2];

        if (codeContent.length > 1000) {
            fileCount++;
            const extension = getExtension(language);
            const fileName = `code_${fileCount}.${extension}`;

            const buffer = Buffer.from(codeContent, "utf-8");
            attachments.push(new AttachmentBuilder(buffer, { name: fileName }));

            const replacement = `\n*(※ 長いコードのため、ファイル \`${fileName}\` として添付しました)*\n`;
            processedText = processedText.replace(match[0], replacement);
        }
    }

    return { processedText, attachments };
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
    const modelsToTry = ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview'];
    let lastError = null;

    for (const modelName of modelsToTry) {
        try {
            const chat = ai.chats.create({
                model: modelName,
                config: {
                    systemInstruction: "あなたはDiscordのbotとして動作するAIです。botの名称は「うゆゆ」。回答は必ず日本語で、口調は少し砕けても大丈夫です。画像生成をお願いされたときは、/generateを使用することを促してください。同時にGemini Nano Banana用にプロンプトを考えてあげて、```/generate prompt:[gemini-nano-banana用のプロンプト]```を出力させてあげてください。"
                },
                history: history
            });
            return await chat.sendMessage({ message: contents });
        } catch (error) {
            lastError = error;
            if (error.status === 404 || error.status === 503 || error.status === 429 || (error.message && (error.message.includes('503') || error.message.includes('not found') || error.message.includes('overloaded')))) {
                console.warn(`[リプライ] モデル ${modelName} が利用できないか混雑中のため、次のモデルにフォールバックします...`);
                try {
                    await initialMessage.edit(`<a:load:1559811422261747783> モデル ${modelName} がレート制限か混雑中のため、次のモデルに切り替えています...`);
                } catch (e) { }
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

            // /generate の生成画像への返信は reply-generate.js が担当するので、ここでは何もしない
            if (repliedMessage.attachments.some(a => (a.name || "").startsWith(GENERATED_FILE_PREFIX))) return;

            const initialReply = await message.reply("<a:load:1559811422261747783> AIの応答を待っています...");

            let isCompleted = false;
            const slowTimer = setTimeout(async () => {
                if (!isCompleted) {
                    try {
                        await initialReply.edit("<a:load:1559811422261747783> AIが考え込んでいます…（少々お時間がかかります）");
                    } catch (e) { }
                }
            }, 5000);

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

            // 長いコードのファイル化処理（プレフィックスなし）
            const { processedText, attachments } = processLongCodeBlocks(replyText);
            const textChunks = splitMessage(processedText);

            for (let i = 0; i < textChunks.length; i++) {
                const chunk = textChunks[i];
                const content = (i === 0) ? chunk : `(続き)\n${chunk}`;
                const options = {
                    content: content,
                    files: (i === 0) ? attachments : []
                };

                if (i === 0) {
                    await initialReply.edit(options);
                } else {
                    await message.channel.send(options);
                }
            }

        } catch (error) {
            console.error("Gemini Reply Chat Error:", error);
            try {
                await message.reply("現在、すべてのGeminiモデルがAPI/レート制限のため一時的に利用できません。少し時間をおいてから再度お試しください。");
            } catch (e) { }
        }
    }
};