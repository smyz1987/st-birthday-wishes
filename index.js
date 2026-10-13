// st-birthday-wishes: 生日祝福
// 设定生日日期；聊过 ≥N 条消息的角色在生日当天进入酒馆时，以各自口吻送上祝福卡片（可保存图片/复制文字）
import { getContext } from '../../../extensions.js';
import { getRequestHeaders } from '../../../../script.js';

const LS_SETTINGS = 'st-bw-settings';
const LS_WISHES = 'st-bw-wishes';       // { '月-日|avatar': '祝福文本' }
const LS_STATS = 'st-bw-stats';         // { date: 'M-D', list: [{avatar,name,count}] }
const OVERLAY_ID = 'st-bw-overlay';
const WAND_ID = 'st-bw-wand';

let settings = { birthday: '', baseUrl: '', apiKey: '', model: '', threshold: 10 };

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
async function genWish(char) {
    const key = todayMD() + '|' + char.avatar;
    const cache = (() => { try { return JSON.parse(localStorage.getItem(LS_WISHES) || '{}'); } catch { return {}; } })();
    if (cache[key]) return cache[key];
    if (!settings.baseUrl || !settings.apiKey || !settings.model) {
        return '（请在设置里配置 API 后重新生成祝福）';
    }
    const c = getContext().characters.find(x => String(x.avatar || (x.data && x.data.avatar)) === char.avatar);
    const desc = truncate(String((c && (c.description || (c.data && c.data.description))) || ''), 500);
    const first = truncate(String((c && (c.first_mes || (c.data && c.data.first_mes))) || ''), 300);
    let url = String(settings.baseUrl).trim().replace(/\/+$/, '');
    if (!/\/v\d+$/.test(url)) url += '/v1';
    url += '/chat/completions';
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + settings.apiKey },
        body: JSON.stringify({
            model: settings.model,
            messages: [
                { role: 'system', content: '你正在扮演角色「' + char.name + '」。' + (desc ? '人设：' + desc : '') + (first ? '开场白：' + first : '') + '今天是用户的生日。请完全以「' + char.name + '」的身份、用符合 TA 性格的口吻写一句生日祝福，60-120字，要有角色特色（称呼、语气、习惯），不要提到AI/模型/扮演。只输出祝福本身。' },
                { role: 'user', content: '今天是我生日，祝我生日快乐吧。' },
            ],
            temperature: 0.9,
            max_tokens: 300,
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
    const wish = String(text).trim();
    cache[key] = wish;
    localStorage.setItem(LS_WISHES, JSON.stringify(cache));
    return wish;
}

// ---------- 卡片渲染 & 保存 ----------
function cardHTML(char, wish) {
    const firstLine = '🎂 生日快乐 🎂';
    return '<div class="st-bw-card" data-avatar="' + escapeHtml(char.avatar) + '">' +
        '<div class="st-bw-card-top">' + firstLine + '</div>' +
        '<div class="st-bw-card-from">—— ' + escapeHtml(char.name) + '</div>' +
        '<div class="st-bw-card-wish">' + escapeHtml(wish) + '</div>' +
        '<div class="st-bw-card-actions">' +
        '<span class="st-bw-act" data-act="save">💾 保存图片</span>' +
        '<span class="st-bw-act" data-act="copy">📋 复制文字</span>' +
        '</div></div>';
}

function buildCanvasCard(char, wish, size) {
    const W = 600, H = 360;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const g = canvas.getContext('2d');
    // 背景渐变（粉→金）
    const grad = g.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#F9E4E4');
    grad.addColorStop(0.55, '#F6D8D8');
    grad.addColorStop(1, '#F2D9B8');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    // 装饰：蛋糕简笔 + 气球
    g.fillStyle = 'rgba(217,167,167,.55)';
    g.beginPath(); g.arc(80, 90, 34, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(W - 80, 80, 26, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(233,196,141,.7)';
    g.beginPath(); g.arc(W - 90, 150, 18, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(217,167,167,.35)';
    g.fillRect(40, H - 60, W - 80, 8);
    // 标题
    g.fillStyle = '#B06060';
    g.font = 'bold 30px "Segoe UI", "Microsoft YaHei", sans-serif';
    g.textAlign = 'center';
    g.fillText('🎂 生日快乐 🎂', W / 2, 56);
    // 角色名
    g.fillStyle = '#A05050';
    g.font = 'bold 18px "Segoe UI", "Microsoft YaHei", sans-serif';
    g.fillText('—— ' + char.name, W / 2, 92);
    // 祝福正文（自动换行）
    g.fillStyle = '#5a3a3a';
    g.font = '16px "Segoe UI", "Microsoft YaHei", sans-serif';
    const maxW = W - 80;
    const lines = wrapText(g, wish, maxW);
    let y = 130;
    for (const ln of lines.slice(0, 9)) { g.fillText(ln, W / 2, y); y += 26; }
    // 底部装饰点
    g.fillStyle = 'rgba(217,167,167,.6)';
    for (let i = 0; i < 8; i++) {
        g.beginPath(); g.arc(90 + i * 62, H - 26, 4, 0, Math.PI * 2); g.fill();
    }
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
        a.download = '生日祝福-' + char.name + '.png';
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
    function render() {
        const char = list[idx];
        $inner.html(
            '<div class="st-bw-close" id="st-bw-close">✕</div>' +
            '<div class="st-bw-count">' + (idx + 1) + ' / ' + list.length + '</div>' +
            '<div class="st-bw-loading">正在请 ' + escapeHtml(char.name) + ' 写下祝福…</div>'
        );
        genWish(char).then(wish => {
            if (!$('#' + OVERLAY_ID).length) return;
            $inner.find('.st-bw-loading').remove();
            $inner.append(cardHTML(char, wish));
        }).catch(e => {
            if (!$('#' + OVERLAY_ID).length) return;
            $inner.find('.st-bw-loading').html('⚠ ' + escapeHtml(e.message));
        });
        // 翻页
        $inner.find('.st-bw-close').on('click', function () { $ov.remove(); });
        $inner.off('click.stbwNav');
        $inner.on('click.stbwNav', '.st-bw-prev', function () { if (idx > 0) { idx--; render(); } });
        $inner.on('click.stbwNav', '.st-bw-next', function () { if (idx < list.length - 1) { idx++; render(); } });
        $inner.on('click.stbwNav', '.st-bw-act', function () {
            const act = $(this).attr('data-act');
            if (act === 'save') saveCardPNG(char, wish);
            else if (act === 'copy') {
                const txt = '—— ' + char.name + ' 的生日祝福 ——\n' + wish;
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
        openOverlay(list);
        return { show: true, count: list.length };
    } catch (e) {
        return { show: false, reason: e.message };
    }
}

// ---------- 悬浮按钮 & 设置 ----------
function buildSettingsHTML() {
    return '<div class="st-bw-title">🎂 生日祝福 · 设置</div>' +
        '<div class="st-bw-row"><label>我的生日</label><input type="date" id="st-bw-birthday" value="' + escapeHtml(settings.birthday) + '"></div>' +
        '<div class="st-bw-row"><label>API Base URL</label><input type="text" id="st-bw-baseurl" placeholder="https://api.example.com" value="' + escapeHtml(settings.baseUrl) + '"></div>' +
        '<div class="st-bw-row"><label>API Key</label><input type="password" id="st-bw-apikey" placeholder="sk-..." value="' + escapeHtml(settings.apiKey) + '"></div>' +
        '<div class="st-bw-row"><label>模型</label><input type="text" id="st-bw-model" placeholder="gpt-4o-mini / gemini-..." value="' + escapeHtml(settings.model) + '"></div>' +
        '<div class="st-bw-row"><label>聊过多少条才算（默认 10）</label><input type="number" id="st-bw-threshold" min="1" max="999" value="' + Number(settings.threshold) + '"></div>' +
        '<div class="st-bw-btn-row"><span class="st-bw-act-btn" id="st-bw-save">保存设置</span>' +
        '<span class="st-bw-act-btn" id="st-bw-preview">预览祝福（现在生成）</span></div>' +
        '<div class="st-bw-note">生日当天进入酒馆会自动弹出祝福。预览会立即统计并生成祝福（消耗 API 额度）。</div>';
}

function openPanel() {
    const $old = $('#st-bw-panel');
    if ($old.length) { $old.remove(); return; }
    const $panel = $('<div id="st-bw-panel" class="st-bw-panel"></div>');
    $panel.html(buildSettingsHTML());
    $('body').append($panel);
    $panel.on('mousedown.stbw touchstart.stbw', function (e) { e.stopPropagation(); });
    $panel.on('click.stbwAct', '#st-bw-save', function () {
        settings.birthday = String($panel.find('#st-bw-birthday').val() || '').trim();
        settings.baseUrl = String($panel.find('#st-bw-baseurl').val() || '').trim();
        settings.apiKey = String($panel.find('#st-bw-apikey').val() || '').trim();
        settings.model = String($panel.find('#st-bw-model').val() || '').trim();
        settings.threshold = Math.max(1, Number($panel.find('#st-bw-threshold').val()) || 10);
        saveSettings();
        $panel.append('<div class="st-bw-note st-bw-ok">✓ 已保存</div>');
    });
    $panel.on('click.stbwAct', '#st-bw-preview', async function () {
        $panel.find('#st-bw-save, #st-bw-preview').hide();
        $panel.append('<div class="st-bw-note">正在统计聊天记录…</div>');
        try {
            const list = await computeStats(true);
            openOverlay(list);
        } catch (e) {
            $panel.append('<div class="st-bw-note st-bw-err">⚠ ' + escapeHtml(e.message) + '</div>');
        } finally {
            $panel.find('#st-bw-save, #st-bw-preview').show();
            $panel.find('.st-bw-note:last').remove();
        }
    });
}

// ---------- 魔法棒菜单入口注入 ----------
function injectButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById(WAND_ID)) return;
    const el = document.createElement('div');
    el.id = WAND_ID;
    el.className = 'list-group-item flex-container flexGap5 interactable';
    el.setAttribute('tabindex', '0');
    el.title = '🎂 生日祝福设置 / 预览';
    el.textContent = '🎂 生日祝福';
    el.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openPanel();
    });
    menu.appendChild(el);
}

$(function () {
    injectButton();
    setInterval(function () { if (!document.getElementById(WAND_ID)) injectButton(); }, 3000);
    // 进入酒馆自动检测生日
    setTimeout(function () {
        if (settings.birthday) triggerBirthday(false);
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
.st-bw-panel { position:fixed; top:12px; right:12px; z-index:99999; width:min(320px,calc(100vw - 24px)); max-height:80vh; overflow-y:auto; background:var(--SmartThemeBlurTintColor,#1e1e2e); color:var(--SmartThemeMainColor,#e0e0e0); border:1px solid var(--SmartThemeBorderColor,#666); border-radius:12px; padding:10px 12px; box-shadow:0 6px 24px rgba(0,0,0,.4); font-size:13px; }
.st-bw-title { font-weight:700; margin-bottom:8px; color:#E8C9A0; }
.st-bw-row { margin-bottom:8px; }
.st-bw-row label { display:block; font-size:12px; opacity:.8; margin-bottom:2px; }
.st-bw-row input { width:100%; box-sizing:border-box; padding:5px 8px; border-radius:6px; border:1px solid var(--SmartThemeBorderColor,#666); background:var(--SmartThemeBlurTintColor,#2a2a3a); color:var(--SmartThemeMainColor,#e0e0e0); font-size:12px; outline:none; }
.st-bw-note { font-size:12px; opacity:.75; margin:6px 0; }
.st-bw-ok { color:#A9C3A0; }
.st-bw-err { color:#E88; }
.st-bw-btn-row { display:flex; gap:8px; margin:8px 0; flex-wrap:wrap; }
.st-bw-act-btn { padding:6px 14px; border-radius:20px; cursor:pointer; font-size:13px; background:#E8C9A0; color:#4a3a2a; font-weight:700; }
.st-bw-act-btn:hover { filter:brightness(1.08); }
.st-bw-overlay { position:fixed; inset:0; z-index:100000; background:rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; }
.st-bw-inner { position:relative; width:min(480px,calc(100vw - 40px)); max-height:85vh; overflow-y:auto; }
.st-bw-close { position:absolute; top:10px; right:14px; z-index:2; font-size:20px; cursor:pointer; color:#8a6a6a; opacity:.8; }
.st-bw-count { text-align:center; font-size:12px; opacity:.8; margin-bottom:6px; color:#8a6a6a; }
.st-bw-loading { text-align:center; padding:40px 0; color:#8a6a6a; }
.st-bw-card { background:linear-gradient(135deg,#F9E4E4,#F6D8D8 55%,#F2D9B8); border-radius:16px; padding:26px 22px; color:#5a3a3a; box-shadow:0 8px 30px rgba(0,0,0,.35); border:1px solid rgba(255,255,255,.5); }
.st-bw-card-top { text-align:center; font-size:24px; font-weight:700; color:#B06060; margin-bottom:6px; }
.st-bw-card-from { text-align:center; font-size:16px; font-weight:700; color:#A05050; margin-bottom:14px; }
.st-bw-card-wish { font-size:15px; line-height:1.7; text-align:center; word-break:break-all; }
.st-bw-card-actions { display:flex; justify-content:center; gap:12px; margin-top:18px; }
.st-bw-act { padding:6px 14px; border-radius:20px; cursor:pointer; font-size:12px; background:rgba(255,255,255,.65); color:#7a4a4a; font-weight:700; }
.st-bw-act:hover { background:rgba(255,255,255,.9); }
`;
    document.head.appendChild(style);
}
