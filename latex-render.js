const { AttachmentBuilder } = require("discord.js");
const { createCanvas, loadImage, GlobalFonts } = require("@napi-rs/canvas");
const fs = require("fs");
const path = require("path");

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
const MAX_IMAGES = Infinity;       // 1回の応答で画像化する数式（まとめ後）の上限
const BG_COLOR = "#000000";
const FG_COLOR = "#ffffff";

// ---------- 日本語フォント ----------
const JP_FONT_FAMILY = "LatexJP";
/** 日本語フォントの候補。環境変数 LATEX_JP_FONT で直接指定もできる */
const JP_FONT_CANDIDATES = [
    process.env.LATEX_JP_FONT,
    // このファイルの隣の fonts/ フォルダに置いた場合
    path.join(__dirname, "fonts", "NotoSansJP-Regular.ttf"),
    path.join(__dirname, "fonts", "NotoSansJP-Regular.otf"),
    path.join(__dirname, "fonts", "NotoSansJP[wght].ttf"),
    path.join(__dirname, "fonts", "NotoSansCJK-Regular.ttc"),
    path.join(__dirname, "fonts", "NotoSerifJP-Regular.otf"),
    // Linux
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf",
    "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
    "/usr/share/fonts/truetype/takao-gothic/TakaoGothic.ttf",
    // Windows
    "C:\\Windows\\Fonts\\YuGothR.ttc",
    "C:\\Windows\\Fonts\\meiryo.ttc",
    "C:\\Windows\\Fonts\\msgothic.ttc",
    // macOS
    "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/Library/Fonts/Arial Unicode.ttf"
];

let jpFontReady = false;
(function setupJapaneseFont() {
    for (const file of JP_FONT_CANDIDATES) {
        if (!file || !fs.existsSync(file)) continue;
        try {
            if (GlobalFonts.registerFromPath(file, JP_FONT_FAMILY)) {
                jpFontReady = true;
                console.log(`[latex-render] 日本語フォントを登録しました: ${file}`);
                return;
            }
        } catch (e) { /* 次の候補へ */ }
    }
    console.warn(
        "[latex-render] 日本語フォントが見つかりません。数式内の日本語が□になります。" +
        "fonts/ フォルダに NotoSansJP-Regular.ttf を置くか、環境変数 LATEX_JP_FONT でパスを指定してください。"
    );
})();

// ---------- 数式内の日本語を \text{} で包む ----------
const JP_CHAR = /[\u3000-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;
const TEXT_CMD = /^\\(?:text|textrm|textbf|textit|textsf|texttt|mbox|hbox)\s*\{/;

/** \text{} などの外にある日本語の連続を \text{...} で包む（斜体・字間の崩れを防ぐ） */
function wrapJapanese(tex) {
    if (!JP_CHAR.test(tex)) return tex;

    let out = "";
    let i = 0;
    let depth = 0;
    const textDepths = [];   // テキストモードに入ったときの波括弧の深さ

    while (i < tex.length) {
        const c = tex[i];

        if (c === "\\") {
            const rest = tex.slice(i);
            const t = rest.match(TEXT_CMD);
            if (t) {
                depth++;
                textDepths.push(depth);
                out += t[0];
                i += t[0].length;
                continue;
            }
            const m = rest.match(/^\\(?:[a-zA-Z]+|.)/s);
            out += m[0];
            i += m[0].length;
            continue;
        }
        if (c === "{") { depth++; out += c; i++; continue; }
        if (c === "}") {
            if (textDepths.length && textDepths[textDepths.length - 1] === depth) textDepths.pop();
            depth--;
            out += c;
            i++;
            continue;
        }
        if (!textDepths.length && JP_CHAR.test(c)) {
            let j = i;
            while (j < tex.length && JP_CHAR.test(tex[j])) j++;
            out += `\\text{${tex.slice(i, j)}}`;
            i = j;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

// ---------- LaTeX -> 画像 ----------
async function renderLine(tex) {
    const node = mjDocument.convert(wrapJapanese(tex), { display: true });
    let svg = adaptor.innerHTML(node);

    // 日本語などフォント描画になる文字は、登録した日本語フォントで描く
    if (jpFontReady) {
        svg = svg
            .replace(/font-family="[^"]*"/g, `font-family="${JP_FONT_FAMILY}"`)
            .replace(/font-family:\s*[^;"]+/g, `font-family: ${JP_FONT_FAMILY}`);
    }

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

/** 改行区切りで複数行を縦に並べる。/latex コマンドとチャット応答の両方で使う */
/** 最初の「波括弧・\left\right の外にある =」の位置を返す（なければ -1） */
function findAlignPos(line) {
    let depth = 0;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === "\\") {
            const m = line.slice(i).match(/^\\([a-zA-Z]+|.)/s);
            if (m[1] === "left") depth++;
            else if (m[1] === "right") depth--;
            i += m[0].length - 1;
        } else if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === "=" && depth === 0) return i;
    }
    return -1;
}

/** 連続する行を = で揃えた aligned 環境にする。揃えられないときは null */
function buildAligned(lines) {
    if (lines.length < 2) return null;
    // すでに & や \\ や環境を使っている場合は触らない
    if (lines.some(l => /&|\\\\|\\begin|\\end/.test(l))) return null;

    const positions = lines.map(findAlignPos);
    if (positions.filter(p => p >= 0).length < 2) return null;

    const body = lines.map((l, i) => {
        const p = positions[i];
        return p >= 0 ? `${l.slice(0, p)}&${l.slice(p)}` : l;
    }).join(" \\\\ ");
    return `\\begin{aligned}${body}\\end{aligned}`;
}

/** 改行区切りで複数行を縦に並べる。複数行は = の位置を自動で揃える */
async function generateLatexImage(formulaText, { paddingX = 40, paddingY = 30 } = {}) {
    const lineGap = 16;
    const lines = formulaText.split("\n");

    // 括弧や \begin...\end が閉じていない行は、次の行と結合してから扱う
    const depthDelta = (line) => {
        const s = line.replace(/\\[{}]/g, "");   // \{ \} は数えない
        const count = (re) => (s.match(re) || []).length;
        return count(/\\begin\{/g) - count(/\\end\{/g)
            + count(/\{/g) - count(/\}/g)
            + count(/\\left(?![a-zA-Z])/g) - count(/\\right(?![a-zA-Z])/g);
    };

    // 空行で区切って、連続する行ごとにグループ化
    const groups = [];
    let cur = [];
    let buf = "";
    let depth = 0;
    for (const line of lines) {
        const t = line.trim();
        if (depth === 0 && t === "") {
            if (cur.length) { groups.push({ lines: cur }); cur = []; }
            groups.push({ blank: true });
            continue;
        }
        if (t === "") continue;   // 環境の途中の空行は無視
        buf = buf ? `${buf} ${t}` : t;
        depth += depthDelta(t);
        if (depth <= 0) {
            cur.push(buf);
            buf = "";
            depth = 0;
        }
    }
    if (buf) cur.push(buf);
    if (cur.length) groups.push({ lines: cur });
    const rendered = [];
    for (const g of groups) {
        if (g.blank) {
            rendered.push({ img: null, width: 0, height: 24 });
            continue;
        }
        const aligned = buildAligned(g.lines);
        if (aligned) {
            try {
                rendered.push(await renderLine(aligned));
                continue;
            } catch (e) {
                // 揃えられなかったら、行ごとの描画にフォールバック
            }
        }
        for (const line of g.lines) rendered.push(await renderLine(line));
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

    // \text{速度} のような単純なテキストは中身だけにする
    s = s.replace(/\\(?:text|textrm|mbox|mathrm)\s*\{([^{}\\]*)\}/g, "$1");

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
    String.raw`\\begin\{(?<envname>align\*?|aligned|alignat\*?|equation\*?|gather\*?|gathered|multline\*?|eqnarray\*?|split|cases|[pbvBV]?matrix|array)\}[\s\S]+?\\end\{\k<envname>\}`,
    String.raw`\\begin\{(?<envname>align\*?|equation\*?|gather\*?|multline\*?)\}[\s\S]+?\\end\{\k<envname>\}`,
    String.raw`\\\((?<par>[\s\S]+?)\\\)`,
    String.raw`(?<![\\$])\$(?!\s)(?<inl>[^$\n]+?)(?<!\s)\$(?!\d)`
].join("|"), "g");

const CODE_RE = /```[\s\S]*?```|`[^`\n]+`/g;

// 数式内の改行は空白に変える（複数式の区切りに使う "\n" と区別するため）
const oneLine = s => s.replace(/\s*\n\s*/g, " ").trim();

/** 隣り合う数式（間が空白だけの場合を含む）を、改行でつないで1つにする */
function mergeAdjacentMath(segments) {
    const out = [];
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const prev = out[out.length - 1];

        // 数式と数式の間にある空白だけの文章は捨てる
        if (seg.type === "text" && !seg.value.trim()
            && prev?.type === "math" && segments[i + 1]?.type === "math") {
            continue;
        }
        if (seg.type === "math" && prev?.type === "math") {
            prev.value += "\n" + seg.value;
            continue;
        }
        out.push({ ...seg });
    }
    return out;
}

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
                segments.push({ type: "math", value: oneLine(g.dd ?? g.br) });
            } else if (g.envname !== undefined) {
                flush();
                segments.push({ type: "math", value: oneLine(m[0]) });
            } else {
                const tex = oneLine(g.par ?? g.inl);
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
    return mergeAdjacentMath(segments);
}

// ---------- 応答テキスト -> 送信用メッセージ配列 ----------
/**
 * @returns {Promise<Array<{content: string, files: any[]}> & {hasLatexImage: boolean}>}
 * 数式画像は直前のメッセージに添付され、変換前のコードは次の文章の先頭に付く。
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

            // 画像は直前のメッセージに添付
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