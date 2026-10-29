const { AttachmentBuilder } = require("discord.js");
const { createCanvas, loadImage } = require("@napi-rs/canvas");

const { mathjax } = require("mathjax-full/js/mathjax.js");
const { TeX } = require("mathjax-full/js/input/tex.js");
const { SVG } = require("mathjax-full/js/output/svg.js");
const { liteAdaptor } = require("mathjax-full/js/adaptors/liteAdaptor.js");
const { RegisterHTMLHandler } = require("mathjax-full/js/handlers/html.js");
const { AllPackages } = require("mathjax-full/js/input/tex/AllPackages.js");

const { splitMessage, processLongCodeBlocks } = require("./gemini.js");

// ---------- MathJax 初期化（1回だけ） ----------
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const texInput = new TeX({
    packages: AllPackages,
    formatError: (jax, err) => { throw err; }
});
const svgOutput = new SVG({ fontCache: "none" });
const mjDocument = mathjax.document("", { InputJax: texInput, OutputJax: svgOutput });

const SCALE = 2.5;
const EX_TO_PX = 8 * SCALE;
const MAX_IMAGES = Infinity;       // 1回の応答で画像化する数式の上限
const BG_COLOR = "#000000";
const FG_COLOR = "#ffffff";

// ---------- LaTeX -> 画像 ----------
async function renderLine(tex) {
    const node = mjDocument.convert(tex, { display: true });
    let svg = adaptor.innerHTML(node);

    const w = parseFloat(svg.match(/width="([\d.]+)ex"/)?.[1] ?? 0) * EX_TO_PX;
    const h = parseFloat(svg.match(/height="([\d.]+)ex"/)?.[1] ?? 0) * EX_TO_PX;
    if (!w || !h) throw new Error("数式のサイズを取得できませんでした");

    svg = svg
        .replace(/width="[\d.]+ex"/, `width="${w}px"`)
        .replace(/height="[\d.]+ex"/, `height="${h}px"`)
        .replace(/currentColor/g, FG_COLOR);

    const img = await loadImage(Buffer.from(svg));
    return { img, width: w, height: h };
}

/** 複数行対応。/latex コマンドとチャット応答の両方で使う */
async function generateLatexImage(formulaText, { paddingX = 40, paddingY = 30 } = {}) {
    const lineGap = 16;
    const lines = formulaText.split("\n");
    const rendered = [];
    for (const line of lines) {
        rendered.push(line.trim() === ""
            ? { img: null, width: 0, height: 24 }
            : await renderLine(line));
    }

    const maxWidth = Math.max(...rendered.map(r => r.width));
    const totalHeight = rendered.reduce((s, r) => s + r.height, 0) + lineGap * (rendered.length - 1);
    const width = Math.ceil(maxWidth + paddingX * 2);
    const height = Math.ceil(totalHeight + paddingY * 2);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, width, height);

    let y = paddingY;
    for (const r of rendered) {
        if (r.img) ctx.drawImage(r.img, (width - r.width) / 2, y, r.width, r.height);
        y += r.height + lineGap;
    }
    return await canvas.encode("png");
}

// ---------- インライン数式の Unicode 化 ----------
const SYMBOLS = {
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
    zeta: "ζ", eta: "η", theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ",
    nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "φ", varphi: "φ",
    chi: "χ", psi: "ψ", omega: "ω",
    Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
    Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
    times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓",
    leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈",
    equiv: "≡", sim: "∼", propto: "∝", infty: "∞", partial: "∂", nabla: "∇",
    to: "→", rightarrow: "→", leftarrow: "←", Rightarrow: "⇒", Leftarrow: "⇐",
    leftrightarrow: "↔", Leftrightarrow: "⇔", mapsto: "↦",
    in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", cup: "∪", cap: "∩",
    forall: "∀", exists: "∃", emptyset: "∅", ldots: "…", cdots: "⋯", degree: "°",
    angle: "∠", perp: "⊥", circ: "∘"
};
const SUP = {
    0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹",
    "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ"
};
const SUB = {
    0: "₀", 1: "₁", 2: "₂", 3: "₃", 4: "₄", 5: "₅", 6: "₆", 7: "₇", 8: "₈", 9: "₉",
    "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
    a: "ₐ", e: "ₑ", i: "ᵢ", j: "ⱼ", n: "ₙ", o: "ₒ", x: "ₓ"
};

/** 単純なら Unicode 文字列を、複雑なら null を返す */
function simplifyInline(tex) {
    let s = tex.trim();
    let ok = true;

    s = s.replace(/\\([a-zA-Z]+)/g, (m, name) => {
        if (SYMBOLS[name]) return SYMBOLS[name];
        ok = false;
        return m;
    });
    if (!ok) return null;

    s = s.replace(/\\[,;: !]/g, " ");
    s = s.replace(/([\^_])(?:\{([^{}]*)\}|(.))/g, (m, op, grp, ch) => {
        const map = op === "^" ? SUP : SUB;
        const converted = [...(grp ?? ch)].map(c => map[c]);
        if (converted.includes(undefined)) { ok = false; return m; }
        return converted.join("");
    });
    if (!ok) return null;

    s = s.replace(/[{}]/g, "");
    if (/[\\^_]/.test(s)) return null;
    return s;
}

// ---------- テキストから数式を抽出 ----------
const MATH_RE = new RegExp([
    String.raw`\$\$(?<dd>[\s\S]+?)\$\$`,
    String.raw`\\\[(?<br>[\s\S]+?)\\\]`,
    String.raw`\\begin\{(?<envname>align\*?|equation\*?|gather\*?|multline\*?)\}[\s\S]+?\\end\{\k<envname>\}`,
    String.raw`\\\((?<par>[\s\S]+?)\\\)`,
    String.raw`(?<![\\$])\$(?!\s)(?<inl>[^$\n]+?)(?<!\s)\$(?!\d)`
].join("|"), "g");

const CODE_RE = /```[\s\S]*?```|`[^`\n]+`/g;

/** -> [{ type: 'text', value } | { type: 'math', value }] */
function splitByLatex(text) {
    const segments = [];
    let buf = "";
    const flush = () => { if (buf) { segments.push({ type: "text", value: buf }); buf = ""; } };

    const processPlain = (plain) => {
        let last = 0;
        for (const m of plain.matchAll(MATH_RE)) {
            buf += plain.slice(last, m.index);
            last = m.index + m[0].length;
            const g = m.groups;

            if (g.dd !== undefined || g.br !== undefined) {
                flush();
                segments.push({ type: "math", value: (g.dd ?? g.br).trim() });
            } else if (g.envname !== undefined) {
                flush();
                segments.push({ type: "math", value: m[0] });
            } else {
                const tex = (g.par ?? g.inl).trim();
                const simple = simplifyInline(tex);
                if (simple !== null) {
                    buf += simple;
                } else {
                    flush();
                    segments.push({ type: "math", value: tex });
                }
            }
        }
        buf += plain.slice(last);
    };

    // コードブロック／インラインコードの中は触らない
    let last = 0;
    for (const m of text.matchAll(CODE_RE)) {
        processPlain(text.slice(last, m.index));
        buf += m[0];
        last = m.index + m[0].length;
    }
    processPlain(text.slice(last));
    flush();
    return segments;
}

// ---------- 応答テキスト -> 送信用メッセージ配列 ----------
/**
 * @returns {Promise<Array<{content: string, files: any[]}>>}
 * 数式画像は、直前の文章メッセージの下に添付される。
 */
async function buildReplyMessages(replyText) {
    const { processedText, attachments } = processLongCodeBlocks(replyText);
    const segments = splitByLatex(processedText);

    const messages = [];
    let imageCount = 0;
    let pendingCodes = [];   // 次の文章の先頭に出す、変換前のコード

    // 溜まっているコードを単独のメッセージとして出す
    const flushPending = () => {
        if (pendingCodes.length) {
            messages.push({ content: pendingCodes.join("\n"), files: [] });
            pendingCodes = [];
        }
    };

    for (const seg of segments) {
        if (seg.type === "text") {
            const trimmed = seg.value.trim();
            if (!trimmed) continue;

            const chunks = splitMessage(trimmed);
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];

                // 続きの先頭にコードを付ける（2000文字に収まるときだけ）
                if (i === 0 && pendingCodes.length) {
                    const prefix = pendingCodes.join("\n") + "\n";
                    if (prefix.length + chunk.length <= 2000) {
                        messages.push({ content: prefix + chunk, files: [] });
                        pendingCodes = [];
                        continue;
                    }
                    flushPending(); // 入りきらないときはコードだけ先に別メッセージにする
                }
                messages.push({ content: chunk, files: [] });
            }
            continue;
        }

        // math
        const source = seg.value.replace(/```/g, "'''");
        const codeBlock = `\`\`\`latex\n${source.slice(0, 1500)}${source.length > 1500 ? "\n…" : ""}\n\`\`\``;

        // コードが溜まりすぎて2000文字を超えそうなら先に出す
        const pendingLength = pendingCodes.join("\n").length;
        if (pendingLength + codeBlock.length > 1900) flushPending();

        try {
            if (imageCount >= MAX_IMAGES) throw new Error("too many formulas");
            const buffer = await generateLatexImage(seg.value, { paddingX: 24, paddingY: 16 });
            const file = new AttachmentBuilder(buffer, { name: `latex_${Date.now()}_${imageCount}.png` });
            imageCount++;

            // 画像は直前のメッセージに添付（以前と同じ）
            const last = messages[messages.length - 1];
            if (last && last.files.length < 9) last.files.push(file);
            else messages.push({ content: "", files: [file] });
        } catch (e) {
            // 失敗したときも、元のコードは残す
        }

        // コードは次の文章の先頭へ
        pendingCodes.push(codeBlock);
    }

    // 数式で終わった場合は、残ったコードを最後に出す
    flushPending();

    if (messages.length === 0) messages.push({ content: "応答を取得できませんでした。", files: [] });
    messages[0].files.unshift(...attachments); // 長いコードのファイルは先頭メッセージへ
    messages.hasLatexImage = imageCount > 0;
    return messages;
}

module.exports = { generateLatexImage, buildReplyMessages };