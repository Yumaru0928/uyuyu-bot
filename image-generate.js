// image-generate.js
const { GoogleGenAI } = require("@google/genai");
const fs = require("node:fs");
const path = require("node:path");

const configPath = path.join(__dirname, "config.json");
let apiKey = process.env.GEMINI_API_KEY;

if (fs.existsSync(configPath)) {
    try {
        const config = require(configPath);
        apiKey = config.GEMINI_API_KEY || config.apiKey || apiKey;
    } catch (e) {
        console.error("[image-generate] config.json の読み込みに失敗しました:", e);
    }
}

// APIキーが設定されていない場合でも読み込み時点でクラッシュしないよう遅延初期化
function getGenAIClient() {
    if (!apiKey) {
        throw new Error("GEMINI_API_KEY が設定されていません。環境変数または config.json を確認してください。");
    }
    return new GoogleGenAI({ apiKey });
}

const MODELS = [
    { label: "Nano Banana Pro", id: "gemini-3-pro-image" },
    { label: "Nano Banana 2", id: "gemini-3.1-flash-image" },
    { label: "Nano Banana 2 Lite", id: "gemini-3.1-flash-lite-image" },
    { label: "Nano Banana 2.1", id: "gemini-nano-banana-2.1" }
];

const GENERATED_FILE_PREFIX = "uyuyu-generate-";

function isNotFound(error) {
    return error.status === 404 || (error.message && /not found|404/i.test(error.message));
}

function isRateLimitedOrBusy(error) {
    return (
        error.status === 429 ||
        error.status === 503 ||
        (error.message && /429|503|overloaded|quota|rate/i.test(error.message))
    );
}

class NoImageError extends Error {
    constructor(text) {
        super("画像が生成されませんでした");
        this.name = "NoImageError";
        this.modelText = text || "";
    }
}

async function urlToGenerativePart(url, mimeType) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`ファイルの取得に失敗しました: ${response.statusText}`);
    const buffer = await response.arrayBuffer();
    return {
        inlineData: {
            data: Buffer.from(buffer).toString("base64"),
            mimeType
        }
    };
}

function extractResult(response) {
    const parts = response?.candidates?.[0]?.content?.parts || [];
    let image = null;
    let text = "";

    for (const part of parts) {
        if (part.inlineData?.data && !image) {
            image = {
                buffer: Buffer.from(part.inlineData.data, "base64"),
                mimeType: part.inlineData.mimeType || "image/png"
            };
        } else if (part.text) {
            text += part.text;
        }
    }

    return { image, text };
}

function mimeToExtension(mimeType) {
    if (mimeType === "image/jpeg" || mimeType === "image/jpg") return "jpg";
    if (mimeType === "image/webp") return "webp";
    if (mimeType === "image/gif") return "gif";
    return "png";
}

async function generateImageWithFallback(contents, onFallback) {
    const ai = getGenAIClient();
    let lastError = null;

    for (const model of MODELS) {
        try {
            const response = await ai.models.generateContent({
                model: model.id,
                contents,
                config: {
                    responseModalities: ["TEXT", "IMAGE"]
                }
            });

            const { image, text } = extractResult(response);
            if (!image) throw new NoImageError(text);

            return { image, text, modelLabel: model.label, modelId: model.id };
        } catch (error) {
            if (error instanceof NoImageError) throw error;

            lastError = error;

            if (isNotFound(error)) {
                console.warn(`[generate] モデル ${model.id} が見つかりません。次のモデルを試します...`);
                continue;
            }

            if (isRateLimitedOrBusy(error)) {
                console.warn(`[generate] モデル ${model.id} がレート制限か混雑中のため、次のモデルにフォールバックします...`);
                if (onFallback) {
                    try {
                        await onFallback(model.label);
                    } catch (e) { }
                }
                continue;
            }

            throw error;
        }
    }

    throw lastError;
}

module.exports = {
    MODELS,
    GENERATED_FILE_PREFIX,
    NoImageError,
    urlToGenerativePart,
    mimeToExtension,
    generateImageWithFallback
};