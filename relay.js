#!/usr/bin/env node
/**
 * 木木 · 中转服务
 * ============================================================
 * 她按下按钮 → 这里记下 → 木木说几句 → 他的手机响。
 *
 * 部署：/opt/mumu/relay.js，监听 127.0.0.1:9394（只对本机，
 *       外部经 nginx 的 location /mumu/ 反代进来）
 * 数据：/opt/mumu/data.json（原子写，先写 .tmp 再 rename）
 * 日志：/opt/mumu/relay.log（只记事件类型与时间，绝不记她说的话）
 *
 * 设计约束（改动前先想清楚）：
 *   1. 她不说话，这里不许主动发任何东西
 *   2. 危机信号命中 → 不生成任何 AI 回复，只回他手写的原话 + 推给他
 *   3. 木木不许替他承诺（提示词里写死，代码不额外兜底）
 *   4. 按下按钮之后的对话才同步给他，其余不上传
 * ============================================================
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 农历转换。只为一件事：他的生日是大年初三，
// 而农历每年对应的公历日子都不一样，手填一年就错。
let Lunar = null;
try {
  Lunar = require('lunar-javascript').Lunar;
} catch (e) {
  console.error('[warn] 没装 lunar-javascript，农历生日会算不出来（其它功能不受影响）');
}

const DIR = __dirname;
const CONFIG_FILE = path.join(DIR, 'config.json');
const DATA_FILE = path.join(DIR, 'data.json');
const LOG_FILE = path.join(DIR, 'relay.log');
const GALLERY_DIR = path.join(DIR, 'gallery');
const AVATAR_FILE = path.join(DIR, 'avatar.jpg');
const MUSIC_DIR = path.join(DIR, 'music');

// ── 歌：安全的名字 ──────────────────────────────────────────
//
// ⚠️ 歌名是从 query / body 里来的，**绝不能直接拼进路径**。
//    一个 `../../etc/passwd` 就能读服务器上任何文件，写的话更糟。
//    所以先 path.basename 砍掉所有目录成分，再卡扩展名白名单。
const MUSIC_EXT = /\.(mp3|m4a|aac|wav|ogg|flac)$/i;

function musicSafeName(raw) {
  const base = path.basename(String(raw || '').trim());
  if (!base || base === '.' || base === '..') return null;
  if (!MUSIC_EXT.test(base)) return null;
  if (base.length > 120) return null;
  return base;
}

// 图库的八个分类。目录名走英文 —— 中文目录名在服务器上传来传去容易出乱码；
// 但他端那边说中文也得查得到，所以留一张中文别名表。
const GALLERY_KINDS = ['lost', 'gloomy', 'excited', 'happy',
                       'yearning', 'wistful', 'moved', 'bliss'];
const GALLERY_ALIAS = {
  '失落': 'lost', '郁闷': 'gloomy', '激动': 'excited', '开心': 'happy',
  '憧憬': 'yearning', '感慨': 'wistful', '感动': 'moved', '幸福': 'bliss'
};

const HOST = '127.0.0.1';
const MAX_BODY = 64 * 1024;        // 请求体上限，防打爆内存
const DS_TIMEOUT_MS = 30000;       // DeepSeek 调用超时

// ── 配置 ────────────────────────────────────────────────────
let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch (e) {
  console.error('[fatal] 读不到 config.json：' + e.message);
  process.exit(1);
}
const PORT = config.port || 9394;

// ── 轻量日志（只记事件，不记内容）────────────────────────────
function log(event, extra) {
  const line = new Date().toISOString() + ' ' + event + (extra ? ' ' + extra : '');
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) { /* 日志写不进去也不能影响主流程 */ }
}

// ── 数据层：原子写 ──────────────────────────────────────────
function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(d.sessions)) d.sessions = [];
    if (!Array.isArray(d.knocks)) d.knocks = [];        // 「小小的打扰一下」
    if (!Array.isArray(d.fromHim)) d.fromHim = [];      // 他留给她的东西
    if (typeof d.quiet !== 'boolean') d.quiet = false;  // 她按了「不吵啦」
    if (!Array.isArray(d.fromHer)) d.fromHer = [];      // 她在聊天里说的
    if (typeof d.lastShakeAt !== 'number') d.lastShakeAt = 0;
    if (!d.shake || typeof d.shake !== 'object') d.shake = null;
    if (!Array.isArray(d.calendar)) d.calendar = [];    // 日历上自己加的日程
    if (d.notifyLevel !== 'crisis') d.notifyLevel = 'all';   // 通知开关：all / crisis
    if (typeof d.proactiveText !== 'string') d.proactiveText = '';
    if (typeof d.proactiveAt !== 'number') d.proactiveAt = 0;
    if (!d.proactive || typeof d.proactive !== 'object') {
      d.proactive = { day: '', count: 0, lastAt: 0 };
    }
    if (typeof d.status !== 'string') d.status = '';    // 哥哥的状态，她在主页看
    if (typeof d.statusAt !== 'number') d.statusAt = 0;
    if (typeof d.seq !== 'number') d.seq = 0;
    return d;
  } catch (_) {
    return { sessions: [], knocks: [], fromHim: [], status: '', statusAt: 0, seq: 0 };
  }
}

let data = loadData();

function saveData() {
  const tmp = DATA_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, DATA_FILE);   // 同分区 rename 是原子的
  } catch (e) {
    console.error('[save] 落盘失败：' + e.message);
  }
}

// 只保留最近 N 个会话，别让文件无限长
const MAX_SESSIONS = 200;
function prune() {
  if (data.sessions.length > MAX_SESSIONS) {
    data.sessions = data.sessions.slice(-MAX_SESSIONS);
  }
}

// ── 令牌比较（定长，避免时序侧信道）──────────────────────────
function tokenOk(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function whoIs(req, body) {
  const t = (body && body.token) || req.headers['x-mumu-token'] || '';
  if (tokenOk(t, config.tokens.her)) return 'her';
  if (tokenOk(t, config.tokens.him)) return 'him';
  return null;
}

// ── 限流：每 IP 每分钟 ──────────────────────────────────────
const buckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const limit = config.limits.ratePerMinutePerIp || 30;
  let b = buckets.get(ip);
  if (!b || now - b.start > 60000) {
    b = { start: now, n: 0 };
    buckets.set(ip, b);
  }
  b.n++;
  // 顺手清理过期桶，防止 Map 无限增长
  if (buckets.size > 500) {
    for (const [k, v] of buckets) {
      if (now - v.start > 120000) buckets.delete(k);
    }
  }
  return b.n > limit;
}

// ── 危机检测（第一层：硬词表）────────────────────────────────
// 命中即命中，不做远近语义判断——宁可误报。
// 第二层是提示词里让模型自己吐【警报】，两层任一命中都算。
// ⚠️⚠️ 这张表【只放最明确的表述】。中文里的「死」字用得太泛，
// 放进来一个模糊的，代价是误报 —— 而误报的代价是真的拨出一通电话。
//
// 2026-09-17 血的教训：原来表里有「去死」。她打字说的是
// 「我去死了」「去死了」—— 那是"笑死我了"的意思。
// 结果触发了两次危机、给她看了莫名其妙的回复、还自动拨了两次电话。
// 「去死」「不如死」这类已经删掉。真要表达自杀意图会用「想死」「不想活」，
// 那些词一个没少。模糊的一律交给第二层（模型判断）。
const CRISIS_WORDS = [
  '自杀', '轻生', '不想活', '活不下去', '活不下去了', '想死', '死了算了',
  '割腕', '割手', '割脖子', '跳楼', '跳下去', '跳河',
  '安眠药', '自残', '伤害自己', '结束生命', '结束自己', '了结自己',
  '不想活了', '撑不下去了', '熬不下去了',
  // 「没意思了」「消失算了」「割了」「划了」「流血了」也删了 ——
  // 都太容易撞上日常说法（"这电影没意思""手划了"）。
  // 2026-09-16 加「割自己」是因为她【真的】说了「我又割自己了」，
  // 那个词保留：它的指向足够明确。
  '割自己', '划自己', '弄伤自己'
];

// ── 她明确要求"转告"的话 ────────────────────────────────────
//
// "帮我告诉你主人，再不回消息我就要生气了" —— 这类话的重点不是情绪，
// 是【她在要求把话带到】。所以它必须开口念出来，不能跟普通闲聊一样
// 只躺在通知栏里等他什么时候想起来看。
//
// 用词表而不是模型判断：这类说法就那么几种，词表更稳、更快、不花钱。
// 真漏了再加词就是。
const RELAY_WORDS = [
  '帮我告诉', '帮我转告', '帮我跟', '帮我说', '替我告诉', '替我转告',
  '帮我带', '帮我传', '转告他', '转告你', '你跟他说', '你告诉他',
  '告诉他我', '让他知道', '你主人', '带你主人', '带个话', '带句话',
  '帮我问问他', '问问他还要不要'
];

function isRelay(text) {
  if (typeof text !== 'string') return false;
  const t = text.replace(/\s/g, '');
  for (const w of RELAY_WORDS) {
    if (t.indexOf(w) >= 0) return true;
  }
  return false;
}

function hitCrisis(text) {
  if (typeof text !== 'string') return null;
  const t = text.replace(/\s/g, '');
  for (const w of CRISIS_WORDS) {
    if (t.indexOf(w) >= 0) return w;
  }
  return null;
}

// ── DeepSeek ────────────────────────────────────────────────
function callDeepSeek(messages, maxTokens, cb) {
  const payload = JSON.stringify({
    model: config.deepseek.model,
    messages: messages,
    stream: false,
    temperature: 0.9,
    max_tokens: maxTokens || 3000,
    // ⚠️ 关掉思考。
    //
    // deepseek-flash 默认开着推理，两个坏处：
    //   1. 慢 —— 要多等几百 token 的思考，而木木只需要回一两句
    //   2. max_tokens 是「推理 + 正文」共用的额度，推理一多吃，正文就写不出来。
    //      实测定 300 时 content 直接返回空字符串，看着像网络抖动（查了很久）
    //
    // 两种写法实测试过是真能关掉的：thinking.type=disabled、reasoning_effort=none。
    // enable_thinking=false 和 chat_template_kwargs.enable_thinking 都是无效的。
    thinking: { type: 'disabled' }
  });

  const req = https.request({
    hostname: 'api.deepseek.com',
    port: 443,
    path: '/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + config.deepseek.key,
      'Content-Length': Buffer.byteLength(payload)
    }
  }, (res) => {
    let buf = '';
    res.on('data', (c) => { buf += c; });
    res.on('end', () => {
      if (res.statusCode !== 200) {
        return cb(new Error('deepseek HTTP ' + res.statusCode + ': ' + buf.slice(0, 200)));
      }
      try {
        const j = JSON.parse(buf);
        const text = j && j.choices && j.choices[0] &&
                     j.choices[0].message && j.choices[0].message.content;
        if (!text) return cb(new Error('deepseek 返回空内容'));
        cb(null, String(text).trim());
      } catch (e) {
        cb(new Error('deepseek 返回不是 JSON：' + e.message));
      }
    });
  });

  req.on('error', cb);
  req.setTimeout(DS_TIMEOUT_MS, () => { req.destroy(new Error('deepseek 超时')); });
  req.write(payload);
  req.end();
}

/**
 * 该不该主动找她说话。该的话把话【提前生成好】存着。
 *
 * 三条边界是他 2026-09-17 定的，别放宽：
 *   ① 一天最多 2 次
 *   ② 只在 10:00–22:00
 *   ③ 她把通知关了就连这个一起停 —— 她要的是清静，不是"关一半"
 *
 * 为什么提前生成而不是等她来拉的时候现生成：
 * /herpoll 是每 15 秒一次的请求，不能让它等模型想三秒。
 */
function prepareProactive() {
  if (data.proactiveText) return;   // 已经有一条没被取走了，别叠

  const now = new Date();
  const hour = now.getHours();
  if (hour < 10 || hour >= 22) return;                 // ② 时段

  if (data.notifyLevel === 'crisis') return;           // ③ 她关了通知就一起停
  if (data.quiet) return;                              // ④ 「不吵啦」更彻底，连木木都闭嘴

  const today = fmtDate(now);
  const p = data.proactive || { day: '', count: 0, lastAt: 0 };
  if (p.day !== today) p.count = 0;
  if (p.count >= 2) return;                                          // ① 一天两次
  if (Date.now() - (p.lastAt || 0) < 4 * 3600 * 1000) return;        // ① 间隔四小时

  // 她最近 2 小时说过话就别插嘴 —— 那是正在聊，不是没人理
  let lastHer = 0;
  for (const s of data.sessions) {
    for (const t of s.turns) {
      if (t.who === 'her' && t.at > lastHer) lastHer = t.at;
    }
  }
  if (!lastHer) return;                                        // 从来没聊过，别自作多情
  if (Date.now() - lastHer < 2 * 3600 * 1000) return;

  const msgs = [{ role: 'system', content: config.systemPrompt }];
  if (config.herProfile && config.herProfile.trim()) {
    msgs.push({ role: 'system', content: '【关于' + (config.herName || '她') + '】\n' + config.herProfile.trim() });
  }
  const recent = [];
  for (const s of data.sessions) {
    for (const t of s.turns) if (t.text) recent.push(t);
  }
  recent.sort((a, b) => a.at - b.at);
  for (const t of recent.slice(-8)) {
    msgs.push({ role: t.who === 'her' ? 'user' : 'assistant', content: t.text });
  }
  msgs.push({
    role: 'user',
    content: '（她有一阵子没说话了。你主动跟她说一句 —— 不用问"在干嘛"，'
      + '就像惦记着她那样随口说一句。一两句，别长。也别提"你很久没来了"。）'
  });

  callWithRetry(msgs, 500, (e, raw) => {
    if (e) {
      log('proactive_error', e.message);
      return;
    }
    const text = String(raw || '').trim();
    if (!text) return;

    data.proactiveText = text.slice(0, 200);
    data.proactiveAt = Date.now();
    data.proactive = { day: today, count: (p.count || 0) + 1, lastAt: Date.now() };
    saveData();
    log('proactive', text.slice(0, 30));
  });
}

/**
 * 清掉 180 天前的对话流水。
 *
 * ⚠️ 只清对话，【不动】fromHim（他发的语音照片）和 calendar（日历）。
 * 那两样是"东西"，她回头还要翻；对话是流水 ——
 * 留着只会把 data.json 撑大，而服务器只有 1.6G 内存、
 * 每次读写都是整个文件重写一遍。
 */
function pruneOldData() {
  const cutoff = Date.now() - 180 * 86400000;
  let removed = 0;

  // 聊天记录也一样清 —— 但上限本来就只留 200 条，这里只是兜底
  const beforeChat = (data.fromHer || []).length;
  data.fromHer = (data.fromHer || []).filter((x) => x.at > cutoff);
  removed += beforeChat - data.fromHer.length;

  for (const s of data.sessions) {
    const before = s.turns.length;
    s.turns = s.turns.filter((t) => t.at > cutoff);
    removed += before - s.turns.length;
  }

  const beforeSessions = data.sessions.length;
  data.sessions = data.sessions.filter((s) => s.turns.length > 0);

  if (removed || beforeSessions !== data.sessions.length) {
    saveData();
    log('prune', '清了 ' + removed + ' 条旧对话、'
      + (beforeSessions - data.sessions.length) + ' 个空会话');
  }
}

/** 2026-09-17 这种格式 */
function fmtDate(d) {
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/**
 * 把所有重要日子换算成「下一次是哪天、还有几天」。
 *
 * 公历的（11-20 这种）直接套月份日子。
 * 农历的（他生日是大年初三）**必须用库算** ——
 * 农历每年对应的公历日子都不一样，手填过一年就错一天，
 * 而她一定会发现"你连自己生日都记错"。
 */
function upcomingDays() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const out = [];

  for (const d of (config.specialDays || [])) {
    let next = null;

    if (d.lunarMonth && d.lunarDay) {
      if (!Lunar) continue;   // 库没装就当没这条，别让整个日历挂掉
      // 今年和明年都算一遍，取还没过的那个
      for (const y of [today.getFullYear(), today.getFullYear() + 1]) {
        try {
          const s = Lunar.fromYmd(y, d.lunarMonth, d.lunarDay).getSolar();
          const dt = new Date(s.getYear(), s.getMonth() - 1, s.getDay());
          if (dt >= today) { next = dt; break; }
        } catch (e) {
          // 那一年这个农历日不存在（闰月之类），跳过
        }
      }
    } else if (d.month && d.day) {
      for (const y of [today.getFullYear(), today.getFullYear() + 1]) {
        const dt = new Date(y, d.month - 1, d.day);
        if (dt >= today) { next = dt; break; }
      }
    }

    if (!next) continue;
    const daysLeft = Math.round((next - today) / 86400000);
    out.push({
      title: d.title,
      date: fmtDate(next),
      daysLeft: daysLeft,
      isToday: daysLeft === 0,
      lunar: !!(d.lunarMonth && d.lunarDay)
    });
  }

  out.sort((a, b) => a.daysLeft - b.daysLeft);
  return out;
}

/**
 * 把一句话切成 2 字片段，用来在历史里找"聊过相关的"。
 *
 * 没有分词库，2-gram 是最省事又够用的办法：
 * "上次说的那个猫" → 上次/次说/说的/的那/那个/个猫
 * 历史里只要撞上两个以上，就当成同一个话题。
 */
function bigrams(s) {
  const clean = String(s || '').replace(/[^一-龥a-zA-Z0-9]/g, '');
  const out = new Set();
  for (let i = 0; i < clean.length - 1; i++) out.add(clean.substr(i, 2));
  return out;
}

/**
 * 从历史里挑出真正相关的几句。
 *
 * 两步：
 *   ① 本地 2-gram 粗筛，挑 20 个候选（几毫秒，不花钱）
 *   ② 交给模型精排，选出最相关的 4 条
 *
 * 为什么要第二步：光靠撞字很容易捞错 —— "我想你"能撞上一堆不相干的。
 * 模型看一眼就知道哪句是真的在说同一件事。
 *
 * ⚠️ 这一步和 judgeMood 是【并行】跑的（见 handleHerText），
 * 不然两次调用叠起来要三秒多，她等不起。
 */
function recallSmart(text, cb) {
  const candidates = recallRelated(text, 20);
  if (candidates.length === 0) return cb([]);

  const list = candidates.map((c, i) => '[' + i + '] ' + c.text).join('\n');
  const msgs = [
    {
      role: 'system',
      content: '你在从「她以前说过的话」里，挑出跟「她这次说的这句」真正相关的。\n\n'
        + '只输出编号，用逗号分隔，最多 4 个，从最相关排到最不相关。\n'
        + '一条相关的都没有，就只输出：无\n'
        + '除了编号什么都不要输出。'
    },
    {
      role: 'user',
      content: '她这次说：' + text + '\n\n以前说过的：\n' + list
    }
  ];

  callDeepSeek(msgs, 30, (e, raw) => {
    if (e) {
      // 精排失败就退回粗筛的前 4 条 —— 有总比没有强
      log('recall_error', e.message);
      return cb(candidates.slice(0, 4));
    }
    const s = String(raw || '').trim();
    if (s.length <= 3 && s.indexOf('无') >= 0) return cb([]);

    const picked = [];
    const nums = s.match(/\d+/g) || [];
    for (const n of nums) {
      const i = Number(n);
      if (i >= 0 && i < candidates.length) {
        const c = candidates[i];
        if (!picked.some((p) => p.text === c.text)) picked.push(c);
      }
      if (picked.length >= 4) break;
    }
    cb(picked);
  });
}

/**
 * 本地粗筛：把话切成 2 字片段去撞历史。
 *
 * 不追求精准（精准交给 recallSmart 的第二层），只求"不漏得太离谱"且够快。
 */
function recallRelated(text, limit) {
  const mine = bigrams(text);
  if (mine.size === 0) return [];

  const scored = [];
  for (const s of data.sessions) {
    for (const t of s.turns) {
      if (t.who !== 'her' || !t.text) continue;
      // 最近说的话本来就会带上，不用重复捞
      if (Date.now() - t.at < 30 * 60 * 1000) continue;

      let hit = 0;
      for (const g of bigrams(t.text)) {
        if (mine.has(g)) hit++;
      }
      // 撞上两个以上才算相关，一个太容易误伤（"我想你"能匹配一切）
      if (hit >= 2) scored.push({ text: t.text, at: t.at, hit: hit });
    }
  }

  scored.sort((a, b) => b.hit - a.hit || b.at - a.at);
  return scored.slice(0, limit || 4);
}

/**
 * 她说了一句话之后的全部处理 —— 打字和语音共用这一条路。
 *
 * 抽出来是因为 /say 和 /voice 【必须】走同一套逻辑：
 * 语音转出来的文字要是绕过危机判断，那她对着手机说"我不想活了"
 * 就什么都不会发生，而打字却会。这种不一致是最要命的。
 */
function handleHerText(s, text, res) {
  // mood 要等判断回来才知道，先占位，判断完回填。
  // sent 是给 /pull 用的：她的每一句话都要原样传到他手机上，不重不漏。
  const herTurn = {
    who: 'her', text: text, at: Date.now(), crisis: false, mood: 'OK',
    relay: isRelay(text),   // 她明确要求转达 —— 这类话必须念给他听
    sent: false
  };
  s.turns.push(herTurn);
  s.herCount++;

  // ── 第一层：硬词表 ──
  const word = hitCrisis(text);
  if (word) {
    s.crisis = true;
    s.crisisWord = word;
    s.lastCrisisAt = Date.now();
    // ⚠️⚠️ 这段话必须落进 turns。
    // 她端的界面是拿 /thread 当唯一数据源的，只把 reply 返回给客户端
    // 而不落库的话，她说完「我不想活了」之后屏幕上【一片空白】——
    // 那比不说话还可怕。2026-09-16 实测踩到过，别再删。
    s.turns.push({
      who: 'him', text: config.crisisReply, at: Date.now(), crisis: true
    });
    saveData();
    log('CRISIS', 'session=' + s.id + ' word=' + word);
    // 不生成任何 AI 回复。给她的，是他提前手写好的原话。
    return send(res, 200, {
      ok: true, crisis: true, reply: config.crisisReply, replyFrom: 'him'
    });
  }

  // ── 轮次上限 ──
  //
  // 设成 0（或负数）就是不限制 —— 他 2026-09-17 定的：
  // 「不需要有任何 token 限制，想怎么聊就怎么聊，因为我们解耦过了」。
  // 之前默认 20 轮，她聊到一半被赶去"留给他亲口跟你讲"，体验很糟。
  const turnLimit = config.limits.maxHerTurnsPerSession || 0;
  if (turnLimit > 0 && s.herCount > turnLimit) {
    const msg = config.limitReply;
    s.turns.push({ who: 'mumu', text: msg, at: Date.now(), crisis: false });
    saveData();
    return send(res, 200, { ok: true, reply: msg, limitReached: true });
  }

  // ── 第二层：独立的一次情绪判断（CRISIS / LOW / OK）──
  //
  // ⚠️ 必须和下面的对话调用【分开】，用单独的 prompt。
  // 揉在一起的话，模型在"要温柔、要陪着"的语境下会过度警觉 ——
  // 实测她说了句「我哭了好久」，就因上文提过自伤被判成危机，
  // 而误报的代价是真的拨出一通电话。
  let prevHer = '';
  for (let i = s.turns.length - 2; i >= 0; i--) {
    if (s.turns[i].who === 'her') { prevHer = s.turns[i].text; break; }
  }

  // 这两件事【并行】跑：情绪判断（一次模型调用）+ 历史检索（本地粗筛 + 一次模型调用）。
  // 串起来要三秒多，并行之后总延迟 = 慢的那一个 + 对话那一次，约两秒半。
  let mood = undefined;
  let recalled = undefined;

  const build = () => {
    if (mood === undefined || recalled === undefined) return;

    if (mood === 'CRISIS') {
      s.crisis = true;
      s.crisisWord = s.crisisWord || 'model-flagged';
      s.lastCrisisAt = Date.now();
      s.turns.push({
        who: 'him', text: config.crisisReply, at: Date.now(), crisis: true
      });
      saveData();
      log('CRISIS', 'session=' + s.id + ' by=judge');
      return send(res, 200, {
        ok: true, crisis: true, reply: config.crisisReply, replyFrom: 'him'
      });
    }

    // ── 第三层：正常对话 ──
    // 这个 prompt 里【完全不含】危机相关的内容 —— 语气才不会被警报规则带硬
    //
    // 上下文分三块：
    //   ① 她是谁（herProfile）—— 以前没有，木木不知道她叫什么、喜欢什么
    //   ② 说话的方式（systemPrompt）
    //   ③ 聊过什么 —— 最近的一批（跨会话）+ 跟这次相关的几条
    //
    // ③ 以前只带当前会话的最近 13 条，所以她说"上次那个事"，
    //   木木会一脸茫然。那很伤 —— 她会觉得"连你都不记得我说过的话"。
    const sys = [];
    if (config.herProfile && config.herProfile.trim()) {
      sys.push('【关于' + (config.herName || '她') + ' —— 这些你已经知道，不用她再讲一遍】\n' + config.herProfile.trim());
    }
    if (config.systemPrompt) sys.push(config.systemPrompt);

    const messages = [{ role: 'system', content: sys.join('\n\n') }];

    // 最近聊过的：跨会话收，不只盯当前这一轮
    const recent = [];
    for (const ss of data.sessions) {
      for (const t of ss.turns) {
        if (t.text) recent.push(t);
      }
    }
    recent.sort((a, b) => a.at - b.at);
    // 去掉最后一条 —— 那是她这次刚说的，下面单独放。
    // 40 条是他 2026-09-17 定的：这个量够用，再早的事交给上面的 recallSmart 去捞。
    for (const t of recent.slice(-41, -1)) {
      messages.push({
        role: t.who === 'her' ? 'user' : 'assistant',
        content: t.text
      });
    }

    // 更早的、但跟这次相关的（由 recallSmart 并行填好）
    if (recalled.length) {
      const lines = recalled
        .map((r) => '· ' + new Date(r.at).toLocaleDateString('zh-CN') + '，她说过：' + r.text)
        .join('\n');
      messages.push({
        role: 'system',
        content: '【她以前聊过这些，跟这次有关。可以自然地接上，别生硬地复述】\n' + lines
      });
    }

    messages.push({ role: 'user', content: text });

    // 8000：她嫌木木话少，这时候不该再让额度卡着它。
    // 关掉思考之后这里基本就是纯正文额度。
    callWithRetry(messages, 8000, (e, raw) => {
      // 上面的 mood / recalled 由两个并行回调填，具体在函数末尾
      if (e) {
        log('deepseek_error', e.message);
        // 兜底这句也必须落库 —— 同一个坑踩过两次了
        s.turns.push({
          who: 'mumu', text: config.errorReply, at: Date.now(), crisis: false
        });
        saveData();
        return send(res, 200, { ok: true, reply: config.errorReply });
      }

      // 关掉思考之后不该再有空内容了；真出现也兜住，别让她对着空白等
      let out = String(raw || '').trim();
      if (!out) out = config.errorReply;

      // 模型可以分几条发（换行分隔）—— 拆成多个 turn，
      // 她端就显示成几个气泡，像真人连着发消息那样
      const parts = out.split(/\n+/).map((x) => x.trim()).filter(Boolean).slice(0, 4);
      if (parts.length === 0) parts.push(config.errorReply);

      for (const p of parts) {
        s.turns.push({ who: 'mumu', text: p, at: Date.now(), crisis: false });
      }
      saveData();
      log('say', 'session=' + s.id + ' n=' + s.herCount + ' parts=' + parts.length);
      send(res, 200, { ok: true, reply: parts.join('\n') });
    });
  };

  // 两件事同时发出去，谁先回来都行；两个都到了才组装上下文
  judgeMood(prevHer, text, (m) => {
    mood = m;
    herTurn.mood = m;
    build();
  });

  recallSmart(text, (rows) => {
    recalled = rows;
    build();
  });
}

/**
 * 语音转文字（阿里云百炼 qwen3-asr-flash）。
 *
 * 为什么放服务器而不是她端：key 打进 APK 就等于公开；
 * 而且那段音频本来就要过服务器才能到他手上，没必要传两遍。
 */
function callAsr(audioBase64, cb) {
  const payload = JSON.stringify({
    model: 'qwen3-asr-flash',
    input: {
      messages: [{
        role: 'user',
        content: [{ audio: 'data:audio/wav;base64,' + audioBase64 }]
      }]
    }
  });

  const req = https.request({
    hostname: 'dashscope.aliyuncs.com',
    path: '/api/v1/services/aigc/multimodal-generation/generation',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + ((config.dashscope && config.dashscope.key) || ''),
      'Content-Length': Buffer.byteLength(payload)
    }
  }, (res) => {
    let buf = '';
    res.on('data', (c) => { buf += c; });
    res.on('end', () => {
      if (res.statusCode !== 200) {
        return cb(new Error('ASR HTTP ' + res.statusCode + ': ' + buf.slice(0, 200)));
      }
      try {
        const j = JSON.parse(buf);
        const arr = j.output.choices[0].message.content;
        let text = '';
        for (const p of arr) text += (p.text || '');
        text = text.trim();
        if (!text) return cb(new Error('ASR 没返回文字'));
        cb(null, text);
      } catch (e) {
        cb(new Error('ASR 返回解析失败：' + e.message));
      }
    });
  });

  req.on('error', cb);
  req.setTimeout(30000, () => req.destroy(new Error('ASR 超时')));
  req.write(payload);
  req.end();
}

/**
 * 失败的调用重试一次。
 *
 * 他的要求是"不要出现回复不了的情况"。重试比任何话说得漂亮的兜底都实在。
 */
function callWithRetry(messages, maxTokens, cb, attempt) {
  const n = attempt || 1;
  callDeepSeek(messages, maxTokens, (e, raw) => {
    if (e && n < 2) {
      log('deepseek_retry', '第' + n + '次失败：' + e.message);
      return setTimeout(() => callWithRetry(messages, maxTokens, cb, n + 1), 400);
    }
    cb(e, raw);
  });
}

/**
 * 独立的危机判断。返回 true = 她这句话是【明确的、当下的】自伤/自杀意图。
 *
 * ⚠️ 为什么一定要单独一次调用、单独的 prompt：
 * 揉在对话 prompt 里的话，模型在那套"要温柔、要陪着"的语境下会过度警觉 ——
 * 实测她说了句「我哭了好久」，就因为有上文提过自伤，被判成了危机。
 * 而误报的代价是【真的拨出一通电话】。
 * 拆开之后，判断这件事只面对一个干净的问题：这句话本身是不是危险信号。
 *
 * 判断失败时按"不是危机"处理：硬词表还兜着一层，
 * 而且绝不能因为判断服务挂了就乱拨电话。
 */
function judgeMood(prevLine, text, cb) {
  const msgs = [{ role: 'system', content: config.moodJudgePrompt }];
  if (prevLine) msgs.push({ role: 'user', content: prevLine });
  msgs.push({ role: 'user', content: text });

  callDeepSeek(msgs, 8, (e, raw) => {
    if (e) {
      // 判断失败按 OK 处理：硬词表还兜着一层，
      // 绝不能因为判断服务挂了就乱拨电话
      log('judge_error', e.message);
      return cb('OK');
    }
    const s = String(raw || '').toUpperCase();
    if (s.indexOf('CRISIS') >= 0) return cb('CRISIS');
    if (s.indexOf('LOW') >= 0) return cb('LOW');
    cb('OK');
  });
}

// ── HTTP 工具 ───────────────────────────────────────────────
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function readBody(req, cb, maxBytes) {
  const limit = maxBytes || MAX_BODY;
  let buf = '';
  let tooBig = false;
  req.on('data', (c) => {
    if (tooBig) return;
    buf += c;
    if (buf.length > limit) {
      tooBig = true;
      buf = '';
      cb(new Error('请求体过大'));
    }
  });
  req.on('end', () => {
    if (tooBig) return;
    try {
      cb(null, buf ? JSON.parse(buf) : {});
    } catch (e) {
      cb(new Error('不是合法 JSON'));
    }
  });
  req.on('error', cb);
}

function findSession(id) {
  for (let i = data.sessions.length - 1; i >= 0; i--) {
    if (data.sessions[i].id === id) return data.sessions[i];
  }
  return null;
}

// 会话里给他看的内容：她说的每一句 + 危机事件
function herTurns(s) {
  return s.turns.filter((t) => t.who === 'her');
}

// ════════════════════════════════════════════════════════════
//  接口
// ════════════════════════════════════════════════════════════
const server = http.createServer((req, res) => {
  const ip = (req.headers['x-real-ip'] || req.socket.remoteAddress || '?');

  let u;
  try {
    u = new URL(req.url, 'http://localhost');
  } catch (_) {
    return send(res, 400, { ok: false, error: 'bad url' });
  }
  const p = u.pathname;

  // nginx 反代时 proxy_pass 带尾斜杠，这里两种前缀都认
  const route = p.replace(/^\/mumu\/api/, '').replace(/^\/api/, '');

  if (rateLimited(ip)) {
    return send(res, 429, { ok: false, error: '慢一点' });
  }

  // ── 健康检查（不需要令牌，nginx 探活用）
  if (req.method === 'GET' && (route === '/health' || p === '/health')) {
    return send(res, 200, { ok: true, sessions: data.sessions.length });
  }

  // ── 她按下按钮 ──────────────────────────────────────────
  if (req.method === 'POST' && route === '/ping') {
    return readBody(req, (err, body) => {
      if (err) return send(res, 400, { ok: false, error: err.message });
      if (whoIs(req, body) !== 'her') return send(res, 403, { ok: false, error: 'forbidden' });

      data.seq++;
      const s = {
        id: data.seq,
        startedAt: Date.now(),
        turns: [],
        crisis: false,
        crisisWord: null,
        herCount: 0,
        notified: false
      };
      // 木木的第一句话也是固定的，不让模型自由发挥——
      // 她按下按钮的那一刻，需要的是确定性，不是创意
      s.turns.push({ who: 'mumu', text: config.greeting, at: Date.now(), crisis: false });
      data.sessions.push(s);
      prune();
      saveData();

      log('ping', 'session=' + s.id);
      send(res, 200, { ok: true, sessionId: s.id, greeting: config.greeting });
    });
  }

  // ── 她说了一句 ──────────────────────────────────────────
  if (req.method === 'POST' && route === '/say') {
    return readBody(req, (err, body) => {
      if (err) return send(res, 400, { ok: false, error: err.message });
      if (whoIs(req, body) !== 'her') return send(res, 403, { ok: false, error: 'forbidden' });

      const s = findSession(body.sessionId);
      if (!s) return send(res, 404, { ok: false, error: 'session 不存在' });

      const text = String(body.text || '').slice(0, 1000).trim();
      if (!text) return send(res, 400, { ok: false, error: '空消息' });

      handleHerText(s, text, res);
    });
  }

  // ── 她按住说话 ──────────────────────────────────────────
  //
  // 音频 → 百炼 ASR → 文字 → 跟打字走【完全相同】的一条路。
  //
  // 合成一个接口是有意的：少一次往返；更要紧的是她说的每一个字
  // 走的都是同一套危机判断、同一套回复逻辑 ——
  // 不会出现"打字会被判成危机、说话不会"这种荒唐事。
  if (req.method === 'POST' && route === '/voice') {
    return readBody(req, (err, body) => {
      if (err) return send(res, 400, { ok: false, error: err.message });
      if (whoIs(req, body) !== 'her') return send(res, 403, { ok: false, error: 'forbidden' });

      const s = findSession(body.sessionId);
      if (!s) return send(res, 404, { ok: false, error: 'session 不存在' });

      const audio = String(body.audio || '');
      if (!audio) return send(res, 400, { ok: false, error: '没收到录音' });

      callAsr(audio, (e, text) => {
        if (e) {
          log('asr_error', e.message);
          // 听不清就说听不清，别拿一句编的话糊弄她
          return send(res, 200, { ok: false, error: '没听清，再说一次好不好' });
        }
        log('voice', 'session=' + s.id + ' chars=' + text.length);
        handleHerText(s, text, res);
      });
    }, 12 * 1024 * 1024);
  }

  // ── 她拉取他的回复 ────────────────────────────────────
  if (req.method === 'GET' && route === '/thread') {
    const body = { token: u.searchParams.get('token') };
    if (whoIs(req, body) !== 'her') return send(res, 403, { ok: false, error: 'forbidden' });

    const s = findSession(Number(u.searchParams.get('sessionId')));
    if (!s) return send(res, 404, { ok: false, error: 'session 不存在' });

    const since = Number(u.searchParams.get('since') || 0);
    const turns = s.turns
      .map((t, i) => ({ i: i, who: t.who, text: t.text, at: t.at, crisis: t.crisis }))
      .filter((t) => t.i >= since);

    return send(res, 200, { ok: true, turns: turns, next: s.turns.length });
  }

  // ── 他回复她 ──────────────────────────────────────────
  if (req.method === 'POST' && route === '/reply') {
    return readBody(req, (err, body) => {
      if (err) return send(res, 400, { ok: false, error: err.message });
      if (whoIs(req, body) !== 'him') return send(res, 403, { ok: false, error: 'forbidden' });

      const s = findSession(body.sessionId);
      if (!s) return send(res, 404, { ok: false, error: 'session 不存在' });

      const text = String(body.text || '').slice(0, 2000).trim();
      if (!text) return send(res, 400, { ok: false, error: '空消息' });

      s.turns.push({ who: 'him', text: text, at: Date.now(), crisis: false });
      saveData();
      log('reply', 'session=' + s.id);
      send(res, 200, { ok: true });
    });
  }

  // ── 她按「小小的打扰一下」────────────────────────────────
  //
  // 跟「想你啦」不是一回事：
  //   想你啦 = 我现在不好，需要你
  //   打扰一下 = 我没那么严重，就是想你了 —— 中间那个档位
  // 所以它【不拨电话】，只让他手机震一下、听到一句提醒。
  if (req.method === 'POST' && route === '/knock') {
    return readBody(req, (err, body) => {
      if (err) return send(res, 400, { ok: false, error: err.message });
      if (whoIs(req, body) !== 'her') return send(res, 403, { ok: false, error: 'forbidden' });

      data.knocks.push({ at: Date.now(), sent: false });
      saveData();
      log('knock');
      send(res, 200, { ok: true });
    });
  }

  // ── 他发东西给她（她打开 App 就能看到）─────────────────
  if (req.method === 'POST' && route === '/fromhim') {
    // 图片走 base64，得放宽请求体上限
    return readBody(req, (err, body) => {
      if (err) return send(res, 400, { ok: false, error: err.message });
      if (whoIs(req, body) !== 'him') return send(res, 403, { ok: false, error: 'forbidden' });

      const text = String(body.text || '').slice(0, 3000).trim();
      const image = String(body.image || '');   // data:image/...;base64,...
      const audio = String(body.audio || '');   // base64 WAV（不带 data url 前缀）
      if (!text && !image && !audio) return send(res, 400, { ok: false, error: '空的' });
      if (image.length > 6 * 1024 * 1024) {
        return send(res, 413, { ok: false, error: '图片太大了' });
      }
      // 16kHz 单声道 WAV ≈ 32KB/秒，base64 之后 ×1.33。
      // 卡 8MB 大约是 60 秒出头，够说一段话了。
      if (audio.length > 8 * 1024 * 1024) {
        return send(res, 413, { ok: false, error: '语音太长了，说短一点' });
      }

      data.seq++;
      const item = {
        id: data.seq, text: text, image: image, audio: audio, at: Date.now()
      };
      data.fromHim.push(item);
      if (data.fromHim.length > 50) data.fromHim = data.fromHim.slice(-50);  // 只留最近 50 条
      saveData();
      log('fromhim', 'id=' + item.id
        + ' img=' + (image ? 'y' : 'n')
        + ' audio=' + (audio ? 'y' : 'n'));
      send(res, 200, { ok: true, id: item.id });
    }, 16 * 1024 * 1024);
  }

  // ── 她在聊天里说一句 ─────────────────────────────────────
  //
  // 跟 /say 不是一回事：/say 是她跟【木木】说，这条是她跟【他】说。
  // 两条线各走各的，不要混在一起。
  if (req.method === 'POST' && route === '/fromher') {
    return readBody(req, (err, body) => {
      if (err) return send(res, 400, { ok: false, error: err.message });
      if (whoIs(req, body) !== 'her') return send(res, 403, { ok: false, error: 'forbidden' });

      const text = String(body.text || '').slice(0, 3000).trim();
      const audio = String(body.audio || '');
      if (!text && !audio) return send(res, 400, { ok: false, error: '空的' });
      if (audio.length > 8 * 1024 * 1024) {
        return send(res, 413, { ok: false, error: '语音太长了，说短一点' });
      }

      if (!Array.isArray(data.fromHer)) data.fromHer = [];
      data.seq++;
      const item = { id: data.seq, text: text, audio: audio, at: Date.now(), sent: false };
      data.fromHer.push(item);
      if (data.fromHer.length > 200) data.fromHer = data.fromHer.slice(-200);
      saveData();
      log('fromher', 'id=' + item.id + ' audio=' + (audio ? 'y' : 'n'));
      send(res, 200, { ok: true, id: item.id });
    }, 16 * 1024 * 1024);
  }

  // ── 她拉整条聊天记录（他发的 + 她发的，按时间合起来）────────
  if (req.method === 'GET' && route === '/chat') {
    const t = u.searchParams.get('token') || '';
    if (!tokenOk(t, config.tokens.her) && !tokenOk(t, config.tokens.him)) {
      return send(res, 403, { ok: false, error: 'forbidden' });
    }

    const merged = [];
    for (const x of (data.fromHim || [])) {
      merged.push({ id: x.id, who: 'him', text: x.text || '', hasImage: !!x.image,
        hasAudio: !!x.audio, at: x.at });
    }
    for (const x of (data.fromHer || [])) {
      merged.push({ id: x.id, who: 'her', text: x.text || '', hasImage: false,
        hasAudio: !!x.audio, at: x.at });
    }
    merged.sort((a, b) => a.at - b.at);

    // 只回最近 100 条 —— 聊天记录翻太久没意义，还费流量
    return send(res, 200, { ok: true, items: merged.slice(-100) });
  }

  // ── 她按了「不吵啦」──────────────────────────────────────
  //
  // 这是最彻底的一档：通知【全关】，连危机都不推给他。
  //
  // 他 2026-09-18 拍的板。理由：她按这个按钮大概率不是"我不想要你了"，
  // 是"我想静一静"。静一静的时候被通知打扰是最烦的。
  //
  // ⚠️ 但有一条线留着：她还能按「想你啦」、还能在聊天里给他发消息 ——
  // 那些是【她主动来找他】，不是"通知"。这个区别是这个功能成立的前提。
  if (req.method === 'POST' && route === '/quiet') {
    return readBody(req, (err, body) => {
      if (err) return send(res, 400, { ok: false, error: err.message });
      if (whoIs(req, body) !== 'her') return send(res, 403, { ok: false, error: 'forbidden' });

      data.quiet = !!body.quiet;
      saveData();
      log('quiet', data.quiet ? '她按了不吵啦' : '她又回来了');
      send(res, 200, { ok: true, quiet: data.quiet });
    });
  }

  if (req.method === 'GET' && route === '/quiet') {
    const t = u.searchParams.get('token') || '';
    if (!tokenOk(t, config.tokens.her) && !tokenOk(t, config.tokens.him)) {
      return send(res, 403, { ok: false, error: 'forbidden' });
    }
    return send(res, 200, { ok: true, quiet: !!data.quiet });
  }

  // ── 她的头像 ─────────────────────────────────────────────
  //
  // 她自己挑一张图当头像，两端都能看到。
  // 他 2026-09-18 提的：「她可以在抽屉里自己换头像」。
  //
  // 存成【单独的文件】而不是塞进 data.json ——
  // data.json 每 saveData 一次就要整个序列化一遍，
  // 往里塞几十 KB 的 base64，等于给之后每一个请求都加负担。
  //
  // 没设过就回空串，她端用内置的那张图顶上，这不算错。
  if (req.method === 'GET' && route === '/avatar') {
    const t = u.searchParams.get('token') || '';
    if (!tokenOk(t, config.tokens.her) && !tokenOk(t, config.tokens.him)) {
      return send(res, 403, { ok: false, error: 'forbidden' });
    }
    let image = '';
    try {
      const buf = fs.readFileSync(AVATAR_FILE);
      if (buf.length) image = 'data:image/jpeg;base64,' + buf.toString('base64');
    } catch (e) { /* 还没设过，当没有 */ }
    return send(res, 200, { ok: true, image: image });
  }

  if (req.method === 'POST' && route === '/avatar') {
    return readBody(req, (err, body) => {
      if (err) return send(res, 400, { ok: false, error: err.message });
      // 只有她能换自己的头像
      if (whoIs(req, body) !== 'her') return send(res, 403, { ok: false, error: 'forbidden' });

      const raw = String(body.image || '');
      if (!raw) return send(res, 400, { ok: false, error: '没收到图' });

      // 只认 JPEG 的 data url。她端传上来之前会压成 512×512 的 JPEG，
      // 所以这里收窄到 jpeg 一种 —— 认的范围越宽，要防的怪东西越多。
      const m = /^data:image\/jpe?g;base64,([A-Za-z0-9+/=]+)$/.exec(raw);
      if (!m) return send(res, 400, { ok: false, error: '这个格式我认不出来' });

      const buf = Buffer.from(m[1], 'base64');
      if (!buf.length) return send(res, 400, { ok: false, error: '图是空的' });
      if (buf.length > 1024 * 1024) {
        return send(res, 413, { ok: false, error: '头像太大了，换张小点的' });
      }

      // 原子写：先写 .tmp 再 rename，中途断电也不会剩半张图
      try {
        fs.writeFileSync(AVATAR_FILE + '.tmp', buf);
        fs.renameSync(AVATAR_FILE + '.tmp', AVATAR_FILE);
      } catch (e) {
        log('avatar_error', e.message);
        return send(res, 500, { ok: false, error: '没存下来，再试一次' });
      }
      log('avatar', buf.length + 'B');
      send(res, 200, { ok: true });
    }, 4 * 1024 * 1024);
  }

  // ── 取一条语音的音频数据 ─────────────────────────────────
  //
  // ⚠️ /chat 只回「有没有语音」，不回音频本身 ——
  // 一条语音 100KB 起步，聊天记录每几秒拉一次，
  // 每次都把音频塞进去她手机流量扛不住。
  // 所以点它的时候再来拿这一段。
  //
  // kind: her = 她发的，him = 他发的
  if (req.method === 'GET' && route === '/audio') {
    const t = u.searchParams.get('token') || '';
    if (!tokenOk(t, config.tokens.her) && !tokenOk(t, config.tokens.him)) {
      return send(res, 403, { ok: false, error: 'forbidden' });
    }

    const kind = u.searchParams.get('kind');
    const id = Number(u.searchParams.get('id') || 0);
    const list = kind === 'her' ? (data.fromHer || []) : (data.fromHim || []);
    const item = list.find((x) => x.id === id);
    if (!item || !item.audio) {
      return send(res, 404, { ok: false, error: '这段语音没了' });
    }

    return send(res, 200, { ok: true, audio: item.audio });
  }

  // ── 取一条消息里的图 ───────────────────────────────────
  //
  // 跟 /audio 一个道理：聊天记录接口只回「有没有图」，图本身点开才拿。
  // 一张图几百 KB，每 5 秒拉一次记录都塞进去太费流量，她也未必看。
  //
  // kind: her = 她发的，him = 他发的
  if (req.method === 'GET' && route === '/image') {
    const t = u.searchParams.get('token') || '';
    if (!tokenOk(t, config.tokens.her) && !tokenOk(t, config.tokens.him)) {
      return send(res, 403, { ok: false, error: 'forbidden' });
    }

    const kind = u.searchParams.get('kind');
    const id = Number(u.searchParams.get('id') || 0);
    const list = kind === 'her' ? (data.fromHer || []) : (data.fromHim || []);
    const item = list.find((x) => x.id === id);
    if (!item || !item.image) {
      return send(res, 404, { ok: false, error: '这张图没了' });
    }

    return send(res, 200, { ok: true, image: item.image });
  }

  // ── 图库：按心情随机拿一张 ───────────────────────────────
  //
  // 她心情不好的时候，他端从这儿取一张图发给她。
  // 图是他自己挑的，放在 /opt/mumu/gallery/<分类>/ 下面。
  //
  // ⚠️ mood 绝不能直接拼进路径 —— 一个 `../../` 就能读到服务器上任何文件。
  //    所以走白名单：不在 GALLERY_KINDS 里的，一律拒掉。
  if (req.method === 'GET' && route === '/gallery/random') {
    const t = u.searchParams.get('token') || '';
    if (!tokenOk(t, config.tokens.her) && !tokenOk(t, config.tokens.him)) {
      return send(res, 403, { ok: false, error: 'forbidden' });
    }

    const raw = (u.searchParams.get('mood') || '').trim();
    const kind = GALLERY_ALIAS[raw] || raw;
    if (GALLERY_KINDS.indexOf(kind) < 0) {
      return send(res, 400, { ok: false, error: '没有这个分类' });
    }

    const dir = path.join(GALLERY_DIR, kind);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png|webp|gif)$/i.test(f));
    } catch (e) {
      return send(res, 404, { ok: false, error: '这个分类还空着' });
    }
    if (!files.length) return send(res, 404, { ok: false, error: '这个分类还空着' });

    const pick = files[Math.floor(Math.random() * files.length)];
    let buf;
    try {
      buf = fs.readFileSync(path.join(dir, pick));
    } catch (e) {
      return send(res, 500, { ok: false, error: '这张图读不出来' });
    }
    // 上限跟 /fromhim 那边对齐（它卡 6MB 的 base64）。
    // 超了在这儿就拦下来，别等发到她那边才失败。
    if (buf.length > 4 * 1024 * 1024) {
      log('gallery_too_big', kind + '/' + pick);
      return send(res, 413, { ok: false, error: '这张图压一压再放进来（超过 4MB）' });
    }

    const mime = /\.png$/i.test(pick) ? 'image/png'
      : /\.webp$/i.test(pick) ? 'image/webp'
        : /\.gif$/i.test(pick) ? 'image/gif' : 'image/jpeg';

    log('gallery_pick', kind + '/' + pick);
    return send(res, 200, {
      ok: true,
      kind: kind,
      name: pick,
      total: files.length,
      image: 'data:' + mime + ';base64,' + buf.toString('base64')
    });
  }

  // ── 一起听：歌单 / 下载 / 上传 ───────────────────────────
  //
  // 歌放 /opt/mumu/music/ 下面。她端拉下来听，也能自己传上去。
  //
  // 注意：这里的「她在放歌」和「她自己写的状态」是【两码事】——
  // 前者是自动上报的（给他端判断要不要问「想听歌吗」），
  // 后者是她自己写的字。他 2026-09-18 特意交代过别把两者搅在一起。
  if (req.method === 'GET' && route === '/music/list') {
    const t = u.searchParams.get('token') || '';
    if (!tokenOk(t, config.tokens.her) && !tokenOk(t, config.tokens.him)) {
      return send(res, 403, { ok: false, error: 'forbidden' });
    }

    let names = [];
    try {
      names = fs.readdirSync(MUSIC_DIR).filter((f) => MUSIC_EXT.test(f));
    } catch (e) { /* 目录不存在就当空歌单，不是错 */ }

    const items = names.map((n) => {
      let size = 0, at = 0;
      try {
        const st = fs.statSync(path.join(MUSIC_DIR, n));
        size = st.size;
        at = Math.round(st.mtimeMs);
      } catch (e) { /* 单个文件读不到，空着就行 */ }
      return { name: n, size: size, at: at };
    }).sort((a, b) => a.name.localeCompare(b.name, 'zh'));

    return send(res, 200, { ok: true, items: items });
  }

  if (req.method === 'GET' && route === '/music/get') {
    const t = u.searchParams.get('token') || '';
    if (!tokenOk(t, config.tokens.her) && !tokenOk(t, config.tokens.him)) {
      return send(res, 403, { ok: false, error: 'forbidden' });
    }

    const name = musicSafeName(u.searchParams.get('name'));
    if (!name) return send(res, 400, { ok: false, error: '这个名字不对' });

    let buf;
    try {
      buf = fs.readFileSync(path.join(MUSIC_DIR, name));
    } catch (e) {
      return send(res, 404, { ok: false, error: '这首歌没了' });
    }
    if (buf.length > 20 * 1024 * 1024) {
      return send(res, 413, { ok: false, error: '这首歌太大了' });
    }

    return send(res, 200, { ok: true, name: name, audio: buf.toString('base64') });
  }

  if (req.method === 'POST' && route === '/music/upload') {
    return readBody(req, (err, body) => {
      if (err) return send(res, 400, { ok: false, error: err.message });
      if (whoIs(req, body) !== 'her') return send(res, 403, { ok: false, error: 'forbidden' });

      const name = musicSafeName(body.name);
      if (!name) {
        return send(res, 400, { ok: false, error: '只收 mp3、m4a 这些格式，名字里别带斜杠' });
      }

      let buf;
      try {
        buf = Buffer.from(String(body.audio || ''), 'base64');
      } catch (e) {
        return send(res, 400, { ok: false, error: '这首歌我读不出来' });
      }
      if (!buf.length) return send(res, 400, { ok: false, error: '歌是空的' });
      if (buf.length > 15 * 1024 * 1024) {
        return send(res, 413, { ok: false, error: '这首歌超过 15MB 了，换小一点的' });
      }

      const full = path.join(MUSIC_DIR, name);
      // 同名的别覆盖 —— 她那头可能正听着这一首
      if (fs.existsSync(full)) {
        return send(res, 200, { ok: false, error: '已经有一首叫这个名字的了' });
      }

      try {
        fs.mkdirSync(MUSIC_DIR, { recursive: true });
        fs.writeFileSync(full + '.tmp', buf);
        fs.renameSync(full + '.tmp', full);
      } catch (e) {
        log('music_upload_error', e.message);
        return send(res, 500, { ok: false, error: '没存下来，再试一次' });
      }

      log('music_upload', name + ' ' + buf.length + 'B');
      send(res, 200, { ok: true, name: name });
    }, 24 * 1024 * 1024);
  }

  // ── 她摇他一下：让他的手机持续震动一分钟 ─────────────────
  //
  // ⚠️ 有限制。狂按的后果不是"他快点回"，是"他关机"。
  // 十分钟只能摇一次。
  if (req.method === 'POST' && route === '/shake') {
    return readBody(req, (err, body) => {
      if (err) return send(res, 400, { ok: false, error: err.message });
      if (whoIs(req, body) !== 'her') return send(res, 403, { ok: false, error: 'forbidden' });

      const last = data.lastShakeAt || 0;
      const wait = 10 * 60 * 1000 - (Date.now() - last);
      if (wait > 0) {
        return send(res, 200, {
          ok: false,
          error: '刚摇过了，等' + Math.ceil(wait / 60000) + '分钟再摇好不好'
        });
      }

      data.lastShakeAt = Date.now();
      data.shake = { at: Date.now(), sent: false };
      saveData();
      log('shake');
      send(res, 200, { ok: true });
    });
  }

  // ── 她手机上的常驻服务定时来拉这个 ─────────────────────
  //
  // 返回两样：
  //   ① 他新发的东西（她那边弹通知用）
  //   ② 木木要主动说的话（有就弹，没有就 null）
  //
  // 只给元信息不给正文 —— 正文她点通知进 App 自己拉，
  // 免得每 15 秒把图片和语音的 base64 重新传一遍。
  if (req.method === 'GET' && route === '/herpoll') {
    const t = u.searchParams.get('token') || '';
    if (!tokenOk(t, config.tokens.her)) return send(res, 403, { ok: false, error: 'forbidden' });

    // 她按了「不吵啦」—— 一条通知都不弹。
    // 但消息还在服务器上，她打开 App 照样看得到
    //（那是她主动来看的，跟"被通知吵醒"是两回事）。
    if (data.quiet) {
      return send(res, 200, {
        ok: true,
        now: Date.now(),
        messages: [],
        proactive: null
      });
    }

    const since = Number(u.searchParams.get('since') || 0);
    const fresh = (data.fromHim || []).filter((x) => x.at > since);

    // 主动开口：话是提前生成好存着的（见 prepareProactive），
    // 这里只是把它取走 —— 取走就作废，不会重复弹
    let proactive = null;
    if (data.proactiveText && data.proactiveAt) {
      proactive = { text: data.proactiveText };
      data.proactiveText = '';
      data.proactiveAt = 0;
      saveData();
    }

    return send(res, 200, {
      ok: true,
      now: Date.now(),
      messages: fresh.map((x) => ({
        id: x.id,
        text: x.text || '',
        hasImage: !!x.image,
        hasAudio: !!x.audio
      })),
      proactive: proactive
    });
  }

  // ── 她的通知开关 ────────────────────────────────────────
  //
  // 关掉之后：只有【危机】才推给他。
  // 她说的话、按的按钮、打扰一下 —— 一律不推。
  //
  // 这是留给她的选择权。被一直看着的感觉，比漏几条消息更让人难受。
  // 但危机那一档永远留着：那是要命的，不是"通知"。
  if (req.method === 'POST' && route === '/notify') {
    return readBody(req, (err, body) => {
      if (err) return send(res, 400, { ok: false, error: err.message });
      if (whoIs(req, body) !== 'her') return send(res, 403, { ok: false, error: 'forbidden' });

      data.notifyLevel = body.crisisOnly ? 'crisis' : 'all';
      saveData();
      log('notify', data.notifyLevel);
      send(res, 200, { ok: true, level: data.notifyLevel });
    });
  }

  if (req.method === 'GET' && route === '/notify') {
    const body = { token: u.searchParams.get('token') };
    if (!whoIs(req, body)) return send(res, 403, { ok: false, error: 'forbidden' });
    return send(res, 200, { ok: true, crisisOnly: data.notifyLevel === 'crisis' });
  }

  // ── 日历 ────────────────────────────────────────────────
  //
  // 两样东西合在一起：
  //   ① 固定的重要日子（config.specialDays）—— 倒计时，每年自动重算
  //   ② 她/他自己加的日程（data.calendar）—— 一次性的，能加能删
  if (req.method === 'GET' && route === '/calendar') {
    const t = u.searchParams.get('token') || '';
    if (!tokenOk(t, config.tokens.her) && !tokenOk(t, config.tokens.him)) {
      return send(res, 403, { ok: false, error: 'forbidden' });
    }
    return send(res, 200, {
      ok: true,
      today: fmtDate(new Date()),
      days: upcomingDays(),
      mine: data.calendar || []
    });
  }

  if (req.method === 'POST' && route === '/calendar') {
    return readBody(req, (err, body) => {
      if (err) return send(res, 400, { ok: false, error: err.message });
      const who = whoIs(req, body);
      if (!who) return send(res, 403, { ok: false, error: 'forbidden' });

      const date = String(body.date || '').slice(0, 10);
      const title = String(body.title || '').slice(0, 40).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return send(res, 400, { ok: false, error: '日期不对' });
      }
      if (!title) return send(res, 400, { ok: false, error: '写点什么呢' });

      if (!Array.isArray(data.calendar)) data.calendar = [];
      data.seq++;
      const item = { id: data.seq, date: date, title: title, by: who, at: Date.now() };
      data.calendar.push(item);
      saveData();
      log('calendar_add', 'by=' + who + ' ' + date + ' ' + title);
      send(res, 200, { ok: true, id: item.id });
    });
  }

  if (req.method === 'POST' && route === '/calendar/delete') {
    return readBody(req, (err, body) => {
      if (err) return send(res, 400, { ok: false, error: err.message });
      if (!whoIs(req, body)) return send(res, 403, { ok: false, error: 'forbidden' });

      const id = Number(body.id || 0);
      data.calendar = (data.calendar || []).filter((x) => x.id !== id);
      saveData();
      log('calendar_del', 'id=' + id);
      send(res, 200, { ok: true });
    });
  }

  // ── 他设置「哥哥的状态」──────────────────────────────
  //
  // 她在主页一眼能看到。这是他主动交代自己在干嘛 ——
  // 对她来说，知道"他现在在教室/在打游戏/睡了"比什么都实在。
  if (req.method === 'POST' && route === '/status') {
    return readBody(req, (err, body) => {
      if (err) return send(res, 400, { ok: false, error: err.message });
      if (whoIs(req, body) !== 'him') return send(res, 403, { ok: false, error: 'forbidden' });

      data.status = String(body.text || '').slice(0, 60).trim();
      data.statusAt = Date.now();
      saveData();
      log('status', JSON.stringify(data.status));
      send(res, 200, { ok: true });
    });
  }

  // ── 读「哥哥的状态」────────────────────────────────────
  // 她读是为了在主页看到；他读是为了在设置界面看到自己上次填的啥
  if (req.method === 'GET' && route === '/status') {
    const t = u.searchParams.get('token') || '';
    if (!tokenOk(t, config.tokens.her) && !tokenOk(t, config.tokens.him)) {
      return send(res, 403, { ok: false, error: 'forbidden' });
    }
    return send(res, 200, { ok: true, text: data.status, at: data.statusAt });
  }

  // ── 她在放什么歌（她端自动上报）─────────────────────────
  //
  // ⚠️ 这跟上面那个 status 是【两码事】，他 2026-09-18 特意交代过：
  //      status  = 她自己写的字，内容随她
  //      playing = 她端自动上报的，给他端判断"要不要问一句想不想听歌"
  //    两者互不相干，【不要】拿一个去推另一个。
  //
  // 上报时机是"状态变化"（开始放 / 暂停 / 换歌 / 停），不是每秒一次 ——
  // 每秒上报等于把服务器当心跳使，没必要。
  //
  // 他端是【主动查】这个接口，不走 /pull：
  // 这是"状态"不是"事件"，不该让他手机念一句"她在听歌"。
  if (req.method === 'POST' && route === '/playing') {
    return readBody(req, (err, body) => {
      if (err) return send(res, 400, { ok: false, error: err.message });
      if (whoIs(req, body) !== 'her') return send(res, 403, { ok: false, error: 'forbidden' });

      data.playing = {
        name: String(body.name || '').slice(0, 120),
        on: !!body.on,
        at: Date.now()
      };
      saveData();
      send(res, 200, { ok: true });
    });
  }

  if (req.method === 'GET' && route === '/playing') {
    const t = u.searchParams.get('token') || '';
    if (!tokenOk(t, config.tokens.her) && !tokenOk(t, config.tokens.him)) {
      return send(res, 403, { ok: false, error: 'forbidden' });
    }
    const p = data.playing || {};
    return send(res, 200, { ok: true, name: p.name || '', on: !!p.on, at: p.at || 0 });
  }

  // ── 他说「我看到了」──────────────────────────────────
  //
  // 他端那边通知被划掉或者点开的时候调这个。
  // 她那边会从「消息传过来啦，等哥哥看」变成「哥哥看到啦」——
  // 中间那几秒她其实一直在盯着屏幕等，这个回执是给她等的。
  if (req.method === 'POST' && route === '/read') {
    return readBody(req, (err, body) => {
      if (err) return send(res, 400, { ok: false, error: err.message });
      if (whoIs(req, body) !== 'him') return send(res, 403, { ok: false, error: 'forbidden' });

      let marked = 0;
      for (const s of data.sessions) {
        for (const t of s.turns) {
          // 只标记"已经推给他、但还没说看过"的那些
          if (t.who === 'her' && t.delivered && !t.read) {
            t.read = true;
            marked++;
          }
        }
      }
      // 她被"送达"这件事也要认：按钮和打扰一下同样是她伸出来的手
      for (const k of data.knocks) {
        if (k.delivered && !k.read) { k.read = true; marked++; }
      }
      for (const s of data.sessions) {
        if (s.startedAt && s.deliveredAt && !s.readAt) {
          s.readAt = Date.now();
          marked++;
        }
      }

      if (marked) saveData();
      log('read', 'marked=' + marked);
      send(res, 200, { ok: true, marked: marked });
    });
  }

  // ── 她查自己那些消息走到哪一步了 ─────────────────────────
  //
  // 返回一个总的进度，她端主页显示一句话就够了：
  //   sent      —— 送到了服务器
  //   delivered —— 已经推到他手机上了
  //   read      —— 他看过了
  if (req.method === 'GET' && route === '/mystate') {
    const body = { token: u.searchParams.get('token') };
    if (whoIs(req, body) !== 'her') return send(res, 403, { ok: false, error: 'forbidden' });

    const sid = Number(u.searchParams.get('sessionId') || 0);
    const mine = data.sessions.filter((x) => (sid ? x.id === sid : true));
    let latest = null;
    let state = 'none';

    // ⚠️ 会话本身也要算 —— 她「按按钮」创建的那个会话里
    //    只有木木的问候，一条"她说的 turn"都没有。
    //    只遍历 turn 的话，按按钮那条永远是 sent（实测栽过）。
    for (const s of mine) {
      if (latest === null || s.startedAt > latest) {
        latest = s.startedAt;
        state = s.readAt ? 'read' : (s.deliveredAt ? 'delivered' : 'sent');
      }
    }

    for (const s of mine) {
      for (const t of s.turns) {
        if (t.who !== 'her') continue;
        if (latest === null || t.at > latest) {
          latest = t.at;
          state = t.read ? 'read' : (t.delivered ? 'delivered' : 'sent');
        }
      }
    }
    for (const k of data.knocks) {
      if (latest === null || k.at > latest) {
        latest = k.at;
        state = k.read ? 'read' : (k.delivered ? 'delivered' : 'sent');
      }
    }

    return send(res, 200, { ok: true, state: state, at: latest || 0, status: data.status });
  }

  // ── 他看她最近的情况（只读，不动 sent 标记）───────────
  //
  // 专门给他端那个窗口用的。跟 /pull 的区别是它【不消费】未读事件 ——
  // 用 /pull 去翻历史的话，那些事件会被标记成已推送，正常轮询就再也收不到了。
  if (req.method === 'GET' && route === '/log') {
    const body = { token: u.searchParams.get('token') };
    if (whoIs(req, body) !== 'him') return send(res, 403, { ok: false, error: 'forbidden' });

    return send(res, 200, {
      ok: true,
      sessions: data.sessions.slice(-6).map((s) => ({
        id: s.id,
        startedAt: s.startedAt,
        crisis: !!s.crisis,
        crisisWord: s.crisisWord || null,
        turns: s.turns.map((t) => ({
          who: t.who,
          text: t.text,
          at: t.at,
          mood: t.mood || null
        }))
      })),
      knocks: data.knocks.slice(-20).map((k) => ({ at: k.at }))
    });
  }

  // ── 她拉他留给她的东西 ─────────────────────────────────
  if (req.method === 'GET' && route === '/inbox') {
    const body = { token: u.searchParams.get('token') };
    if (whoIs(req, body) !== 'her') return send(res, 403, { ok: false, error: 'forbidden' });
    return send(res, 200, { ok: true, items: data.fromHim });
  }

  // ── 他拉取（他的手机轮询这个）─────────────────────────
  if (req.method === 'GET' && route === '/pull') {
    const body = { token: u.searchParams.get('token') };
    if (whoIs(req, body) !== 'him') return send(res, 403, { ok: false, error: 'forbidden' });

    const since = Number(u.searchParams.get('since') || 0);
    const events = [];

    // 她把通知关了？那除了危机，什么都不推给他。
    // 这是她的选择权 —— 被一直盯着看的感觉，比漏消息更让人难受。
    const crisisOnly = data.notifyLevel === 'crisis';

    // 「不吵啦」＝ 她按了「我不想用这个了」。
    //
    // ⚠️ 2026-09-18 他拍的板，改过一次，别改回去：
    //   她按这个按钮是在说"我不想用了"，但【她主动来找他的那一刻，必须到得了】。
    //   原来这里是一刀切的短路（什么都不推、连危机都不推），后果是
    //   她按完出口之后再按「想你啦」，他手机一点动静都没有 ——
    //   她只会以为"他真的不要我了"，恰恰是这个按钮设计出来要避免的那种伤。
    //
    // 现在它是跟 crisisOnly 平行的一个开关：
    //   她主动发起的（想你啦 / 打扰一下 / 她跟木木说的话 / 她在聊天里对他说的 /
    //   摇一摇 / 危机）全部照推，只停「木木主动开口」——
    //   那个在 prepareProactive() 里已经拦住了，这里不用重复管。
    const quiet = !!data.quiet;

    for (const s of data.sessions) {
      // 新会话（她按了按钮）
      if (s.startedAt > since) {
        if (!crisisOnly || quiet) {
          events.push({
            kind: 'ping',
            sessionId: s.id,
            at: s.startedAt,
            crisis: s.crisis,
            count: s.herCount
          });
        }
        s.deliveredAt = s.deliveredAt || Date.now();
      }

      // ⚠️ 她说的每一句话，原样传过去 —— 这是"传达"，不是"通知"。
      //
      // 之前只推了 ping 和 crisis，他手机上只知道"她按了按钮"，
      // 她后来跟木木说了什么他一无所知（那些话只躺在服务器里）。
      // 他的原话："做到真正的信息传达，一丝一毫都不差"。
      //
      // 用 sent 标记而不是时间戳游标：时间戳在边界上会漏消息，标记不会。
      for (const t of s.turns) {
        if (t.who === 'her' && !t.sent) {
          if (!crisisOnly || quiet) {
            events.push({
              kind: 'say',
              sessionId: s.id,
              at: t.at,
              text: t.text,              // 一字不改
              mood: t.mood || 'OK',      // CRISIS / LOW / OK
              // 她在要求转达 —— 不管情绪是哪一档，这个都要开口念
              relay: !!t.relay
            });
          }
          // 关掉通知时也要标记成"处理过了" ——
          // 不然她哪天开回来，会一次性涌出来几百条旧消息
          t.sent = true;
          // 推出去 == 到了他手机上。他那边划掉/点开通知时才升级成 read。
          t.delivered = true;
        }
      }
      // 危机事件推给他。
      //
      // ⚠️ 原来用的是布尔标记 notified，结果是【同一个会话里只推第一次】——
      //    她在一个会话里第二次自伤，他收不到任何东西。
      //    改成按"最后一次危机的时间"推：新的一次危机就一定推得到。
      if (s.crisis && (s.notifiedAt || 0) < (s.lastCrisisAt || s.startedAt)) {
        events.push({
          kind: 'crisis',
          sessionId: s.id,
          at: s.lastCrisisAt || s.startedAt,
          word: s.crisisWord,
          lines: herTurns(s).map((t) => t.text)   // 她的原话，一字不改
        });
        s.notifiedAt = s.lastCrisisAt || s.startedAt;
      }
    }

    // 她在聊天里跟他说的话 —— 跟「她跟木木说的」不一样，这条是冲他来的，
    // 所以不管通知开没开都要推（她关了通知也只关木木那些，不关这个）。
    for (const x of (data.fromHer || [])) {
      if (!x.sent) {
        events.push({
          kind: 'fromher',
          at: x.at,
          text: x.text || '',
          hasAudio: !!x.audio
        });
        x.sent = true;
      }
    }

    // 她摇他 —— 让手机震一分钟
    if (data.shake && !data.shake.sent) {
      events.push({ kind: 'shake', at: data.shake.at });
      data.shake.sent = true;
    }

    // 她按的「小小的打扰一下」
    for (const k of data.knocks) {
      if (!k.sent) {
        if (!crisisOnly || quiet) events.push({ kind: 'knock', at: k.at });
        k.sent = true;
        k.delivered = true;
      }
    }

    if (events.length) saveData();

    // 按时间排序：他那边是按顺序播报的，乱了会前后颠倒
    events.sort((a, b) => a.at - b.at);

    return send(res, 200, {
      ok: true,
      now: Date.now(),
      events: events,
      // 最近一个会话的全文，给他看上下文
      latest: data.sessions.length
        ? {
            id: data.sessions[data.sessions.length - 1].id,
            crisis: data.sessions[data.sessions.length - 1].crisis,
            turns: data.sessions[data.sessions.length - 1].turns.map((t) => ({
              who: t.who, text: t.text, at: t.at
            }))
          }
        : null
    });
  }

  send(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, HOST, () => {
  log('relay 启动', 'port=' + PORT);
});

// 每 20 分钟看一眼该不该主动找她。
// 不用更密 —— 边界是「间隔 4 小时」，20 分钟足够及时了。
// 启动时也跑一次，免得刚重启就要等 20 分钟。
setTimeout(() => {
  try { prepareProactive(); } catch (e) { log('proactive_crash', e.message); }
}, 60 * 1000);

setInterval(() => {
  try {
    prepareProactive();
  } catch (e) {
    log('proactive_crash', e.message);
  }
}, 20 * 60 * 1000);

// 每天清一次 180 天前的对话流水。
// 启动时也跑一次 —— 万一服务停过很久，开机就该把它清掉。
setTimeout(() => {
  try { pruneOldData(); } catch (e) { log('prune_crash', e.message); }
}, 90 * 1000);

setInterval(() => {
  try {
    pruneOldData();
  } catch (e) {
    log('prune_crash', e.message);
  }
}, 24 * 3600 * 1000);

// 别让一个未捕获异常把服务带走
process.on('uncaughtException', (e) => {
  log('uncaught', e && e.message);
});
process.on('unhandledRejection', (e) => {
  log('unhandledRejection', String(e));
});
