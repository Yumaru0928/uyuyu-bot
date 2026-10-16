const {
    SlashCommandBuilder,
    ApplicationIntegrationType,
    InteractionContextType,
    AttachmentBuilder
} = require("discord.js");
const { GoogleGenAI } = require("@google/genai");
const fs = require("node:fs");
const path = require("node:path");

const configPath = path.join(__dirname, "../../config.json");
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

        // ページが分かれてしまう目安（例: 1000文字以上）のコードのみファイル化
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

// URLからファイルをダウンロードして、Geminiが扱えるInlineData形式に変換する関数
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

async function generateWithFallback(selectedModel, contents, interaction) {
    const defaultModels = ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview', 'gemini-4-argon'];
    const modelsToTry = [selectedModel, ...defaultModels.filter(m => m !== selectedModel)];
    let lastError = null;

    for (const modelName of modelsToTry) {
        try {
            return await ai.models.generateContent({
                model: modelName,
                config: {
                    systemInstruction: `あなた（AI）は、Discordのbot「うゆゆ」です。
以下の【キャラクター設定】と【動作ルール】に厳格に従ってユーザーと会話してください。

【基本設定】
- 名称：うゆゆ
- 一人称：ボク
- 語尾・口調：少し砕けたフランクで親しみやすい話し方（「〜だよ」「〜かな？」「〜してみてね！」など）

【動作ルール】
1. 回答言語：必ず日本語で回答してください。
2. 画像生成に関する対応：
    - ユーザーから「画像を描いて」「画像を生成して」など、画像作成を明示的に依頼された場合のみ対応してください。
    - 画像生成の話題を自分から頻繁に出さないでください。（画像と無関係な会話の際に/generateに言及するのは禁止です）
    - 画像生成を頼まれた際は、/ generateコマンドを使用するようユーザーに促してください。
    - 同時に、ユーザーが求める画像に合わせて「flux 1 schnell」向けの英語プロンプトを考案し、以下のフォーマットで出力してください。`
                        + "```/generate prompt:[考案したプロンプト]```"
                        + `3. 自然な会話：画像生成の話が出ていないときは、画像生成に関する注記やヒントは一切出力せず、通常の会話に集中してください。`
                },
                contents: contents,
            });
        } catch (error) {
            lastError = error;
            if (error.status === 404 || error.status === 503 || error.status === 429 || (error.message && (error.message.includes('503') || error.message.includes('not found') || error.message.includes('overloaded')))) {
                console.warn(`[chat] モデル ${modelName} が利用できないか混雑中のため、次のモデルにフォールバックします...`);
                try {
                    await interaction.editReply(`<a:load:1559811422261747783> モデル ${modelName} がレート制限か混雑中のため、次のモデルに切り替えています...`);
                } catch (e) { }
                continue;
            }
            throw error;
        }
    }
    throw lastError;
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
        .addStringOption(option =>
            option.setName("model")
                .setDescription("使用するGeminiモデルを選択してください（省略時はデフォルト）")
                .setRequired(false)
                .addChoices(
                    { name: 'Gemini 3.8 Flash', value: 'gemini-3.8-flash' },
                    { name: 'Gemini 3.7 Flash', value: 'gemini-3.7-flash' },
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
        const selectedModel = interaction.options.getString("model") || 'gemini-3.5-flash-lite';
        const attachment = interaction.options.getAttachment("attachment");

        await interaction.deferReply();

        let isCompleted = false;
        const slowTimer = setTimeout(async () => {
            if (!isCompleted) {
                try {
                    await interaction.editReply("<a:load:1559811422261747783> AIが考え込んでいます…（少々お時間がかかります）");
                } catch (e) { }
            }
        }, 5000);

        try {
            let contents = userPrompt;

            if (attachment) {
                const mimeType = attachment.contentType || "application/octet-stream";
                const filePart = await urlToGenerativePart(attachment.url, mimeType);
                contents = [userPrompt, filePart];
            }

            const response = await generateWithFallback(selectedModel, contents, interaction);

            isCompleted = true;
            clearTimeout(slowTimer);

            const replyText = response.text || "応答を取得できませんでした。";

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
                    await interaction.editReply(options);
                } else {
                    await interaction.followUp(options);
                }
            }

        } catch (error) {
            isCompleted = true;
            clearTimeout(slowTimer);
            console.error("Gemini API Call Error:", error);
            await interaction.editReply("現在、すべてのGeminiモデルがAPI/レート制限のため一時的に利用できません。少し時間をおいてから再度お試しください。");
        }
    }
};