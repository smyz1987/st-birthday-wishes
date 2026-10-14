// st-birthday-wishes: 生日祝福
// 设定生日日期；聊过 ≥N 条消息的角色在生日当天进入酒馆时，以各自口吻送上祝福卡片（可保存图片/复制文字）
import { getContext } from '../../../extensions.js';
import { getRequestHeaders, generateQuietPrompt } from '../../../../script.js';

const LS_SETTINGS = 'st-bw-settings';
const LS_WISHES = 'st-bw-wishes';       // { '月-日|avatar': '祝福文本' }
const LS_STATS = 'st-bw-stats';         // { date: 'M-D', list: [{avatar,name,count}] }
const OVERLAY_ID = 'st-bw-overlay';
const WAND_ID = 'st-bw-wand';

let settings = { enabled: true, useMain: false, birthday: '', baseUrl: '', apiKey: '', model: '', threshold: 10 };

function loadSettings() {
    try { settings = Object.assign(settings, JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}')); } catch { /* ignore */ }
}
function saveSettings() { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); }
loadSettings();

// ---------- 工具 ----------
function todayMD() {
    const d = new Date();
    return (d.getMonth() + 1) + '-' + d.getDate();
}
function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

// ---------- 统计聊天轮数（≥阈值才算聊过） ----------
async function fetchJson(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body || {}),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
}

async function computeStats(force) {
    const today = todayMD();
    const cached = (() => { try { return JSON.parse(localStorage.getItem(LS_STATS) || 'null'); } catch { return null; } })();
    if (!force && cached && cached.date === today && Array.isArray(cached.list)) return cached.list;
    // 一次请求拿全部聊天文件元数据（含 chat_items 消息数 / avatar / last_mes）
    const recent = await fetchJson('/api/chats/recent', { metadata: true });
    const perChar = {};
    if (Array.isArray(recent)) {
        for (const item of recent) {
            const av = String(item.avatar || '');
            if (!av) continue;
            const cnt = Number(item.chat_items) || 0;
            perChar[av] = (perChar[av] || 0) + cnt;
        }
    }
    const ctx = getContext();
    const chars = (ctx && Array.isArray(ctx.characters)) ? ctx.characters : [];
    const threshold = Number(settings.threshold) > 0 ? Number(settings.threshold) : 10;
    const out = [];
    for (const [av, count] of Object.entries(perChar)) {
        if (count >= threshold) {
            const c = chars.find(x => String(x.avatar || (x.data && x.data.avatar)) === av);
            const name = String((c && (c.name || (c.data && c.data.name))) || av.replace(/\.png$/i, ''));
            out.push({ avatar: av, name, count });
        }
    }
    out.sort((a, b) => b.count - a.count);
    localStorage.setItem(LS_STATS, JSON.stringify({ date: today, list: out }));
    return out;
}

// ---------- LLM 生成祝福 ----------
// 主 API：直接调用酒馆官方静默生成接口，真正跟随当前主连接（支持任意主源类型）
async function mainQuiet(promptText) {
    if (typeof generateQuietPrompt !== 'function') {
        throw new Error('跟随主 API 需要酒馆的静默生成接口，当前版本不可用，请改用副 API');
    }
    try {
        // 主 API 无响应时不能无限等待——90 秒超时并给出明确提示
        const out = await Promise.race([
            generateQuietPrompt(promptText, { quietToLoud: true }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('主 API 响应超时（90秒）——请检查酒馆主 API 是否已连接（发送框不应显示"未连接到 API"），或改用副 API')), 90000)),
        ]);
        if (!out) throw new Error('主 API 返回为空');
        return String(out);
    } catch (e) {
        throw new Error('跟随主 API 生成失败：' + (e && e.message ? e.message : e));
    }
}

// 拉取模型列表（OpenAI 兼容 /models 接口）
async function fetchModels(baseUrl, apiKey) {
    let url = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!url) return [];
    const tryUrls = /\/v\d+$/i.test(url) ? [url + '/models'] : [url + '/models', url + '/v1/models'];
    for (const u of tryUrls) {
        try {
            const res = await fetch(u, { headers: { 'Authorization': 'Bearer ' + apiKey } });
            if (!res.ok) continue;
            const j = await res.json();
            const models = (j && Array.isArray(j.data)) ? j.data.map(m => m && m.id).filter(Boolean) : [];
            if (models.length) return models;
        } catch { /* try next */ }
    }
    return [];
}

async function genWish(char, force) {
    const key = todayMD() + '|' + char.avatar;
    const cache = (() => { try { return JSON.parse(localStorage.getItem(LS_WISHES) || '{}'); } catch { return {}; } })();
    const prev = cache[key];
    // 旧版本缓存是纯字符串（无完整设计），视为无效，重新生成
    if (!force && prev && typeof prev === 'object' && prev.wish && prev.bg1) return prev;
    const c = getContext().characters.find(x => String(x.avatar || (x.data && x.data.avatar)) === char.avatar);
    const desc = truncate(String((c && (c.description || (c.data && c.data.description))) || ''), 500);
    const first = truncate(String((c && (c.first_mes || (c.data && c.data.first_mes))) || ''), 300);
    const sys = '为角色「' + char.name + '」设计一张生日卡片（今天是我的生日）。角色资料：' + (desc ? '人设：' + desc : '') + (first ? '开场白：' + first : '') + '。\n请以角色本人视角完成以下全部内容，每一部分都必须贴合这个角色的性格、身份、世界观，绝对禁止模板化、套话：\n1) wish：60-140字的生日祝福，人设专属，绝对禁止只写"生日快乐"四个字；\n2) motto：一句只有TA会说的生日句子（口头禅/人生信条/最想对我说的话，10-20字）；\n3) title：卡片标题短语（4-10字，人设专属，如「深渊的贺礼」「来自星海的信号」）；\n4) bg1、bg2：两个十六进制颜色，组成卡片渐变背景，要贴合角色世界观色调；\n5) accent：一个十六进制强调色（装饰与署名用，要比背景亮）；\n6) deco：3-5个贴合角色气质的装饰emoji；\n7) style：卡片设计风格的一句话描述（如「哥特暗黑」「赛博霓虹」「手账贴纸」「水墨留白」「欧式信笺」……会决定排版与装饰气质）；\n8) pattern：背景纹样关键词，从下面选一个最贴合角色的：thorn(荆棘)/gear(齿轮)/star(星光)/sakura(花瓣)/leaf(藤蔓)/hex(蜂巢)/grid(网格)/wave(波纹)/crack(裂纹)/dot(点阵)。\n不要任何解释，只输出一个 JSON 对象，严格如下格式：\n{"wish":"...","motto":"...","title":"...","bg1":"#xxxxxx","bg2":"#xxxxxx","accent":"#xxxxxx","deco":["...","..."],"style":"...","pattern":"..."}';
    const usr = '今天是我生日。';
    let raw;
    if (settings.useMain) {
        raw = await mainQuiet(sys + '\n\n' + usr);
    } else {
        const api = { baseUrl: String(settings.baseUrl || ''), apiKey: String(settings.apiKey || ''), model: String(settings.model || '') };
        if (!api.baseUrl || !api.apiKey || !api.model) {
            // 未配置：返回完整兜底设计，避免卡片渲染缺字段
            const fb = fallbackDesign(char);
            return Object.assign({}, fb, {
                wish: '（请在设置里配置副 API 的 Base URL / Key / 模型，或勾选「使用酒馆主 API」后重新生成）',
                motto: '',
            });
        }
        let url = String(api.baseUrl).trim().replace(/\/+$/, '');
        if (!/\/v\d+$/.test(url)) url += '/v1';
        url += '/chat/completions';
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + api.apiKey },
            body: JSON.stringify({
                model: api.model,
                messages: [
                    { role: 'system', content: sys },
                    { role: 'user', content: usr },
                ],
                temperature: 0.95,
                max_tokens: 600,
            }),
        });
        if (!res.ok) {
            let msg = 'HTTP ' + res.status;
            try { const j = await res.json(); msg += ': ' + (j.error && (j.error.message || j.error)) || ''; } catch { /* ignore */ }
            throw new Error(msg);
        }
        const j = await res.json();
        const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        if (!text) throw new Error('API 返回为空');
        raw = String(text).trim();
    }
    // 解析 AI 输出的卡片设计 JSON
    const d = parseCardJSON(raw);
    const fb = fallbackDesign(char);
    const isHex = v => /^#[0-9a-fA-F]{6}$/.test(String(v || '').trim());
    const out = {
        wish: d && d.wish ? String(d.wish).trim() : (raw || '……'),
        motto: d && d.motto ? String(d.motto).trim() : fb.motto,
        title: d && d.title ? String(d.title).trim() : fb.title,
        bg1: d && isHex(d.bg1) ? String(d.bg1) : fb.bg1,
        bg2: d && isHex(d.bg2) ? String(d.bg2) : fb.bg2,
        accent: d && isHex(d.accent) ? String(d.accent) : fb.accent,
        deco: d && Array.isArray(d.deco) && d.deco.length ? d.deco.slice(0, 5).map(String) : fb.deco,
        style: d && d.style ? String(d.style).trim() : fb.style,
        pattern: d && d.pattern ? String(d.pattern).trim() : fb.pattern,
    };
    cache[key] = out;
    localStorage.setItem(LS_WISHES, JSON.stringify(cache));
    return out;
}

// 从 AI 输出中容错提取 JSON 对象
function parseCardJSON(raw) {
    const s = String(raw || '').trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

// 解析失败时的兜底设计：按角色名哈希生成稳定配色，保证每个角色仍各不相同
function fallbackDesign(char) {
    let h = 0;
    for (let i = 0; i < char.name.length; i++) h = (h * 31 + char.name.charCodeAt(i)) >>> 0;
    const base = [0, 350, 210, 270, 330, 190, 90, 30];
    const hue = base[h % base.length];
    return {
        motto: '……',
        title: char.name + ' 的赠礼',
        bg1: hslToHex(hue, 55, 17),
        bg2: hslToHex((hue + 30) % 360, 45, 28),
        accent: hslToHex((hue + 200) % 360, 65, 62),
        deco: ['🎁', '🕯️', '🌹'],
        style: '经典信笺',
        pattern: 'dot',
    };
}

function hslToHex(h, s, l) {
    s = s / 100; l = l / 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => {
        const c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
        return Math.round(c * 255).toString(16).padStart(2, '0');
    };
    return '#' + f(0) + f(8) + f(4);
}

// 按背景亮度决定正文用深色还是浅色字
function isLight(hex) {
    const s = String(hex || '').replace('#', '');
    if (s.length !== 6) return false;
    const r = parseInt(s.slice(0, 2), 16), g = parseInt(s.slice(2, 4), 16), b = parseInt(s.slice(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150;
}

// 纹样关键词 → 标准图案 id
function detectPattern(p) {
    const s = String(p || '').toLowerCase();
    const map = [['thorn', ['thorn', '荆棘', '荆', '刺']], ['gear', ['gear', '齿轮', '机械']], ['star', ['star', '星']], ['sakura', ['sakura', '樱花', '花瓣', '花']], ['leaf', ['leaf', '藤蔓', '叶']], ['hex', ['hex', '蜂巢']], ['grid', ['grid', '网格']], ['wave', ['wave', '波纹', '水']], ['crack', ['crack', '裂纹', '裂']], ['dot', ['dot', '点阵', '点']]];
    for (const m of map) for (const k of m[1]) if (s.includes(k)) return m[0];
    return 'dot';
}

// 生成纹样 SVG data URI（HTML 卡片背景图层）
function patternSVG(kind, color) {
    const c = color || '#ffffff';
    const svgs = {
        dot: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="1.5" fill="' + c + '" fill-opacity=".4"/></svg>',
        grid: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><path d="M40 0H0V40" fill="none" stroke="' + c + '" stroke-opacity=".25"/></svg>',
        wave: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="24"><path d="M0 12 Q10 2 20 12 T40 12 T60 12 T80 12" fill="none" stroke="' + c + '" stroke-opacity=".35" stroke-width="1.5"/></svg>',
        hex: '<svg xmlns="http://www.w3.org/2000/svg" width="56" height="50"><path d="M28 0l12 7v14l-12 7-12-7V7z" fill="none" stroke="' + c + '" stroke-opacity=".3"/></svg>',
        star: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><path d="M20 4l4 12h12l-10 8 4 12-10-7-10 7 4-12-10-8h12z" fill="' + c + '" fill-opacity=".32"/></svg>',
        sakura: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><ellipse cx="20" cy="10" rx="4" ry="9" fill="' + c + '" fill-opacity=".32" transform="rotate(35 20 20)"/><ellipse cx="28" cy="26" rx="4" ry="9" fill="' + c + '" fill-opacity=".32" transform="rotate(-35 28 26)"/></svg>',
        leaf: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><path d="M4 44 C4 20 20 4 44 4 C44 28 28 44 4 44Z" fill="none" stroke="' + c + '" stroke-opacity=".32"/><path d="M4 44 C16 32 28 24 44 8" stroke="' + c + '" stroke-opacity=".32" fill="none"/></svg>',
        thorn: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><path d="M0 32 C10 26 18 18 24 8" stroke="' + c + '" stroke-opacity=".45" fill="none"/><path d="M22 12 l6 -4 l-1 7" stroke="' + c + '" stroke-opacity=".45" fill="none"/><path d="M8 30 l4 -6" stroke="' + c + '" stroke-opacity=".45"/></svg>',
        crack: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><path d="M0 20 L14 14 L22 22 L34 10 L48 18" stroke="' + c + '" stroke-opacity=".32" fill="none"/><path d="M14 14 L10 30" stroke="' + c + '" stroke-opacity=".32" fill="none"/><path d="M34 10 L30 26 L38 38" stroke="' + c + '" stroke-opacity=".32" fill="none"/></svg>',
        gear: '<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56"><g fill="none" stroke="' + c + '" stroke-opacity=".32"><circle cx="28" cy="28" r="10"/><circle cx="28" cy="28" r="4"/></g><g fill="' + c + '" fill-opacity=".28"><rect x="26" y="2" width="4" height="10"/><rect x="26" y="44" width="4" height="10"/><rect x="2" y="26" width="10" height="4"/><rect x="44" y="26" width="10" height="4"/></g></svg>',
    };
    return 'url("data:image/svg+xml,' + encodeURIComponent(svgs[kind] || svgs.dot) + '")';
}

// Canvas 纹样绘制（保存图片时使用，与 HTML 卡片同一套纹样）
function drawPattern(g, kind, W, H, color, alpha) {
    g.save();
    g.globalAlpha = (alpha == null ? 0.3 : alpha);
    g.strokeStyle = color;
    g.fillStyle = color;
    g.lineWidth = 1.2;
    switch (kind) {
        case 'dot':
            for (let x = 16; x < W; x += 28) for (let y = 16; y < H; y += 28) { g.beginPath(); g.arc(x, y, 1.6, 0, Math.PI * 2); g.fill(); }
            break;
        case 'grid':
            for (let x = 20; x < W; x += 40) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
            for (let y = 20; y < H; y += 40) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
            break;
        case 'wave':
            for (let y = 14; y < H; y += 48) { g.beginPath(); for (let x = 0; x <= W; x += 8) { const yy = y + Math.sin(x / 16) * 7; if (x === 0) g.moveTo(x, yy); else g.lineTo(x, yy); } g.stroke(); }
            break;
        case 'hex':
            for (let x = 0; x < W + 60; x += 56) for (let y = ((x / 56) % 2 ? 14 : 42); y < H; y += 84) { g.beginPath(); for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3 - Math.PI / 2; const px = x + Math.cos(a) * 14, py = y + Math.sin(a) * 14; if (i === 0) g.moveTo(px, py); else g.lineTo(px, py); } g.closePath(); g.stroke(); }
            break;
        case 'star':
            for (let x = 24; x < W; x += 44) for (let y = 24; y < H; y += 44) { g.beginPath(); for (let i = 0; i < 10; i++) { const a = i * Math.PI / 5 - Math.PI / 2; const r = i % 2 ? 4 : 9; g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); } g.closePath(); g.fill(); }
            break;
        case 'sakura':
            for (let x = 24; x < W; x += 60) for (let y = 24; y < H; y += 60) { g.save(); g.translate(x, y); for (let i = 0; i < 5; i++) { g.rotate(Math.PI * 2 / 5); g.beginPath(); g.ellipse(0, -8, 3.5, 7, 0, 0, Math.PI * 2); g.fill(); } g.restore(); }
            break;
        case 'leaf':
            for (let x = 24; x < W; x += 70) for (let y = 24; y < H; y += 70) { g.beginPath(); g.moveTo(x - 14, y + 14); g.quadraticCurveTo(x, y - 14, x + 14, y - 14); g.quadraticCurveTo(x + 10, y + 6, x - 14, y + 14); g.stroke(); }
            break;
        case 'thorn':
            for (let x = 0; x < W; x += 56) { g.beginPath(); g.moveTo(x, H); g.quadraticCurveTo(x + 18, H - 40, x + 34, H - 90); g.stroke(); g.beginPath(); g.moveTo(x + 30, H - 76); g.lineTo(x + 42, H - 84); g.lineTo(x + 34, H - 66); g.closePath(); g.fill(); }
            break;
        case 'crack':
            for (let x = 8; x < W; x += 52) { let y = 0; g.beginPath(); g.moveTo(x, y); while (y < H) { y += 14 + (x % 9); g.lineTo(x + ((x * 7 + y) % 19) - 9, y); } g.stroke(); }
            break;
        case 'gear':
            for (let cx = 28; cx < W; cx += 64) for (let cy = 28; cy < H; cy += 64) { g.beginPath(); g.arc(cx, cy, 9, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.arc(cx, cy, 3.5, 0, Math.PI * 2); g.stroke(); for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; g.fillRect(cx + Math.cos(a) * 10 - 1.4, cy + Math.sin(a) * 10 - 1.4, 2.8, 2.8); } }
            break;
    }
    g.restore();
}

// ---------- 卡片渲染 & 保存 ----------
function cardHTML(char, obj) {
    const o = typeof obj === 'string'
        ? { wish: obj, motto: '', title: char.name + ' 的赠礼', bg1: '#2a1515', bg2: '#4a1f1f', accent: '#E06060', deco: ['🎁', '🕯️', '🌹'], style: '经典信笺', pattern: 'dot' }
        : (obj || {});
    const deco = Array.isArray(o.deco) && o.deco.length ? o.deco : ['🎁'];
    const body = isLight(o.bg1) ? '#4a3a3a' : '#f2e2e6';
    const pat = patternSVG(detectPattern(o.pattern), body);
    const styleTxt = o.style ? String(o.style).slice(0, 12) : '';
    return '<div class="st-bw-card" data-avatar="' + escapeHtml(char.avatar) + '" style="background:linear-gradient(135deg,' + o.bg1 + ',' + o.bg2 + ');border:1px solid ' + o.accent + ';">' +
        '<div class="st-bw-card-pattern" style="background-image:' + pat + ';"></div>' +
        '<div class="st-bw-card-deco">' + deco.map(function (d) { return '<span>' + escapeHtml(d) + '</span>'; }).join('') + '</div>' +
        '<div class="st-bw-card-title" style="color:' + o.accent + ';">' + escapeHtml(o.title || (char.name + ' 的赠礼')) + '</div>' +
        '<div class="st-bw-card-tag" style="color:' + o.accent + ';">' + escapeHtml(char.name) + (styleTxt ? ' · ' + escapeHtml(styleTxt) : '') + '</div>' +
        '<div class="st-bw-card-motto" style="color:' + body + ';">' + (o.motto ? '「' + escapeHtml(o.motto) + '」' : '') + '</div>' +
        '<div class="st-bw-card-wish" style="color:' + body + ';">' + escapeHtml(o.wish || '') + '</div>' +
        '<div class="st-bw-card-from" style="color:' + o.accent + ';">—— ' + escapeHtml(char.name) + '</div>' +
        '<div class="st-bw-card-actions">' +
        '<span class="st-bw-act" data-act="regen">🔄 重新生成</span>' +
        '<span class="st-bw-act" data-act="save">💾 保存图片</span>' +
        '<span class="st-bw-act" data-act="copy">📋 复制文字</span>' +
        '</div></div>';
}

function buildCanvasCard(char, obj, size) {
    const W = 600, H = 360;
    const o = typeof obj === 'string'
        ? { wish: obj, motto: '', title: char.name + ' 的赠礼', bg1: '#2a1515', bg2: '#4a1f1f', accent: '#E06060', deco: ['🎁', '🕯️', '🌹'], style: '经典信笺', pattern: 'dot' }
        : (obj || {});
    const deco = Array.isArray(o.deco) && o.deco.length ? o.deco : ['🎁'];
    const g1 = o.bg1, g2 = o.bg2;
    const body = isLight(g1) ? '#4a3a3a' : '#f2e2e6';
    const pat = detectPattern(o.pattern);
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const g = canvas.getContext('2d');
    // 背景渐变（AI 给出的角色专属配色）
    const grad = g.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, g1);
    grad.addColorStop(0.55, g2);
    grad.addColorStop(1, g1);
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    // 纹样背景层
    drawPattern(g, pat, W, H, body);
    // 装饰圆（强调色）
    g.fillStyle = o.accent;
    g.globalAlpha = .55;
    g.beginPath(); g.arc(80, 90, 34, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(W - 80, 80, 26, 0, Math.PI * 2); g.fill();
    g.globalAlpha = .35;
    g.fillRect(40, H - 60, W - 80, 8);
    g.globalAlpha = 1;
    // 主题装饰物（左上 + 右上）
    g.font = '24px "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
    g.textAlign = 'left';
    g.fillText(deco[0], 26, 320);
    if (deco[1]) g.fillText(deco[1], W - 96, 58);
    g.textAlign = 'center';
    // 标题（AI 专属短语）+ 两侧装饰短线
    g.fillStyle = o.accent;
    g.font = 'bold 26px "Segoe UI", "Microsoft YaHei", sans-serif';
    const title = String(o.title || char.name + ' 的赠礼');
    g.fillText(title, W / 2, 48);
    const tw = g.measureText(title).width;
    g.fillRect(W / 2 - tw / 2 - 46, 44, 30, 2.5);
    g.fillRect(W / 2 + tw / 2 + 16, 44, 30, 2.5);
    // 角色名 + 风格标签
    g.fillStyle = o.accent;
    g.font = 'bold 14px "Segoe UI", "Microsoft YaHei", sans-serif';
    g.fillText(char.name, W / 2, 70);
    // 角色专属句子（motto）
    if (o.motto) {
        g.font = 'bold 19px "Segoe UI", "Microsoft YaHei", sans-serif';
        g.fillText('「' + o.motto + '」', W / 2, 98);
    }
    // 祝福正文（自动换行）
    g.fillStyle = body;
    g.font = '16px "Segoe UI", "Microsoft YaHei", sans-serif';
    const maxW = W - 80;
    const lines = wrapText(g, o.wish || '', maxW);
    let y = 134;
    for (const ln of lines.slice(0, 8)) { g.fillText(ln, W / 2, y); y += 26; }
    // 署名
    g.fillStyle = o.accent;
    g.font = 'bold 15px "Segoe UI", "Microsoft YaHei", sans-serif';
    g.fillText('—— ' + char.name, W / 2, y + 14);
    // 底部装饰点
    g.fillStyle = o.accent;
    g.globalAlpha = .6;
    for (let i = 0; i < 8; i++) {
        g.beginPath(); g.arc(90 + i * 62, H - 26, 4, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;
    return canvas;
}
function wrapText(g, text, maxW) {
    const out = [];
    let line = '';
    for (const ch of String(text)) {
        if (g.measureText(line + ch).width > maxW) { out.push(line); line = ch; }
        else line += ch;
    }
    if (line) out.push(line);
    return out;
}
function saveCardPNG(char, wish) {
    try {
        const canvas = buildCanvasCard(char, wish);
        const a = document.createElement('a');
        const safe = String(char.name).replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim() || '角色';
        a.download = '生日祝福-' + safe + '.png';
        a.href = canvas.toDataURL('image/png');
        document.body.appendChild(a);
        a.click();
        a.remove();
    } catch (e) {
        alert('保存图片失败：' + e.message);
    }
}

// ---------- 弹层 UI ----------
function openOverlay(list) {
    const $old = $('#' + OVERLAY_ID);
    if ($old.length) $old.remove();
    const $ov = $('<div id="' + OVERLAY_ID + '" class="st-bw-overlay"></div>');
    $('body').append($ov);
    const $inner = $('<div class="st-bw-inner"></div>');
    $ov.append($inner);
    let idx = 0;
    function render(forceRegen) {
        const char = list[idx];
        $inner.html(
            '<div class="st-bw-close" id="st-bw-close">✕</div>' +
            '<div class="st-bw-count">' + (idx + 1) + ' / ' + list.length + '</div>' +
            '<div class="st-bw-loading">正在请 ' + escapeHtml(char.name) + ' 写下祝福…</div>'
        );
        genWish(char, forceRegen).then(obj => {
            if (!$('#' + OVERLAY_ID).length) return;
            $inner.find('.st-bw-loading').remove();
            $inner.append(cardHTML(char, obj));
            if (list.length > 1) {
                $inner.append('<div class="st-bw-nav">' +
                    '<span class="st-bw-nav-btn' + (idx === 0 ? ' disabled' : '') + '" data-nav="prev">← 上一张</span>' +
                    '<span class="st-bw-nav-btn' + (idx === list.length - 1 ? ' disabled' : '') + '" data-nav="next">下一张 →</span></div>');
            }
        }).catch(e => {
            if (!$('#' + OVERLAY_ID).length) return;
            $inner.find('.st-bw-loading').html('⚠ ' + escapeHtml(e.message));
            // 失败也保留翻页能力，不至于卡死在这一张
            if (list.length > 1) {
                $inner.append('<div class="st-bw-nav">' +
                    '<span class="st-bw-nav-btn' + (idx === 0 ? ' disabled' : '') + '" data-nav="prev">← 上一张</span>' +
                    '<span class="st-bw-nav-btn' + (idx === list.length - 1 ? ' disabled' : '') + '" data-nav="next">下一张 →</span></div>');
            }
        });
        // 翻页
        $inner.find('.st-bw-close').on('click', function () { $ov.remove(); });
        $inner.off('click.stbwNav');
        $inner.on('click.stbwNav', '.st-bw-nav-btn', function () {
            const $b = $(this);
            if ($b.hasClass('disabled')) return;
            if ($b.attr('data-nav') === 'prev' && idx > 0) { idx--; render(); }
            if ($b.attr('data-nav') === 'next' && idx < list.length - 1) { idx++; render(); }
        });
        $inner.on('click.stbwNav', '.st-bw-act', function () {
            const act = $(this).attr('data-act');
            if (act === 'regen') {
                // 只重新生成当前这张，翻页到别的卡不强制重生成
                render(true);
            } else if (act === 'save') saveCardPNG(char, obj);
            else if (act === 'copy') {
                const txt = '—— ' + char.name + ' 的生日祝福 ——\n' + (typeof obj === 'string' ? obj : (obj && obj.wish) || '');
                try { navigator.clipboard.writeText(txt).then(() => alert('已复制')); }
                catch { prompt('复制祝福文字：', txt); }
            }
        });
    }
    if (list.length) render();
    else {
        $inner.html('<div class="st-bw-close" id="st-bw-close">✕</div><div class="st-bw-loading">还没有聊过 ' + settings.threshold + ' 条消息的角色，去和角色多说说话吧～</div>');
        $inner.find('.st-bw-close').on('click', function () { $ov.remove(); });
    }
}

async function triggerBirthday(force) {
    if (!settings.birthday) return { show: false, reason: '未设置生日' };
    const bd = String(settings.birthday).split('-');
    if (bd.length < 3) return { show: false, reason: '生日格式错误' };
    const isToday = (Number(bd[1]) === new Date().getMonth() + 1) && (Number(bd[2]) === new Date().getDate());
    if (!isToday && !force) return { show: false, reason: '今天不是生日' };
    try {
        const list = await computeStats(force);
        // 启动初期角色库可能还没加载完：算出来为空且角色列表为空 → 稍后重试一次，避免误报"没聊过"
        if (!force && !list.length && (!getContext() || !getContext().characters || !getContext().characters.length)) {
            setTimeout(function () {
                if (settings.enabled) triggerBirthday(false);
            }, 12000);
            return { show: false, reason: '角色库加载中，稍后重试' };
        }
        openOverlay(list);
        return { show: true, count: list.length };
    } catch (e) {
        return { show: false, reason: e.message };
    }
}

// ---------- 魔法棒入口 & 设置 ----------
function buildSettingsHTML() {
    return '<div class="st-bw-title">🎂 生日祝福 · 设置</div>' +
        '<div class="st-bw-row st-bw-toggle"><label for="st-bw-enabled">启用生日祝福</label>' +
        '<span class="st-bw-switch"><input type="checkbox" id="st-bw-enabled"' + (settings.enabled ? ' checked' : '') + '></span>' +
        '<span class="st-bw-toggle-tip" id="st-bw-enabled-tip">' + (settings.enabled ? '已启用' : '已停用（不再自动弹祝福）') + '</span></div>' +
        '<div class="st-bw-row"><label>我的生日</label><input type="date" id="st-bw-birthday" value="' + escapeHtml(settings.birthday) + '"></div>' +
        '<div class="st-bw-row st-bw-toggle"><label for="st-bw-usemain">使用酒馆主 API</label>' +
        '<span class="st-bw-switch"><input type="checkbox" id="st-bw-usemain"' + (settings.useMain ? ' checked' : '') + '></span>' +
        '<span class="st-bw-toggle-tip">复用酒馆主连接，副 API 不填</span></div>' +
        '<div class="st-bw-row" id="st-bw-row-baseurl"><label>API Base URL（副 API）</label><input type="text" id="st-bw-baseurl" placeholder="https://api.example.com" value="' + escapeHtml(settings.baseUrl) + '"></div>' +
        '<div class="st-bw-row" id="st-bw-row-apikey"><label>API Key（副 API）</label><input type="password" id="st-bw-apikey" placeholder="sk-..." value="' + escapeHtml(settings.apiKey) + '"></div>' +
        '<div class="st-bw-row" id="st-bw-row-model"><label>模型 <span class="st-bw-mini-btn" id="st-bw-fetch-models">🔄 自动拉取</span></label>' +
        '<input type="text" id="st-bw-model" list="st-bw-models" placeholder="gpt-4o-mini / gemini-..." value="' + escapeHtml(settings.model) + '">' +
        '<datalist id="st-bw-models"></datalist></div>' +
        '<div class="st-bw-row"><label>聊过多少条才算（默认 10）</label><input type="number" id="st-bw-threshold" min="1" max="999" value="' + Number(settings.threshold) + '"></div>' +
        '<div class="st-bw-btn-row"><span class="st-bw-act-btn" id="st-bw-save">保存设置</span>' +
        '<span class="st-bw-act-btn" id="st-bw-preview">预览祝福（现在生成）</span></div>' +
        '<div class="st-bw-note">生日当天进入酒馆会自动弹出祝福（停用时不弹）。预览会立即统计并生成祝福（消耗 API 额度）。勾选「使用酒馆主 API」则复用主连接，否则用副 API。</div>';
}

function openPanel() {
    const $old = $('#st-bw-panel');
    if ($old.length) { $old.remove(); return; }
    const $panel = $('<div id="st-bw-panel" class="st-bw-panel"></div>');
    $panel.html(buildSettingsHTML());
    $('body').append($panel);
    $panel.on('mousedown.stbw touchstart.stbw', function (e) { e.stopPropagation(); });
    const syncRows = function () {
        const useMain = $panel.find('#st-bw-usemain').is(':checked');
        $panel.find('#st-bw-row-baseurl, #st-bw-row-apikey, #st-bw-row-model').toggle(!useMain);
    };
    $panel.on('click.stbwAct', '#st-bw-usemain', syncRows);
    syncRows();   // 打开设置面板时立即同步一次显隐
    $panel.on('change.stbwAct', '#st-bw-usemain', function () {
        settings.useMain = $(this).is(':checked');
        syncRows();
        saveSettings();
        $panel.append('<div class="st-bw-note st-bw-ok">✓ 已切换：' + (settings.useMain ? '使用酒馆主 API' : '使用副 API') + '</div>');
    });
    $panel.on('change.stbwAct', '#st-bw-enabled', function () {
        $panel.find('#st-bw-enabled-tip').text($(this).is(':checked') ? '已启用' : '已停用（不再自动弹祝福）');
    });
    $panel.on('click.stbwAct', '#st-bw-fetch-models', async function () {
        const baseUrl = String($panel.find('#st-bw-baseurl').val() || '').trim();
        const apiKey = String($panel.find('#st-bw-apikey').val() || '').trim();
        const $tip = $(this);
        if (!baseUrl || !apiKey) { $tip.text('⚠ 先填 Base URL / Key'); return; }
        $tip.text('⏳ 拉取中…');
        try {
            const models = await fetchModels(baseUrl, apiKey);
            const $dl = $panel.find('#st-bw-models');
            $dl.empty();
            models.forEach(m => $dl.append('<option value="' + escapeHtml(m) + '">'));
            $tip.text(models.length ? '✅ 已拉取 ' + models.length + ' 个' : '⚠ 未获取到模型');
        } catch { $tip.text('⚠ 拉取失败'); }
    });
    $panel.on('click.stbwAct', '#st-bw-save', function () {
        settings.enabled = $panel.find('#st-bw-enabled').is(':checked');
        settings.useMain = $panel.find('#st-bw-usemain').is(':checked');
        settings.birthday = String($panel.find('#st-bw-birthday').val() || '').trim();
        settings.baseUrl = String($panel.find('#st-bw-baseurl').val() || '').trim();
        settings.apiKey = String($panel.find('#st-bw-apikey').val() || '').trim();
        settings.model = String($panel.find('#st-bw-model').val() || '').trim();
        settings.threshold = Math.max(1, Number($panel.find('#st-bw-threshold').val()) || 10);
        saveSettings();
        refreshWandState();
        $panel.append('<div class="st-bw-note st-bw-ok">✓ 已保存</div>');
    });
    // 输入实时写回 settings（切换/关闭面板不丢）
    $panel.off('input.stbwLive').on('input.stbwLive', function () {
        settings.enabled = $panel.find('#st-bw-enabled').is(':checked');
        settings.useMain = $panel.find('#st-bw-usemain').is(':checked');
        settings.birthday = String($panel.find('#st-bw-birthday').val() || '').trim();
        settings.baseUrl = String($panel.find('#st-bw-baseurl').val() || '').trim();
        settings.apiKey = String($panel.find('#st-bw-apikey').val() || '').trim();
        settings.model = String($panel.find('#st-bw-model').val() || '').trim();
        settings.threshold = Math.max(1, Number($panel.find('#st-bw-threshold').val()) || 10);
    });
    $panel.on('click.stbwAct', '#st-bw-preview', async function () {
        $panel.find('#st-bw-save, #st-bw-preview').hide();
        const $note = $('<div class="st-bw-note">正在统计聊天记录…</div>');
        $panel.append($note);
        try {
            const list = await computeStats(true);
            openOverlay(list);
        } catch (e) {
            $panel.append('<div class="st-bw-note st-bw-err">⚠ ' + escapeHtml(e.message) + '</div>');
        } finally {
            $panel.find('#st-bw-save, #st-bw-preview').show();
            $note.remove();
        }
    });
}

// ---------- 魔法棒菜单入口注入 ----------
function refreshWandState() {
    const el = document.getElementById(WAND_ID);
    if (!el) return;
    if (settings.enabled) {
        el.style.opacity = '1';
        el.textContent = '🎂 生日祝福';
        el.title = '🎂 生日祝福设置 / 预览';
    } else {
        el.style.opacity = '.45';
        el.textContent = '🎂 生日祝福（已停用）';
        el.title = '已停用。点击打开设置可重新启用';
    }
}

function injectButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById(WAND_ID)) return;
    const el = document.createElement('div');
    el.id = WAND_ID;
    el.className = 'list-group-item flex-container flexGap5 interactable';
    el.setAttribute('tabindex', '0');
    el.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openPanel();
    });
    menu.appendChild(el);
    refreshWandState();
}

$(function () {
    injectButton();
    setInterval(function () {
        if (!document.getElementById(WAND_ID)) injectButton();
        else refreshWandState();
    }, 3000);
    // 进入酒馆自动检测生日（停用时不弹）
    setTimeout(function () {
        if (settings.enabled && settings.birthday) triggerBirthday(false);
    }, 4000);
});

$(document).on('mousedown.stbw touchstart.stbw', function (e) {
    if (!$(e.target).closest('#' + WAND_ID).length && !$(e.target).closest('#st-bw-panel').length && !$(e.target).closest('#' + OVERLAY_ID).length) {
        $('#st-bw-panel').remove();
    }
});

// ---------- CSS ----------
const STYLE_ID = 'st-bw-style';
if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
.st-bw-panel { position:fixed; top:12px; right:12px; z-index:99999; width:min(320px,calc(100vw - 24px)); max-height:80vh; overflow-y:auto; background:var(--SmartThemeBlurTintColor,#1e1e2e); color:#f2e2e6; border:1px solid #8B1A1A; border-radius:12px; padding:10px 12px; box-shadow:0 6px 24px rgba(0,0,0,.4); font-size:13px; }
.st-bw-title { font-weight:700; margin-bottom:8px; color:#C41E3A; font-size:14px; }
.st-bw-row { margin-bottom:8px; }
.st-bw-row label { display:block; font-size:12px; opacity:1; margin-bottom:2px; color:#D64545; }
.st-bw-row input { width:100%; box-sizing:border-box; padding:5px 8px; border-radius:6px; border:1px solid #8B1A1A; background:var(--SmartThemeBlurTintColor,#2a2a3a); color:#f2e2e6; font-size:12px; outline:none; }
.st-bw-toggle { display:flex; align-items:center; gap:8px; }
.st-bw-toggle label { flex:1; margin:0; }
.st-bw-switch { position:relative; width:34px; height:18px; flex-shrink:0; cursor:pointer; }
.st-bw-switch input { opacity:0; position:absolute; inset:0; width:100%; height:100%; margin:0; cursor:pointer; z-index:2; }
.st-bw-switch::after { content:''; position:absolute; inset:0; border-radius:18px; background:#444; transition:.2s; }
.st-bw-switch:has(input:checked)::after { background:#8B1A1A; }
.st-bw-switch::before { content:''; position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%; background:#fff; z-index:1; transition:.2s; }
.st-bw-switch:has(input:checked)::before { transform:translateX(16px); }
.st-bw-toggle-tip { font-size:11px; opacity:.9; flex-shrink:0; color:#E88383; }
.st-bw-mini-btn { display:inline-block; padding:2px 8px; border-radius:12px; cursor:pointer; font-size:11px; background:rgba(139,26,26,.35); color:#E88383; margin-left:6px; }
.st-bw-mini-btn:hover { background:rgba(139,26,26,.55); }
.st-bw-note { font-size:12px; opacity:.9; margin:6px 0; color:#E88383; }
.st-bw-ok { color:#A9C3A0; }
.st-bw-err { color:#E88; }
.st-bw-btn-row { display:flex; gap:8px; margin:8px 0; flex-wrap:wrap; }
.st-bw-act-btn { padding:6px 14px; border-radius:20px; cursor:pointer; font-size:13px; background:#8B1A1A; color:#fff; font-weight:700; }
.st-bw-act-btn:hover { filter:brightness(1.15); }
.st-bw-overlay { position:fixed; inset:0; z-index:100000; background:rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; }
.st-bw-inner { position:relative; width:min(480px,calc(100vw - 40px)); max-height:85vh; overflow-y:auto; }
.st-bw-close { position:absolute; top:10px; right:14px; z-index:2; font-size:20px; cursor:pointer; color:#E88383; opacity:.9; }
.st-bw-count { text-align:center; font-size:12px; opacity:.9; margin-bottom:6px; color:#E88383; }
.st-bw-loading { text-align:center; padding:40px 0; color:#E88383; }
.st-bw-card { position:relative; border-radius:16px; padding:22px 22px 14px; box-shadow:0 8px 30px rgba(0,0,0,.35); overflow:hidden; }
.st-bw-card-pattern { position:absolute; inset:0; pointer-events:none; opacity:.85; }
.st-bw-card-deco { position:relative; display:flex; justify-content:center; gap:14px; font-size:22px; margin-bottom:8px; }
.st-bw-card-title { position:relative; text-align:center; font-size:23px; font-weight:700; margin-bottom:4px; letter-spacing:.5px; }
.st-bw-card-title::before, .st-bw-card-title::after { content:''; position:absolute; top:50%; width:34px; height:2.5px; background:currentColor; opacity:.75; }
.st-bw-card-title::before { left:calc(50% - 118px); }
.st-bw-card-title::after { right:calc(50% - 118px); }
.st-bw-card-tag { position:relative; text-align:center; font-size:12px; font-weight:700; margin-bottom:8px; opacity:.92; }
.st-bw-card-motto { position:relative; text-align:center; font-size:17px; font-weight:700; margin-bottom:12px; min-height:24px; color:#f2e2e6; }
.st-bw-card-from { position:relative; text-align:center; font-size:15px; font-weight:700; margin:12px 0 2px; }
.st-bw-card-wish { position:relative; font-size:15px; line-height:1.7; text-align:center; word-break:break-all; }
.st-bw-card-actions { position:relative; display:flex; justify-content:center; gap:12px; margin-top:12px; }
.st-bw-nav { display:flex; justify-content:center; gap:10px; margin-top:14px; }
.st-bw-nav-btn { padding:6px 18px; border-radius:20px; cursor:pointer; font-size:13px; background:#8B1A1A; color:#fff; font-weight:700; }
.st-bw-nav-btn:hover { filter:brightness(1.15); }
.st-bw-nav-btn.disabled { opacity:.35; cursor:default; filter:none; }
.st-bw-act { padding:6px 14px; border-radius:20px; cursor:pointer; font-size:12px; background:rgba(139,26,26,.35); color:#f2e2e6; font-weight:700; border:1px solid rgba(255,255,255,.25); }
.st-bw-act:hover { background:rgba(139,26,26,.55); }
`;
    document.head.appendChild(style);
}
