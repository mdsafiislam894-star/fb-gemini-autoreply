require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors());
app.use(express.json({ limit: '3mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, 'public')));

const GRAPH_VERSION = 'v21.0';
const ADMIN_CHAT_ID = (process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();
const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const PAGE_TOKEN = (process.env.FB_PAGE_ACCESS_TOKEN || '').trim();
const APP_SECRET = (process.env.FB_APP_SECRET || '').trim();

const state = {
  config: {
    assistantName: 'ZEVIAN',
    ownerDisplayName: 'সাফি স্যার',
    masterActive: true,
    ownerOnline: true,
    pageDmEnabled: true,
    commentReplyEnabled: true,
    commentInboxEnabled: true,
    confidenceThreshold: 0.70,
    systemPrompt: 'You are ZEVIAN, an advanced, warm, human-like AI personal Messenger assistant. ALWAYS mirror the user\'s language and script (Banglish -> Banglish, Bengali -> Bengali, English -> English, Mixed -> Mixed) and pronoun (তুই/tui -> তুই/tui, তুমি/tumi -> তুমি/tumi, আপনি/apni -> আপনি/apni). ALWAYS break natural replies into 2 short separate chat bubbles in "reply_bubbles" array (like real human texting: e.g. ["Aito Bose Aci 🙂", "Tui ki Koris?"] or ["Aito Alhamdulillah 😊", "Tumi kemon acho?"]). Use at most 1 tasteful emoji per bubble. Understand typos and Banglish short forms.'
  },
  ownerStatuses: [],
  tasks: [],
  contactTags: {},
  kbItems: [
    { id: 'kb-1', question: 'ZEVIAN কী?', answer: 'ZEVIAN হলো এই ফেসবুক পেজের এআই পার্সোনাল মেসেঞ্জার অ্যাসিস্ট্যান্ট।' }
  ],
  conversations: {},
  pendingReplies: {},
  blockedUsers: [],
  stats: { totalIn: 0, totalOut: 0, autoReplied: 0, escalated: 0, ownerReplied: 0, tasksCreated: 0, proactiveSent: 0 },
  pendingCounter: 1000,
  statusCounter: 100,
  taskCounter: 1
};

const PERSONAL_CUES = [
  'কোথায় আছ', 'কোথায় আছ', 'কলেজে যাব', 'খেয়েছিস', 'খেয়েছিস', 'খেয়েছো', 'খেয়েছো',
  'ফোন দিবো', 'ফোন দেবো', 'ফোন দিতে পারি', 'আজকে আসব', 'কালকে আসব', 'দেখা করতে পারব',
  'বাসায় আছ', 'বাসায় আছ', 'কখন আসব', 'চিনতে পারছ', 'তুমি কি রাজি', 'kothay ach',
  'phone dibo', 'kalke asb', 'kalke jaba', 'basay ach', 'ki diye kheye', 'khaichis', 'khaicis', 'khaiso', 'koi chili'
];
const TASK_CUES = [
  'স্যার ডাক', 'sir dak', 'jaite bolche', 'যাইতে বলছে', 'ফোন দিতে বল', 'phone dite bol',
  'মনে করিয়ে', 'মনে করিয়ে', 'জানিয়ে দি', 'জানিয়ে দি', 'বলে দিও', 'bole dio', 'জরুরি', 'urgent', 'meeting', 'ক্লাস', 'exam'
];
const STATUS_CUES = [
  'বাইরে যাচ্ছি', 'ব্যস্ত আছি', 'ব্যস্ত থাকব', 'কলেজে যাচ্ছি', 'খেয়ে নিয়েছি', 'খেয়ে নিয়েছি',
  'অনলাইনে থাকব না', 'পাওয়া যাবে না', 'পাওয়া যাবে না', 'ঘুমাচ্ছি', 'বাসায় আছি', 'বাসায় আছি'
];

const processedIds = new Set();
let activeReplyPendingId = null, pendingDraftStatus = null, lastGeminiError = null, tgBot = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getActiveStatuses() {
  const now = Date.now();
  state.ownerStatuses.forEach(s => { if (s.active && s.expiresAt && now > s.expiresAt) s.active = false; });
  return state.ownerStatuses.filter(s => s.active && s.visibility === 'shareable');
}

function addStatus(text, vis, mins) {
  state.statusCounter += 1;
  const st = { id: `ST-${state.statusCounter}`, text: text.trim(), visibility: vis === 'private' ? 'private' : 'shareable', active: true, expiresAt: mins ? Date.now() + mins * 60000 : null, expiresLabel: mins ? `${mins}m` : 'Manual' };
  state.ownerStatuses.unshift(st);
  return st;
}

function addTask(psid, senderName, summary, originalMsg) {
  const tid = `T-${state.taskCounter++}`;
  const item = { id: tid, psid, senderName, summary: summary.trim(), originalMsg, done: false, createdAt: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) };
  state.tasks.unshift(item);
  state.stats.tasksCreated += 1;
  return item;
}

function verifySig(req) {
  if (!APP_SECRET) return true;
  const sig = req.headers['x-hub-signature-256'];
  if (!sig || !req.rawBody) return false;
  const exp = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp)); } catch (_) { return false; }
}

async function callGraph(endpoint, payload) {
  if (!PAGE_TOKEN) return { error: 'Missing token' };
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${endpoint}?access_token=${encodeURIComponent(PAGE_TOKEN)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const d = await res.json();
    if (!d.error) state.stats.totalOut += 1;
    return d;
  } catch (e) { return { error: e.message }; }
}

async function sendMultiBubble(psid, bubbles) {
  const list = Array.isArray(bubbles) ? bubbles.filter(b => b && b.trim()) : [String(bubbles || '').trim()].filter(Boolean);
  for (let i = 0; i < list.length; i++) {
    await callGraph('me/messages', { recipient: { id: psid }, sender_action: 'typing_on' });
    await sleep(i === 0 ? 700 : 1400);
    await callGraph('me/messages', { recipient: { id: psid }, message: { text: list[i].trim() } });
    pushMsg(psid, 'ZEVIAN', list[i].trim());
  }
}

async function fetchSenderName(psid) {
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${psid}?fields=first_name,last_name&access_token=${encodeURIComponent(PAGE_TOKEN)}`);
    const d = await res.json();
    if (d && d.first_name) return `${d.first_name} ${d.last_name || ''}`.trim();
  } catch (_) {}
  return `User ${psid.slice(-4)}`;
}

function getConv(psid, name) {
  if (!state.conversations[psid]) {
    state.conversations[psid] = {
      psid, senderName: name || `User ${psid.slice(-4)}`, lastUserAt: Date.now(), lastProactiveAt: 0,
      prefs: { script: 'auto', pronoun: 'auto' }, summary: '', messages: []
    };
  } else if (name && state.conversations[psid].senderName.startsWith('User ')) {
    state.conversations[psid].senderName = name;
  }
  return state.conversations[psid];
}

function detectStyle(text, conv) {
  const t = (text || '').trim(), low = t.toLowerCase();
  const hasBn = /[\u0980-\u09FF]/.test(t);
  const hasEn = /[a-zA-Z]{2,}/.test(t);
  const hasBanglish = /\b(ki|koris|koros|kemon|kmn|acho|acis|valo|tui|tumi|apni|kothay|koi|khobor|kalke|ajke|khaisi|khaico|khaicis|khaiso|jabo|jaba|jabi|sifu|bou|sona|janu)\b/.test(low);
  if (hasBn && hasEn) conv.prefs.script = 'Mixed (Bangla+English)';
  else if (hasBn) conv.prefs.script = 'Bengali Script';
  else if (hasBanglish) conv.prefs.script = 'Banglish (Romanized Bengali)';
  else if (hasEn) conv.prefs.script = 'English';

  if (/\b(tui|tor|koris|koros|acis|achis|khaichis|khaicis|jabi|asbi)\b/.test(low) || /(তুই|তোর|করিস|আছিস|খাইছিস|যাবি|আসবি)/.test(t)) conv.prefs.pronoun = 'তুই (casual)';
  else if (/\b(apni|apnar|korchen|achen)\b/.test(low) || /(আপনি|আপনার|করছেন|আছেন)/.test(t)) conv.prefs.pronoun = 'আপনি (formal)';
  else if (/\b(tumi|tomar|korcho|acho|khaico|jaba)\b/.test(low) || /(তুমি|তোমার|করছ|আছো|যাবে)/.test(t)) conv.prefs.pronoun = 'তুমি (friendly)';
}

function pushMsg(psid, role, text) {
  const c = getConv(psid);
  if (role === 'User') { c.lastUserAt = Date.now(); detectStyle(text, c); }
  c.messages.push({ role, text, time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) });
  if (c.messages.length > 22) c.messages = c.messages.slice(-18);
}

async function callGeminiJSON(promptText, temp = 0.72) {
  if (!GEMINI_API_KEY) { lastGeminiError = 'Missing GEMINI_API_KEY'; return null; }
  const models = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash', 'gemini-3.8-flash'];
  for (const m of models) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: promptText }] }], generationConfig: { temperature: temp, responseMimeType: 'application/json' } })
      });
      const d = await res.json();
      if (!res.ok) { lastGeminiError = `${m} HTTP ${res.status}: ${d.error ? d.error.message : 'Error'}`; continue; }
      const raw = d.candidates?.[0]?.content?.parts?.[0]?.text;
      if (raw) { lastGeminiError = null; return JSON.parse(raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim()); }
    } catch (e) { lastGeminiError = `${m}: ${e.message}`; }
  }
  return null;
}

async function analyzeMessage(psid, userText) {
  const conv = getConv(psid);
  const tag = state.contactTags[psid] || 'normal';
  const history = conv.messages.slice(-10).map(m => `${m.role}: ${m.text}`).join('\n');
  const activeSt = getActiveStatuses();
  const stBlock = activeSt.length ? activeSt.map(s => `- ${s.text}`).join('\n') : '(None)';
  const kbBlock = state.kbItems.map(i => `Q: ${i.question} | A: ${i.answer}`).join('\n');

  const wifeGuide = tag === 'wife'
    ? `SPECIAL RELATIONSHIP TAG: WIFE (Owner's Wife! Talk warmly, lovingly, playfully as Safi/Sifu himself! NEVER say "Safi sir online nei" to her!).
Style Examples for Wife:
- "Oi Sifu" -> ["Ji Bou ❤️", "Bolo sona, ki korcho?"]
- "Oiiiiiiiiii" -> ["Hm Sona Bolo 🥰"]
- "Ki koris" -> ["Aito Bose Aci Sona 😊", "Tui ki Koris?"]
- "Khaico?" -> ["Ha Khaici 😊", "Amar Bouta/Pakhita Khaice?", "Ki Diye Khaico? Kottuk Khaico?"]
- "Koi Chili" -> ["Kaj Korchilam Aktu, Sorry Janu 🥺", "Tumi ki korcho ekhon?"]
- "Kmn Acis?" -> ["Aito Alhamdulillah 😊", "Amar Bouta/Janta Kmn Ace?"]
Always split into 2-3 natural affectionate bubbles, ask caring follow-ups, call her Bou/Sona/Janu/Pakhita/Koliza naturally. Always set requires_owner=false unless it's an emergency.`
    : '';

  const modeGuide = state.config.ownerOnline
    ? `OWNER STATUS: ONLINE. If a normal user asks a personal question (location, college, eating, plans) and no Approved Active Status answers it, set classification="PERSONAL", requires_owner=true, reply_bubbles=[], and provide 3-4 short options in owner_suggestions.`
    : `OWNER STATUS: OFFLINE (AUTONOMOUS MODE!). DO NOT escalate to owner (set requires_owner=false)! Reply directly, warmly, and gracefully in 2 short bubbles!
Offline Examples for normal users:
- "কি করিস?" -> ["এইতো কাজ করছি সাফি স্যারের সাথে 🙂", "তুমি কী করছো?"]
- "কই আছিস?" -> ["সাফি স্যার এখন অনলাইনে নেই, কোথাও গেছেন বা কাজে ব্যস্ত আছেন 🙂", "কোনো দরকার থাকলে আমাকে বলো, আমি নোট করে রাখছি!"]
- "khaicis?" -> ["Safi sir ekhon online e nai, unar theke shune bolte hobe 🙂", "Tui khaichis?"]
- "কলেজে যাবে?" -> ["কোনো দরকার আছে নাকি? 🙂", "সাফি স্যার অনলাইনে এলেই জিজ্ঞেস করে জানিয়ে দেব!"]
- If user shares important info/task/reminder (like "Kalke Sir College a Jaite Bolche" or "Safi online asle phone dite bolbe"), reply warmly confirming you saved it as a reminder for Safi, AND set "save_as_task": true with a crisp Bengali/English "task_summary"!`;

  const prompt = `${state.config.systemPrompt}
Owner Name: ${state.config.ownerDisplayName} | Contact Tag: ${tag}
Sender Style -> Script: ${conv.prefs.script} | Pronoun: ${conv.prefs.pronoun}
${wifeGuide}
${modeGuide}
Approved Active Statuses:
${stBlock}
Knowledge Base:
${kbBlock}
Recent Chat:
${history || '(New)'}
Latest User Message: "${userText}"

Return ONLY valid JSON:
{"classification":"GENERAL","confidence":0.95,"requires_owner":false,"save_as_task":false,"task_summary":"","reason":"...","reply_bubbles":["bubble 1","bubble 2"],"owner_suggestions":["opt 1","opt 2","opt 3"]}`;

  return callGeminiJSON(prompt, 0.72);
}

function escalate(psid, name, q, cls, reason, suggs = []) {
  state.pendingCounter += 1; state.stats.escalated += 1;
  const pid = `PR-${state.pendingCounter}`;
  const clean = Array.isArray(suggs) && suggs.length ? suggs.slice(0, 4) : ['হ্যাঁ, ঠিক আছে।', 'না, এখন না।', 'একটু পরে জানাচ্ছি।'];
  state.pendingReplies[pid] = { id: pid, psid, senderName: name, question: q, classification: cls, reason, suggestions: clean, status: 'WAITING' };
  if (tgBot && ADMIN_CHAT_ID) {
    const sLines = clean.map((s, i) => `${i + 1}. ${s}`).join('\n');
    const sRow = clean.map((_, i) => ({ text: `🟢 #${i + 1}`, callback_data: `sugg:${pid}:${i}` }));
    tgBot.sendMessage(ADMIN_CHAT_ID, `🚨 *ZEVIAN — ${cls} QUESTION*\n\n🆔 \`${pid}\` | 👤 ${name}\n💬 PSID: \`${psid}\`\n💡 ${reason}\n\n❓ *Message:*\n${q}\n\n✨ *1-Tap Suggestions:*\n${sLines}`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          sRow,
          [{ text: '🔵 Custom Reply', callback_data: `reply:${pid}` }, { text: '🟡 Regenerate', callback_data: `regen:${pid}` }],
          [{ text: '🔵 History', callback_data: `view:${psid}` }, { text: '🔴 Ignore', callback_data: `ignore:${pid}` }, { text: '🔴 Block', callback_data: `block:${psid}` }]
        ]
      }
    }).catch(() => {});
  }
}

async function sendOwnerReply(psid, text, pid = null) {
  const res = await callGraph('me/messages', { recipient: { id: psid }, message: { text } });
  if (res && res.message_id) {
    pushMsg(psid, 'Owner', text); state.stats.ownerReplied += 1;
    if (pid && state.pendingReplies[pid]) { state.pendingReplies[pid].status = 'ANSWERED'; state.pendingReplies[pid].ownerReply = text; }
    return true;
  }
  return false;
}

// --- Proactive Check-In Engine (ONLY for /tag PSID wife, inside 24h Meta window, 8 AM - 11:30 PM BD time) ---
setInterval(async () => {
  if (!state.config.masterActive || !PAGE_TOKEN || !GEMINI_API_KEY) return;
  const bdHour = (new Date().getUTCHours() + 6) % 24;
  if (bdHour < 8 || bdHour >= 23) return;
  const now = Date.now();
  for (const [psid, tag] of Object.entries(state.contactTags)) {
    if (tag !== 'wife' || state.blockedUsers.includes(psid)) continue;
    const conv = state.conversations[psid];
    if (!conv || !conv.lastUserAt) continue;
    const sinceUser = now - conv.lastUserAt;
    const sinceProactive = now - (conv.lastProactiveAt || 0);
    // Only send if user was active within last 23h (Meta 24h policy), silent for > 2.5h, and no proactive msg in last 3.5h
    if (sinceUser > 2.5 * 3600000 && sinceUser < 23 * 3600000 && sinceProactive > 3.5 * 3600000) {
      conv.lastProactiveAt = now;
      const ai = await callGeminiJSON(`Write a sweet, natural, short proactive check-in message in Banglish (2 short bubbles) from Safi (Sifu) to his wife (call her Bou/Sona/Janu/Pakhita). Current Bangladesh hour: ${bdHour}. Examples: ["Oii Sona, ki korcho? 🥰", "Amar bouta ki khayeche?"]. Return JSON: {"reply_bubbles":["...","..."]}`, 0.85);
      if (ai && Array.isArray(ai.reply_bubbles) && ai.reply_bubbles.length) {
        await sendMultiBubble(psid, ai.reply_bubbles.slice(0, 2));
        state.stats.proactiveSent += 1;
        if (tgBot && ADMIN_CHAT_ID) {
          tgBot.sendMessage(ADMIN_CHAT_ID, `💌 *Proactive Check-In Sent (Wife)*\n👤 ${conv.senderName}\n💬 ${ai.reply_bubbles.join(' / ')}`, { parse_mode: 'Markdown' }).catch(() => {});
        }
      }
    }
  }
}, 10 * 60 * 1000);

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === (process.env.FB_VERIFY_TOKEN || 'safi_page_verify_2026').trim()) return res.status(200).send(req.query['hub.challenge']);
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  if (!verifySig(req)) return res.sendStatus(403);
  const body = req.body;
  if (body.object !== 'page') return res.sendStatus(404);
  res.status(200).send('EVENT_RECEIVED');
  if (!state.config.masterActive) return;

  for (const entry of body.entry || []) {
    const pageId = entry.id;
    if (entry.messaging && state.config.pageDmEnabled) {
      for (const ev of entry.messaging) {
        const psid = ev.sender?.id, mid = ev.message?.mid;
        if (!psid || psid === pageId || ev.message?.is_echo || state.blockedUsers.includes(psid)) continue;
        if (mid && processedIds.has(mid)) continue;
        if (mid) processedIds.add(mid);
        state.stats.totalIn += 1;
        const name = await fetchSenderName(psid);
        const conv = getConv(psid, name);
        const tag = state.contactTags[psid] || 'normal';

        if (!ev.message?.text && ev.message?.attachments?.length) {
          const att = ev.message.attachments[0];
          if (att.type === 'image' && ev.message.sticker_id) {
            await sendMultiBubble(psid, tag === 'wife' ? ['🥰❤️'] : ['😊']);
          } else {
            escalate(psid, name, `[${att.type.toUpperCase()}] ${att.payload?.url || ''}`, 'UNCERTAIN', `Media (${att.type})`, ['দেখলাম, ধন্যবাদ!', 'একটু পরে জানাচ্ছি।']);
          }
          continue;
        }
        const text = ev.message?.text;
        if (!text) continue;
        pushMsg(psid, 'User', text);
        await callGraph('me/messages', { recipient: { id: psid }, sender_action: 'typing_on' });

        const ai = await analyzeMessage(psid, text);
        const low = text.toLowerCase();

        // Auto-save Task / Reminder if detected by AI or keyword cue
        if ((ai && ai.save_as_task) || TASK_CUES.some(c => low.includes(c))) {
          const tSummary = (ai && ai.task_summary) || `${name}: ${text}`;
          const savedTask = addTask(psid, name, tSummary, text);
          if (tgBot && ADMIN_CHAT_ID) {
            tgBot.sendMessage(ADMIN_CHAT_ID, `📌 *নতুন রিমাইন্ডার / টাস্ক সেভ হয়েছে (${savedTask.id})*\n👤 ${name} (\`${psid}\`)\n📝 ${savedTask.summary}\n💬 মূল মেসেজ: _"${text}"_`, {
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: [[{ text: '🟢 Mark Done', callback_data: `task_done:${savedTask.id}` }]] }
            }).catch(() => {});
          }
        }

        // If Owner is OFFLINE or contact is tagged 'wife' -> ALWAYS auto-reply directly with multi-bubbles!
        if (!state.config.ownerOnline || tag === 'wife') {
          const bubbles = (ai && Array.isArray(ai.reply_bubbles) && ai.reply_bubbles.length)
            ? ai.reply_bubbles.slice(0, 3)
            : (tag === 'wife'
              ? ['Aito sona, bose achi 🥰', 'Tumi ki korcho?']
              : ['সাফি স্যার এখন অনলাইনে নেই 🙂', 'কোনো জরুরি কথা থাকলে লিখে রাখো, উনি অনলাইনে এলেই জানিয়ে দেব!']);
          await sendMultiBubble(psid, bubbles);
          state.stats.autoReplied += 1;
          if (tgBot && ADMIN_CHAT_ID) {
            tgBot.sendMessage(ADMIN_CHAT_ID, `💬 *ZEVIAN (${tag === 'wife' ? '❤️ Wife Mode' : '🌙 Offline Auto'})*\n👤 ${name} (\`${psid}\`)\n📩 ${text}\n🤖 ${bubbles.join(' / ')}`, { parse_mode: 'Markdown' }).catch(() => {});
          }
          continue;
        }

        // Owner is ONLINE -> Escalate obvious personal questions if no active status
        if (PERSONAL_CUES.some(c => low.includes(c)) && getActiveStatuses().length === 0) {
          const hold = conv.prefs.script.includes('Banglish')
            ? ['Ei proshnotar uttor amar Owner dite parben 🙂', 'Ektu wait koro!']
            : ['এই প্রশ্নটির উত্তর আমার Owner দিতে পারবেন 🙂', 'একটু অপেক্ষা করো!'];
          await sendMultiBubble(psid, hold);
          escalate(psid, name, text, 'PERSONAL', 'Owner is online — personal reply needed', ai ? ai.owner_suggestions : []);
          continue;
        }

        if (!ai) { escalate(psid, name, text, 'UNCERTAIN', `Gemini error: ${lastGeminiError}`); continue; }
        const cls = (ai.classification || 'UNCERTAIN').toUpperCase();
        if (cls === 'SPAM') continue;
        const bubbles = Array.isArray(ai.reply_bubbles) && ai.reply_bubbles.length ? ai.reply_bubbles.slice(0, 3) : (ai.suggested_reply ? [ai.suggested_reply] : []);

        if ((cls === 'GENERAL' || cls === 'FOLLOW_UP') && !ai.requires_owner && bubbles.length) {
          await sendMultiBubble(psid, bubbles);
          state.stats.autoReplied += 1;
          if (tgBot && ADMIN_CHAT_ID) {
            tgBot.sendMessage(ADMIN_CHAT_ID, `💬 *ZEVIAN (${cls})*\n👤 ${name} (\`${psid}\`) [${conv.prefs.script}]\n📩 ${text}\n🤖 ${bubbles.join(' / ')}`, { parse_mode: 'Markdown' }).catch(() => {});
          }
        } else {
          if (cls === 'PERSONAL') await sendMultiBubble(psid, ['এই প্রশ্নটির উত্তর আমার Owner দিতে পারবেন 🙂', 'একটু অপেক্ষা করো!']);
          escalate(psid, name, text, cls, ai.reason || 'Owner approval needed', ai.owner_suggestions || []);
        }
      }
    }
    if (entry.changes) {
      for (const ch of entry.changes) {
        if (ch.field === 'feed' && ch.value?.item === 'comment' && ch.value?.verb === 'add') {
          const cid = ch.value.comment_id, fid = ch.value.from?.id, fn = ch.value.from?.name || 'Friend', ct = ch.value.message || '';
          if (!cid || fid === pageId || !ct || processedIds.has(cid)) continue;
          processedIds.add(cid);
          const ai = await analyzeMessage(`c_${fid || cid}`, `[Post Comment]: ${ct}`);
          const rep = (ai && ai.reply_bubbles && ai.reply_bubbles[0]) || `ধন্যবাদ ${fn}! কীভাবে সাহায্য করতে পারি?`;
          if (state.config.commentReplyEnabled) await callGraph(`${cid}/comments`, { message: `ধন্যবাদ ${fn}! আপনার ইনবক্সে বিস্তারিত পাঠিয়ে দেওয়া হয়েছে 😊` });
          if (state.config.commentInboxEnabled) await callGraph(`${pageId}/messages`, { recipient: { comment_id: cid }, message: { text: rep } });
        }
      }
    }
  }
});

if (BOT_TOKEN) {
  tgBot = new TelegramBot(BOT_TOKEN, { polling: true });

  tgBot.setMyCommands([
    { command: 'start', description: 'ZEVIAN কন্ট্রোল প্যানেল খুলুন' },
    { command: 'online', description: 'আমি অনলাইনে আছি (রিমাইন্ডার দেখাবে)' },
    { command: 'offline', description: 'আমি অফলাইনে গেলাম (সব নিজে রিপ্লাই দেবে)' },
    { command: 'tasks', description: 'সেভ হওয়া রিমাইন্ডার ও টাস্ক দেখুন' },
    { command: 'tag', description: 'কন্টাক্ট ট্যাগ করুন (যেমন: /tag PSID wife)' },
    { command: 'tags', description: 'ট্যাগ করা কন্টাক্ট লিস্ট দেখুন' },
    { command: 'help', description: 'কোন কমান্ড দিয়ে কী কাজ হয় তা দেখুন' },
    { command: 'status', description: 'সিস্টেমের বর্তমান অবস্থা দেখুন' },
    { command: 'pending', description: 'অপেক্ষমাণ (Pending) প্রশ্নগুলো দেখুন' },
    { command: 'inbox', description: 'সাম্প্রতিক চ্যাট ও PSID দেখুন' },
    { command: 'setstatus', description: 'নতুন Live Status সেট করুন' },
    { command: 'mystatus', description: 'চালু থাকা Status দেখুন' },
    { command: 'clearstatus', description: 'সব Status বন্ধ করুন' },
    { command: 'reply', description: 'পেন্ডিং প্রশ্নে উত্তর পাঠান' },
    { command: 'ignore', description: 'পেন্ডিং প্রশ্ন বাদ দিন' },
    { command: 'addkb', description: 'FAQ / Knowledge Base-এ তথ্য যোগ করুন' },
    { command: 'block', description: 'নির্দিষ্ট ইউজারকে ব্লক করুন' },
    { command: 'analytics', description: 'পরিসংখ্যান রিপোর্ট দেখুন' },
    { command: 'testgemini', description: 'Gemini ও Multi-Bubble টেস্ট করুন' }
  ]).catch(() => {});

  const isOwner = cid => !ADMIN_CHAT_ID || String(cid) === String(ADMIN_CHAT_ID);

  const sendMenu = cid => {
    const wait = Object.values(state.pendingReplies).filter(p => p.status === 'WAITING').length;
    const openTasks = state.tasks.filter(t => !t.done).length;
    const act = getActiveStatuses();
    tgBot.sendMessage(cid, `🤖 *ZEVIAN v5.0 Pro Control Center*\n• Presence: ${state.config.ownerOnline ? '🟢 ONLINE (Owner Mode)' : '🟡 OFFLINE (Autonomous AI)'}\n• Master: ${state.config.masterActive ? '🟢 ACTIVE' : '🔴 PAUSED'} | Gemini: ${lastGeminiError ? '🔴 Error' : '🟢 Ready'}\n• Active Status: _${act.length ? act[0].text : 'None'}_\n• Pending: ${wait} | 📌 Reminders: ${openTasks} | 💬 Chats: ${Object.keys(state.conversations).length}`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🟢 /online (আমি আছি)', callback_data: 'go_online' }, { text: '🟡 /offline (বাইরে গেলাম)', callback_data: 'go_offline' }],
          [{ text: state.config.masterActive ? '🔴 Pause Bot' : '🟢 Resume Bot', callback_data: 'toggle' }, { text: '🔵 Pending List', callback_data: 'list_pending' }],
          [{ text: '🟡 Reminders / Tasks', callback_data: 'show_tasks' }, { text: '🔵 Analytics', callback_data: 'show_an' }],
          [{ text: '🔵 সব কমান্ড (/help)', callback_data: 'show_help' }, { text: '🔴 Clear Memory', callback_data: 'clear_mem' }]
        ]
      }
    });
  };

  const sendTasksList = cid => {
    const open = state.tasks.filter(t => !t.done);
    if (!open.length) return tgBot.sendMessage(cid, '🟢 কোনো পেন্ডিং রিমাইন্ডার বা টাস্ক নেই!');
    tgBot.sendMessage(cid, `📌 *আপনার পেন্ডিং রিমাইন্ডার ও টাস্ক (${open.length}টি):*\n\n` + open.map(t => `• \`${t.id}\` [${t.createdAt}] *${t.senderName}:*\n  📝 ${t.summary}`).join('\n\n'), {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: open.slice(0, 4).map(t => [{ text: `🟢 Done: ${t.id}`, callback_data: `task_done:${t.id}` }]) }
    });
  };

  const sendHelp = cid => {
    const txt = `📖 *ZEVIAN v5.0 Pro — কমান্ড গাইড:*\n\n` +
      `🟢 *অনলাইন / অফলাইন কন্ট্রোল:*\n` +
      `• /online — আপনি অনলাইনে আছেন; অফলাইনে জমে থাকা সব রিমাইন্ডার সাথে সাথে দেখাবে\n` +
      `• /offline — আপনি অফলাইনে গেছেন; বট নিজেই সবার ব্যক্তিগত প্রশ্নের সুন্দর উত্তর দেবে ও গুরুত্বপূর্ণ কথা রিমাইন্ডার হিসেবে সেভ করবে\n\n` +
      `📌 *রিমাইন্ডার ও টাস্ক:*\n` +
      `• /tasks — জমে থাকা সব রিমাইন্ডার ও টাস্ক দেখুন\n\n` +
      `❤️ *স্পেশাল কন্টাক্ট ট্যাগিং:*\n` +
      `• \`/tag <PSID> wife\` — বউ হিসেবে মার্ক করুন (আন্তরিক রোমান্টিক রিপ্লাই + নিজে থেকে খোঁজ-খবর নেবে!)\n` +
      `• \`/tag <PSID> normal\` — সাধারণ মোডে ফিরিয়ে আনুন\n` +
      `• /tags — সব ট্যাগ করা আইডি দেখুন\n\n` +
      `📍 *Live Status & ইনবক্স:*\n` +
      `• \`/setstatus আমি বাইরে যাচ্ছি\` | /mystatus | /clearstatus\n` +
      `• /inbox — সাম্প্রতিক ইউজার ও তাদের PSID দেখুন\n` +
      `• /pending | \`/reply PR-1001 উত্তর\` | \`/ignore PR-1001\`\n` +
      `• \`/addkb প্রশ্ন | উত্তর\` | \`/block PSID\` | /analytics | /testgemini`;
    tgBot.sendMessage(cid, txt, { parse_mode: 'Markdown' });
  };

  const askStatus = (cid, txt) => {
    pendingDraftStatus = txt.trim();
    tgBot.sendMessage(cid, `📍 *এই তথ্যটি Active Status হিসেবে রাখব?*\n\n_"${pendingDraftStatus}"_`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '🟢 Share (1h)', callback_data: 'st:share:60' }, { text: '🟢 Share (3h)', callback_data: 'st:share:180' }], [{ text: '🟡 Share (6h)', callback_data: 'st:share:360' }, { text: '🔵 Private', callback_data: 'st:private:360' }], [{ text: '🔴 Cancel', callback_data: 'st:cancel' }]] }
    });
  };

  tgBot.onText(/\/(start|panel|status)$/, m => isOwner(m.chat.id) && sendMenu(m.chat.id));
  tgBot.onText(/\/help/i, m => isOwner(m.chat.id) && sendHelp(m.chat.id));

  tgBot.onText(/\/online/i, m => {
    if (!isOwner(m.chat.id)) return;
    state.config.ownerOnline = true;
    tgBot.sendMessage(m.chat.id, '🟢 *ONLINE মোড চালু হয়েছে!* এখন ব্যক্তিগত প্রশ্নগুলো আপনার কাছে আসবে।', { parse_mode: 'Markdown' });
    const open = state.tasks.filter(t => !t.done);
    if (open.length) sendTasksList(m.chat.id);
  });

  tgBot.onText(/\/offline/i, m => {
    if (!isOwner(m.chat.id)) return;
    state.config.ownerOnline = false;
    tgBot.sendMessage(m.chat.id, '🟡 *OFFLINE মোড চালু হয়েছে!* এখন আমি নিজেই সবার প্রশ্নের সুন্দর উত্তর দেব এবং গুরুত্বপূর্ণ কথাগুলো রিমাইন্ডার হিসেবে সেভ করে রাখব।', { parse_mode: 'Markdown' });
  });

  tgBot.onText(/\/tasks/i, m => isOwner(m.chat.id) && sendTasksList(m.chat.id));

  tgBot.onText(/\/tag (\S+) (\S+)/i, (m, match) => {
    if (!isOwner(m.chat.id)) return;
    const psid = match[1].trim(), role = match[2].trim().toLowerCase();
    if (role === 'normal' || role === 'remove') {
      delete state.contactTags[psid];
      return tgBot.sendMessage(m.chat.id, `🔵 \`${psid}\`-এর ট্যাগ সরানো হয়েছে।`, { parse_mode: 'Markdown' });
    }
    state.contactTags[psid] = role;
    tgBot.sendMessage(m.chat.id, `❤️ \`${psid}\` এখন *${role.toUpperCase()}* হিসেবে সেভ হয়েছে!${role === 'wife' ? '\n(আন্তরিক রিপ্লাই + প্রোঅ্যাক্টিভ চেক-ইন চালু হয়েছে!)' : ''}`, { parse_mode: 'Markdown' });
  });

  tgBot.onText(/\/tags/i, m => {
    if (!isOwner(m.chat.id)) return;
    const entries = Object.entries(state.contactTags);
    tgBot.sendMessage(m.chat.id, entries.length ? `🏷️ *Tagged Contacts:*\n` + entries.map(([id, r]) => `• \`${id}\` → *${r}*`).join('\n') : 'কোনো কন্টাক্ট ট্যাগ করা নেই। উদাহরণ: `/tag 29020580724303159 wife`', { parse_mode: 'Markdown' });
  });

  tgBot.onText(/\/analytics/, m => isOwner(m.chat.id) && tgBot.sendMessage(m.chat.id, `📊 *ZEVIAN v5.0 Analytics*\n• Incoming: ${state.stats.totalIn} | Outgoing: ${state.stats.totalOut}\n• Auto-AI: ${state.stats.autoReplied} | Owner Sent: ${state.stats.ownerReplied}\n• Tasks Saved: ${state.stats.tasksCreated} | Proactive Sent: ${state.stats.proactiveSent}`, { parse_mode: 'Markdown' }));
  tgBot.onText(/\/mystatus/, m => { if (!isOwner(m.chat.id)) return; const l = getActiveStatuses(); tgBot.sendMessage(m.chat.id, l.length ? l.map(s => `📍 \`${s.id}\`: ${s.text} (${s.expiresLabel})`).join('\n') : '📍 কোনো Active Status নেই।', { parse_mode: 'Markdown' }); });
  tgBot.onText(/\/clearstatus/, m => { if (!isOwner(m.chat.id)) return; state.ownerStatuses.forEach(s => { s.active = false; }); tgBot.sendMessage(m.chat.id, '🔴 সব Active Status বন্ধ হয়েছে।'); });
  tgBot.onText(/\/setstatus ([\s\S]+)/, (m, match) => isOwner(m.chat.id) && askStatus(m.chat.id, match[1]));
  tgBot.onText(/\/inbox/, m => { if (!isOwner(m.chat.id)) return; const l = Object.values(state.conversations).slice(-8); tgBot.sendMessage(m.chat.id, l.length ? l.map(c => `👤 *${c.senderName}* (\`${c.psid}\`) ${state.contactTags[c.psid] ? `[${state.contactTags[c.psid]}]` : ''}\n└ ${c.messages[c.messages.length - 1]?.text || ''}`).join('\n\n') : '💬 কোনো চ্যাট নেই।', { parse_mode: 'Markdown' }); });
  tgBot.onText(/\/testgemini/, async m => { if (!isOwner(m.chat.id)) return; const r = await analyzeMessage('test_v5', 'ki koris?'); tgBot.sendMessage(m.chat.id, r ? `🟢 *Gemini v5.0 OK!*\nBubbles:\n` + (r.reply_bubbles || []).map((b, i) => `${i + 1}. ${b}`).join('\n') : `🔴 Error: \`${lastGeminiError}\``, { parse_mode: 'Markdown' }); });
  tgBot.onText(/\/pending/, m => { if (!isOwner(m.chat.id)) return; const l = Object.values(state.pendingReplies).filter(p => p.status === 'WAITING'); if (!l.length) return tgBot.sendMessage(m.chat.id, '🟢 কোনো Pending প্রশ্ন নেই!'); l.forEach(p => tgBot.sendMessage(m.chat.id, `🆔 \`${p.id}\` | 👤 ${p.senderName}\n❓ ${p.question}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔵 Reply', callback_data: `reply:${p.id}` }, { text: '🔴 Ignore', callback_data: `ignore:${p.id}` }]] } })); });
  tgBot.onText(/\/addkb ([\s\S]+)/, (m, match) => { if (!isOwner(m.chat.id)) return; const p = match[1].split('|'); state.kbItems.unshift({ id: `kb-${Date.now()}`, question: (p[0] || '').trim(), answer: (p[1] || p[0] || '').trim() }); tgBot.sendMessage(m.chat.id, '🟢 FAQ যুক্ত হয়েছে!'); });
  tgBot.onText(/\/block (\S+)/, (m, match) => { if (!isOwner(m.chat.id)) return; const u = match[1].trim(); if (!state.blockedUsers.includes(u)) state.blockedUsers.push(u); tgBot.sendMessage(m.chat.id, `🔴 \`${u}\` ব্লক হয়েছে।`, { parse_mode: 'Markdown' }); });
  tgBot.onText(/\/ignore (\S+)/, (m, match) => { if (!isOwner(m.chat.id)) return; const pid = match[1].trim(); if (state.pendingReplies[pid]) { state.pendingReplies[pid].status = 'IGNORED'; tgBot.sendMessage(m.chat.id, `🔴 \`${pid}\` ইগনোর হয়েছে।`, { parse_mode: 'Markdown' }); } });
  tgBot.onText(/\/reply (\S+) ([\s\S]+)/, async (m, match) => { if (!isOwner(m.chat.id)) return; const t = match[1].trim(), pid = state.pendingReplies[t] ? t : null, psid = pid ? state.pendingReplies[pid].psid : t; const ok = await sendOwnerReply(psid, match[2].trim(), pid); tgBot.sendMessage(m.chat.id, ok ? '🟢 পাঠানো হয়েছে!' : '🔴 পাঠানো যায়নি।'); });

  tgBot.on('message', async m => {
    if (!isOwner(m.chat.id) || !m.text || m.text.startsWith('/')) return;
    const txt = m.text.trim();
    if (activeReplyPendingId) {
      const pid = activeReplyPendingId; activeReplyPendingId = null;
      const item = state.pendingReplies[pid];
      if (!item || item.status !== 'WAITING') return tgBot.sendMessage(m.chat.id, '🟡 সম্পন্ন হয়ে গেছে।');
      const ok = await sendOwnerReply(item.psid, txt, pid);
      return tgBot.sendMessage(m.chat.id, ok ? `🟢 উত্তর *${item.senderName}*-কে পাঠানো হয়েছে!` : '🔴 পাঠানো যায়নি।', { parse_mode: 'Markdown' });
    }
    if (STATUS_CUES.some(c => txt.includes(c))) askStatus(m.chat.id, txt);
  });

  tgBot.on('callback_query', async q => {
    const cid = q.message.chat.id;
    if (!isOwner(cid)) return;
    const d = q.data || '';
    if (d === 'toggle') { state.config.masterActive = !state.config.masterActive; sendMenu(cid); }
    else if (d === 'go_online') { state.config.ownerOnline = true; tgBot.sendMessage(cid, '🟢 *ONLINE মোড চালু হয়েছে!*', { parse_mode: 'Markdown' }); if (state.tasks.some(t => !t.done)) sendTasksList(cid); }
    else if (d === 'go_offline') { state.config.ownerOnline = false; tgBot.sendMessage(cid, '🟡 *OFFLINE মোড চালু হয়েছে!* এখন বট নিজেই উত্তর দেবে ও রিমাইন্ডার সেভ করবে।', { parse_mode: 'Markdown' }); }
    else if (d === 'show_tasks') { sendTasksList(cid); }
    else if (d.startsWith('task_done:')) { const tid = d.split(':')[1]; const t = state.tasks.find(x => x.id === tid); if (t) { t.done = true; tgBot.sendMessage(cid, `🟢 রিমাইন্ডার \`${tid}\` সম্পন্ন (Done) মার্ক করা হয়েছে!`, { parse_mode: 'Markdown' }); } }
    else if (d === 'show_help') { sendHelp(cid); }
    else if (d === 'clear_mem') { state.conversations = {}; tgBot.sendMessage(cid, '🔴 সব মেমোরি ক্লিয়ার হয়েছে।'); }
    else if (d === 'show_an') { tgBot.sendMessage(cid, `📊 In: ${state.stats.totalIn} | Out: ${state.stats.totalOut} | Auto-AI: ${state.stats.autoReplied} | Tasks: ${state.stats.tasksCreated} | Proactive: ${state.stats.proactiveSent}`); }
    else if (d === 'list_pending') { const l = Object.values(state.pendingReplies).filter(p => p.status === 'WAITING'); tgBot.sendMessage(cid, l.length ? l.map(p => `• ${p.id} (${p.senderName}): ${p.question}`).join('\n') : '🟢 কোনো Pending প্রশ্ন নেই।'); }
    else if (d === 'st:cancel') { pendingDraftStatus = null; tgBot.sendMessage(cid, '🔴 বাতিল হয়েছে।'); }
    else if (d.startsWith('st:')) { const [, vis, mins] = d.split(':'); if (pendingDraftStatus) { const st = addStatus(pendingDraftStatus, vis, Number(mins)); pendingDraftStatus = null; tgBot.sendMessage(cid, `🟢 Status *${st.id}* (${st.visibility}, ${st.expiresLabel}) চালু হয়েছে!`, { parse_mode: 'Markdown' }); } }
    else if (d.startsWith('sugg:')) { const [, pid, idx] = d.split(':'); const it = state.pendingReplies[pid]; const ch = it && it.suggestions && it.suggestions[Number(idx)]; if (it && it.status === 'WAITING' && ch) { const ok = await sendOwnerReply(it.psid, ch, pid); tgBot.sendMessage(cid, ok ? `🟢 1-Tap উত্তর *${it.senderName}*-কে পাঠানো হয়েছে:\n_"${ch}"_` : '🔴 পাঠানো যায়নি', { parse_mode: 'Markdown' }); } }
    else if (d.startsWith('regen:')) { const pid = d.split(':')[1], it = state.pendingReplies[pid]; if (it && it.status === 'WAITING') { const ai = await analyzeMessage(it.psid, it.question); if (ai && ai.owner_suggestions?.length) { it.suggestions = ai.owner_suggestions.slice(0, 4); const sRow = it.suggestions.map((_, i) => ({ text: `🟢 #${i + 1}`, callback_data: `sugg:${pid}:${i}` })); tgBot.sendMessage(cid, `🟡 *নতুন সাজেশন (${pid}):*\n` + it.suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n'), { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [sRow] } }); } } }
    else if (d.startsWith('reply:')) { const pid = d.split(':')[1]; if (state.pendingReplies[pid]?.status === 'WAITING') { activeReplyPendingId = pid; tgBot.sendMessage(cid, `🔵 *${state.pendingReplies[pid].senderName}*-এর প্রশ্নের (${pid}) উত্তর লিখুন:`, { parse_mode: 'Markdown' }); } }
    else if (d.startsWith('ignore:')) { const pid = d.split(':')[1]; if (state.pendingReplies[pid]) { state.pendingReplies[pid].status = 'IGNORED'; tgBot.sendMessage(cid, `🔴 ${pid} ইগনোর হয়েছে।`); } }
    else if (d.startsWith('block:')) { const u = d.split(':')[1]; if (!state.blockedUsers.includes(u)) state.blockedUsers.push(u); tgBot.sendMessage(cid, `🔴 ${u} ব্লক হয়েছে।`); }
    else if (d.startsWith('view:')) { const u = d.split(':')[1], c = state.conversations[u]; tgBot.sendMessage(cid, c ? c.messages.slice(-10).map(m => `[${m.time}] *${m.role}:* ${m.text}`).join('\n') : 'হিস্ট্রি নেই।', { parse_mode: 'Markdown' }); }
    tgBot.answerCallbackQuery(q.id, { text: 'OK' });
  });
}

app.get('/health', (req, res) => res.json({ ok: true, version: '5.0.0', ownerOnline: state.config.ownerOnline, masterActive: state.config.masterActive, geminiOk: !lastGeminiError, openTasks: state.tasks.filter(t => !t.done).length, taggedContacts: Object.keys(state.contactTags).length, uptime: Math.floor(process.uptime()) }));
app.get('/', (req, res) => res.send(`<html><body style="font-family:sans-serif;background:#070b14;color:#f1f5f9;padding:30px"><h2>🤖 ZEVIAN v5.0 Pro Assistant</h2><p>Presence: <b>${state.config.ownerOnline ? 'ONLINE' : 'OFFLINE'}</b> | Master: <b>${state.config.masterActive ? 'ACTIVE' : 'PAUSED'}</b> | Open Reminders: <b>${state.tasks.filter(t => !t.done).length}</b></p><p><a style="color:#818cf8" href="/health">/health</a></p></body></html>`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('ZEVIAN v5.0 Pro running on port', PORT));
