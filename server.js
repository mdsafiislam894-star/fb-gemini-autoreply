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
    pageDmEnabled: true,
    commentReplyEnabled: true,
    commentInboxEnabled: true,
    mirrorMode: true,
    confidenceThreshold: 0.72,
    systemPrompt: 'You are ZEVIAN, an intelligent, natural, friend-like AI personal Messenger assistant. Core Rule — Auto Language, Script & Style Mirroring (Default: Banglish Mirror Mode): (1) Bengali script input -> Bengali script reply. (2) Banglish/Romanized Bengali input (e.g. ki koris, khaicis, valo?) -> Banglish/Romanized Bengali reply matching their exact spelling style. (3) English input -> English reply. (4) Mixed input -> natural Mixed reply. (5) Pronoun Mirroring: তুই/tui -> তুই/tui, তুমি/tumi -> তুমি/tumi, আপনি/apni -> আপনি/apni (neutral polite if unclear). (6) Adaptive Typing Length: short message -> short 1-line reply; detailed question -> clear helpful reply. (7) Typo Tolerance & Smart Clarification: understand typos/short forms (w8, khaiso, jaiba, koros); if truly unclear, ask ONE short polite clarification question in their script — NEVER guess. (8) Reply Diversity: never repeat recent replies verbatim. (9) Context-Aware Emoji: use at most 1 natural emoji for casual/warm messages, 0 emoji for sad/serious/formal messages. (10) NEVER invent the owner\'s personal location, plans, eating status, or decisions.'
  },
  ownerStatuses: [],
  kbItems: [
    { id: 'kb-1', question: 'ZEVIAN কী?', answer: 'ZEVIAN হলো এই ফেসবুক পেজের এআই পার্সোনাল মেসেঞ্জার অ্যাসিস্ট্যান্ট, যে স্বাভাবিকভাবে কথা বলে এবং ব্যক্তিগত প্রশ্নগুলো সরাসরি Owner-এর কাছে পৌঁছে দেয়।' }
  ],
  conversations: {},
  pendingReplies: {},
  blockedUsers: [],
  stats: { totalIn: 0, totalOut: 0, autoReplied: 0, escalated: 0, ownerReplied: 0, failed: 0 },
  pendingCounter: 1000,
  statusCounter: 100
};

const PERSONAL_CUES = [
  'কোথায় আছ', 'কোথায় আছ', 'কলেজে যাব', 'খেয়েছিস', 'খেয়েছিস', 'খেয়েছো', 'খেয়েছো',
  'ফোন দিবো', 'ফোন দেবো', 'ফোন দিতে পারি', 'আজকে আসব', 'কালকে আসব', 'দেখা করতে পারব',
  'বাসায় আছ', 'বাসায় আছ', 'কখন আসব', 'চিনতে পারছ', 'তুমি কি রাজি', 'kothay ach',
  'phone dibo', 'kalke asb', 'kalke jaba', 'basay ach', 'ki diye kheye', 'khaichis', 'khaicis', 'khaiso'
];
const STATUS_CUES = [
  'বাইরে যাচ্ছি', 'ব্যস্ত আছি', 'ব্যস্ত থাকব', 'কলেজে যাচ্ছি', 'খেয়ে নিয়েছি', 'খেয়ে নিয়েছি',
  'অনলাইনে থাকব না', 'পাওয়া যাবে না', 'পাওয়া যাবে না', 'ঘুমাচ্ছি', 'বাসায় আছি', 'বাসায় আছি'
];

const processedIds = new Set();
let activeReplyPendingId = null, pendingDraftStatus = null, lastGeminiError = null, tgBot = null;

function getActiveStatuses() {
  const now = Date.now();
  state.ownerStatuses.forEach(s => { if (s.active && s.expiresAt && now > s.expiresAt) s.active = false; });
  return state.ownerStatuses.filter(s => s.active && s.visibility === 'shareable');
}

function addStatus(text, vis, mins) {
  state.statusCounter += 1;
  const st = {
    id: `ST-${state.statusCounter}`,
    text: text.trim(),
    visibility: vis === 'private' ? 'private' : 'shareable',
    active: true,
    expiresAt: mins ? Date.now() + mins * 60000 : null,
    expiresLabel: mins ? `${mins}m` : 'Manual'
  };
  state.ownerStatuses.unshift(st);
  return st;
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
    if (d && d.error) state.stats.failed += 1;
    else state.stats.totalOut += 1;
    return d;
  } catch (e) { state.stats.failed += 1; return { error: e.message }; }
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
      psid, senderName: name || `User ${psid.slice(-4)}`, lastUserAt: Date.now(),
      prefs: { script: 'auto', pronoun: 'auto', spellingNotes: [] }, summary: '', messages: []
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
  const hasBanglish = /\b(ki|koris|koros|korteso|kemon|acho|aso|valo|bhalo|tui|tumi|apni|kothay|koi|khobor|kalke|ajke|khaisi|khaichi|khaicis|khaiso|jabo|jaimu|jaba|jabi|bujhi|w8|plz|hmm|accha|bhai)\b/.test(low);
  if (hasBn && hasEn) conv.prefs.script = 'Mixed (Bangla+English)';
  else if (hasBn) conv.prefs.script = 'Bengali Script';
  else if (hasBanglish) conv.prefs.script = 'Banglish (Romanized Bengali)';
  else if (hasEn) conv.prefs.script = 'English';

  if (/\b(tui|tor|koris|koros|achis|khaichis|khaicis|jabi|asbi)\b/.test(low) || /(তুই|তোর|করিস|আছিস|খেয়েছিস|খেয়েছিস|খাইছিস|যাবি|আসবি)/.test(t)) {
    conv.prefs.pronoun = 'তুই (casual)';
  } else if (/\b(apni|apnar|korchen|achen)\b/.test(low) || /(আপনি|আপনার|করছেন|আছেন)/.test(t)) {
    conv.prefs.pronoun = 'আপনি (formal)';
  } else if (/\b(tumi|tomar|korcho|acho|jaba|jabe)\b/.test(low) || /(তুমি|তোমার|করছ|আছো|যাবে)/.test(t)) {
    conv.prefs.pronoun = 'তুমি (friendly)';
  }
  const tokens = low.match(/\b(khaisi|khaichi|khaicis|khaiso|jabo|jaimu|koris|koros|valo|bhalo)\b/g);
  if (tokens) {
    tokens.forEach(tk => { if (!conv.prefs.spellingNotes.includes(tk)) conv.prefs.spellingNotes.push(tk); });
    if (conv.prefs.spellingNotes.length > 8) conv.prefs.spellingNotes = conv.prefs.spellingNotes.slice(-8);
  }
}

function pushMsg(psid, role, text) {
  const c = getConv(psid);
  if (role === 'User') { c.lastUserAt = Date.now(); detectStyle(text, c); }
  c.messages.push({ role, text, time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) });
  if (c.messages.length > 22) {
    const older = c.messages.slice(0, 4).map(m => `${m.role}: ${m.text}`).join(' | ');
    c.summary = ((c.summary ? c.summary + ' ; ' : '') + older).slice(-400);
    c.messages = c.messages.slice(-18);
  }
}

async function analyzeMessage(psid, userText) {
  if (!GEMINI_API_KEY) { lastGeminiError = 'Missing GEMINI_API_KEY'; return null; }
  const conv = getConv(psid);
  const history = conv.messages.slice(-10).map(m => `${m.role}: ${m.text}`).join('\n');
  const recentBotReplies = conv.messages.filter(m => m.role === 'ZEVIAN').slice(-3).map(m => m.text).join(' | ');
  const activeSt = getActiveStatuses();
  const stBlock = activeSt.length ? activeSt.map(s => `- ${s.text}`).join('\n') : '(None)';
  const kbBlock = state.kbItems.map(i => `Q: ${i.question} | A: ${i.answer}`).join('\n');

  const prompt = `${state.config.systemPrompt}
Owner Display Name: ${state.config.ownerDisplayName}
Sender Profile -> Script: ${conv.prefs.script} | Pronoun: ${conv.prefs.pronoun} | Preferred Banglish words: ${conv.prefs.spellingNotes.join(', ') || 'none'}
Recent ZEVIAN Replies (DO NOT repeat these verbatim): ${recentBotReplies || '(None)'}
Approved Active Shareable Owner Statuses (use ONLY if directly relevant):
${stBlock}
Approved Knowledge Base:
${kbBlock}
Earlier Summary: ${conv.summary || '(None)'}
Recent Chat:
${history || '(New conversation)'}
Latest User Message: "${userText}"

Instructions:
1. Classify into ONE of: GENERAL, PERSONAL, UNCERTAIN, SENSITIVE, URGENT, COMPLAINT, SPAM, FOLLOW_UP.
2. STRICT SCRIPT MIRRORING:
   - If the user wrote in Banglish/Romanized Bengali (e.g. "ki koris?", "valo?", "khaicis?"), your reply MUST be in Banglish/Romanized Bengali!
   - If Bengali script, reply in Bengali script. If English, reply in English. If Mixed, reply in Mixed.
3. If an Approved Active Status directly answers a personal/activity question, set classification="GENERAL", requires_owner=false, and reply naturally in the user's exact script & pronoun using that approved status.
4. If the message is gibberish/unclear typo with no clear meaning (e.g. "krst" or "oi ta niye ki korli?" with no context), set classification="GENERAL", requires_owner=false, and ask ONE short polite clarification question in the user's script.
5. If PERSONAL (owner's plans/location/eating/college/calls without active status), SENSITIVE, URGENT, or COMPLAINT: set requires_owner=true, suggested_reply="", and provide 3-4 natural optional replies in "owner_suggestions" matching the user's script & pronoun.
Return ONLY valid JSON: {"classification":"GENERAL","confidence":0.95,"requires_owner":false,"reason":"...","suggested_reply":"...","owner_suggestions":["...","...","..."]}`;

  const models = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash', 'gemini-3.8-flash'];
  for (const m of models) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7, responseMimeType: 'application/json' } })
      });
      const d = await res.json();
      if (!res.ok) { lastGeminiError = `${m} HTTP ${res.status}: ${d.error ? d.error.message : 'Error'}`; continue; }
      const raw = d.candidates?.[0]?.content?.parts?.[0]?.text;
      if (raw) { lastGeminiError = null; return JSON.parse(raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim()); }
    } catch (e) { lastGeminiError = `${m}: ${e.message}`; }
  }
  return null;
}

function escalate(psid, name, q, cls, reason, suggs = []) {
  state.pendingCounter += 1; state.stats.escalated += 1;
  const pid = `PR-${state.pendingCounter}`;
  const clean = Array.isArray(suggs) && suggs.length ? suggs.slice(0, 4) : ['হ্যাঁ, ঠিক আছে।', 'না, এখন না।', 'একটু পরে জানাচ্ছি।'];
  state.pendingReplies[pid] = { id: pid, psid, senderName: name, question: q, classification: cls, reason, suggestions: clean, status: 'WAITING' };
  if (tgBot && ADMIN_CHAT_ID) {
    const sLines = clean.map((s, i) => `${i + 1}. ${s}`).join('\n');
    const sRow = clean.map((_, i) => ({ text: `✅ #${i + 1}`, callback_data: `sugg:${pid}:${i}` }));
    tgBot.sendMessage(ADMIN_CHAT_ID, `🚨 *ZEVIAN — ${cls} QUESTION*\n\n🆔 \`${pid}\` | 👤 ${name}\n💬 PSID: \`${psid}\`\n💡 ${reason}\n\n❓ *Message:*\n${q}\n\n✨ *AI Suggestions (1-Tap Send):*\n${sLines}`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          sRow,
          [{ text: '✍️ Custom Reply', callback_data: `reply:${pid}` }, { text: '🔄 Regenerate', callback_data: `regen:${pid}` }],
          [{ text: '💬 History', callback_data: `view:${psid}` }, { text: '🚫 Ignore', callback_data: `ignore:${pid}` }, { text: '⛔ Block', callback_data: `block:${psid}` }]
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

        if (!ev.message?.text && ev.message?.attachments?.length) {
          const att = ev.message.attachments[0];
          if (att.type === 'image' && ev.message.sticker_id) {
            await callGraph('me/messages', { recipient: { id: psid }, message: { text: '😊' } });
          } else {
            escalate(psid, name, `[${att.type.toUpperCase()}] ${att.payload?.url || ''}`, 'UNCERTAIN', `User sent ${att.type} media`, ['দেখলাম, ধন্যবাদ!', 'একটু পরে দেখে/শুনে জানাচ্ছি।']);
          }
          continue;
        }
        const text = ev.message?.text;
        if (!text) continue;
        pushMsg(psid, 'User', text);
        await callGraph('me/messages', { recipient: { id: psid }, sender_action: 'typing_on' });
        const ai = await analyzeMessage(psid, text);
        const low = text.toLowerCase();
        if (PERSONAL_CUES.some(c => low.includes(c)) && getActiveStatuses().length === 0) {
          const holdMsg = conv.prefs.script.includes('Banglish')
            ? 'Ei proshnotar uttor amar Owner dite parben. Ektu wait koro 🙂'
            : conv.prefs.script === 'English'
            ? 'Only my Owner can answer this. Please wait a moment 🙂'
            : 'এই প্রশ্নটির উত্তর আমার Owner দিতে পারবেন। একটু অপেক্ষা করো 🙂';
          await callGraph('me/messages', { recipient: { id: psid }, message: { text: holdMsg } });
          escalate(psid, name, text, 'PERSONAL', 'Personal question (no active status)', ai ? ai.owner_suggestions : []);
          continue;
        }
        if (!ai) { escalate(psid, name, text, 'UNCERTAIN', `Gemini error: ${lastGeminiError}`); continue; }
        const cls = (ai.classification || 'UNCERTAIN').toUpperCase();
        if (cls === 'SPAM') continue;
        if ((cls === 'GENERAL' || cls === 'FOLLOW_UP') && !ai.requires_owner && Number(ai.confidence || 0) >= state.config.confidenceThreshold && ai.suggested_reply) {
          const rep = ai.suggested_reply.trim();
          await callGraph('me/messages', { recipient: { id: psid }, message: { text: rep } });
          pushMsg(psid, 'ZEVIAN', rep); state.stats.autoReplied += 1;
          if (tgBot && ADMIN_CHAT_ID) tgBot.sendMessage(ADMIN_CHAT_ID, `💬 *ZEVIAN (${cls})*\n👤 ${name} [${conv.prefs.script} | ${conv.prefs.pronoun}]\n📩 ${text}\n🤖 ${rep}`, { parse_mode: 'Markdown' }).catch(() => {});
        } else {
          if (cls === 'PERSONAL') {
            const holdMsg = conv.prefs.script.includes('Banglish') ? 'Ei proshnotar uttor amar Owner dite parben. Ektu wait koro 🙂' : 'এই প্রশ্নটির উত্তর আমার Owner দিতে পারবেন। একটু অপেক্ষা করো 🙂';
            await callGraph('me/messages', { recipient: { id: psid }, message: { text: holdMsg } });
          }
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
          const rep = (ai && ai.suggested_reply) || `ধন্যবাদ ${fn}! কীভাবে সাহায্য করতে পারি?`;
          if (state.config.commentReplyEnabled) await callGraph(`${cid}/comments`, { message: `ধন্যবাদ ${fn}! আপনার ইনবক্সে বিস্তারিত পাঠিয়ে দেওয়া হয়েছে 😊` });
          if (state.config.commentInboxEnabled) await callGraph(`${pageId}/messages`, { recipient: { comment_id: cid }, message: { text: rep } });
        }
      }
    }
  }
});

if (BOT_TOKEN) {
  tgBot = new TelegramBot(BOT_TOKEN, { polling: true });

  // Register native Telegram Slash Command Menu automatically!
  tgBot.setMyCommands([
    { command: 'start', description: 'ZEVIAN কন্ট্রোল প্যানেল খুলুন' },
    { command: 'status', description: 'সিস্টেম ও বটের বর্তমান অবস্থা দেখুন' },
    { command: 'help', description: 'কোন কমান্ড দিয়ে কী কাজ হয় তা দেখুন' },
    { command: 'pending', description: 'অপেক্ষমাণ (Pending) প্রশ্নগুলো দেখুন' },
    { command: 'inbox', description: 'সাম্প্রতিক চ্যাট ও ইউজার স্টাইল দেখুন' },
    { command: 'setstatus', description: 'নতুন Live Owner Status সেট করুন' },
    { command: 'mystatus', description: 'বর্তমানে চালু থাকা Status দেখুন' },
    { command: 'clearstatus', description: 'সব Active Status বন্ধ করুন' },
    { command: 'reply', description: 'নির্দিষ্ট প্রশ্নে উত্তর পাঠান' },
    { command: 'ignore', description: 'কোনো পেন্ডিং প্রশ্ন বাদ দিন' },
    { command: 'history', description: 'ইউজারের চ্যাট হিস্ট্রি দেখুন' },
    { command: 'memory', description: 'মেমোরি স্ট্যাটাস দেখুন বা ক্লিয়ার করুন' },
    { command: 'addkb', description: 'FAQ / Knowledge Base-এ তথ্য যোগ করুন' },
    { command: 'setprompt', description: 'AI-এর নির্দেশনা (Prompt) বদলান' },
    { command: 'block', description: 'নির্দিষ্ট ইউজারকে ব্লক করুন' },
    { command: 'unblock', description: 'ব্লক করা ইউজার আনব্লক করুন' },
    { command: 'analytics', description: 'মেসেজ ও রিপ্লাইয়ের পরিসংখ্যান দেখুন' },
    { command: 'testgemini', description: 'Gemini ও Banglish Mirror টেস্ট করুন' }
  ]).catch(() => {});

  const isOwner = cid => !ADMIN_CHAT_ID || String(cid) === String(ADMIN_CHAT_ID);
  const sendMenu = cid => {
    const wait = Object.values(state.pendingReplies).filter(p => p.status === 'WAITING').length;
    const act = getActiveStatuses();
    tgBot.sendMessage(cid, `🤖 *ZEVIAN v4.5 Ultimate Control Center*\n• Master: ${state.config.masterActive ? '✅ ON' : '⏸ PAUSED'} | Mode: *Banglish Mirror*\n• Gemini: ${lastGeminiError ? '⚠️ Error (/testgemini)' : '✅ Ready'}\n• Active Status: _${act.length ? act[0].text : 'কোনো Status নেই'}_\n• Active Chats: ${Object.keys(state.conversations).length} | Pending: ${wait} | Auto: ${state.stats.autoReplied}`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: state.config.masterActive ? '⏸ Pause Bot' : '▶️ Resume Bot', callback_data: 'toggle' }, { text: '📋 Pending List', callback_data: 'list_pending' }],
          [{ text: '📍 My Status', callback_data: 'show_st' }, { text: '📊 Analytics', callback_data: 'show_an' }],
          [{ text: '📖 সব কমান্ড (/help)', callback_data: 'show_help' }, { text: '🧹 Clear Memory', callback_data: 'clear_mem' }]
        ]
      }
    });
  };

  const sendHelp = cid => {
    const txt = `📖 *ZEVIAN — কোন কমান্ড দিয়ে কী কাজ হয়:*\n\n` +
      `🎛️ *প্যানেল ও স্ট্যাটাস:*\n` +
      `• /start বা /status — মূল কন্ট্রোল প্যানেল ও লাইভ স্ট্যাটাস দেখুন\n` +
      `• /analytics — মোট ইনকামিং, AI রিপ্লাই ও মালিকের রিপ্লাই রিপোর্ট\n` +
      `• /testgemini — Gemini AI ও Banglish Mirror মোড টেস্ট করুন\n\n` +
      `📍 *Live Owner Status (অটো-এক্সপায়ারি):*\n` +
      `• \`/setstatus আমি বাইরে যাচ্ছি\` — নতুন স্ট্যাটাস সেট করুন (অথবা সরাসরি মেসেজ লিখুন)\n` +
      `• /mystatus — বর্তমানে চালু থাকা Status দেখুন\n` +
      `• /clearstatus — সব Active Status বন্ধ করুন\n\n` +
      `💬 *ইনবক্স ও পেন্ডিং প্রশ্ন কন্ট্রোল:*\n` +
      `• /pending — যেসব প্রশ্নে আপনার উত্তর লাগবে সেগুলো দেখুন\n` +
      `• \`/reply PR-1001 আপনার উত্তর\` — নির্দিষ্ট প্রশ্নে মেসেঞ্জারে উত্তর পাঠান\n` +
      `• \`/ignore PR-1001\` — পেন্ডিং প্রশ্ন বাদ দিন\n` +
      `• /inbox — সাম্প্রতিক চ্যাট ও প্রতিটি ইউজারের ভাষা/প্রোনাউন দেখুন\n` +
      `• \`/history <PSID>\` — নির্দিষ্ট ইউজারের আগের চ্যাট হিস্ট্রি দেখুন\n\n` +
      `🧠 *মেমোরি, FAQ ও সিকিউরিটি:*\n` +
      `• /memory — মেমোরি ও ইউজার প্রোফাইল দেখুন\n` +
      `• \`/addkb প্রশ্ন | উত্তর\` — Knowledge Base-এ নতুন FAQ যুক্ত করুন\n` +
      `• \`/setprompt নতুন নির্দেশনা\` — AI-এর কথা বলার ধরন বদলান\n` +
      `• \`/block <PSID>\` এবং \`/unblock <PSID>\` — ইউজার ব্লক/আনব্লক করুন`;
    tgBot.sendMessage(cid, txt, { parse_mode: 'Markdown' });
  };

  const askStatus = (cid, txt) => {
    pendingDraftStatus = txt.trim();
    tgBot.sendMessage(cid, `📍 *এই তথ্যটি Active Status হিসেবে রাখব?*\n\n_"${pendingDraftStatus}"_`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '✅ Share (1h)', callback_data: 'st:share:60' }, { text: '✅ Share (3h)', callback_data: 'st:share:180' }], [{ text: '✅ Share (6h)', callback_data: 'st:share:360' }, { text: '🔒 Keep Private', callback_data: 'st:private:360' }], [{ text: '❌ Cancel', callback_data: 'st:cancel' }]] }
    });
  };

  tgBot.onText(/\/(start|panel|status)$/, m => isOwner(m.chat.id) && sendMenu(m.chat.id));
  tgBot.onText(/\/help/i, m => isOwner(m.chat.id) && sendHelp(m.chat.id));
  tgBot.onText(/\/analytics/, m => isOwner(m.chat.id) && tgBot.sendMessage(m.chat.id, `📊 *ZEVIAN Analytics*\n• Incoming: ${state.stats.totalIn}\n• Outgoing: ${state.stats.totalOut}\n• Auto-Replied (AI): ${state.stats.autoReplied}\n• Escalated to Owner: ${state.stats.escalated}\n• Owner Replies: ${state.stats.ownerReplied}\n• Failed: ${state.stats.failed}`, { parse_mode: 'Markdown' }));
  tgBot.onText(/\/mystatus/, m => { if (!isOwner(m.chat.id)) return; const l = getActiveStatuses(); tgBot.sendMessage(m.chat.id, l.length ? `📍 *Active Shareable Statuses:*\n` + l.map(s => `• \`${s.id}\`: ${s.text} (${s.expiresLabel})`).join('\n') : '📍 কোনো Active Status নেই। সেট করতে লিখুন: `/setstatus আমি বাইরে যাচ্ছি`', { parse_mode: 'Markdown' }); });
  tgBot.onText(/\/clearstatus/, m => { if (!isOwner(m.chat.id)) return; state.ownerStatuses.forEach(s => { s.active = false; }); tgBot.sendMessage(m.chat.id, '🛑 সব Active Status বন্ধ করা হয়েছে।'); });
  tgBot.onText(/\/setstatus ([\s\S]+)/, (m, match) => isOwner(m.chat.id) && askStatus(m.chat.id, match[1]));
  tgBot.onText(/\/inbox/, m => { if (!isOwner(m.chat.id)) return; const l = Object.values(state.conversations).slice(-8); tgBot.sendMessage(m.chat.id, l.length ? l.map(c => `👤 *${c.senderName}* (\`${c.psid}\`)\n🗣️ ${c.prefs.script} | ${c.prefs.pronoun}\n└ ${c.messages[c.messages.length - 1]?.text || ''}`).join('\n\n') : '💬 কোনো চ্যাট নেই।', { parse_mode: 'Markdown' }); });
  tgBot.onText(/\/history (\S+)/, (m, match) => { if (!isOwner(m.chat.id)) return; const c = state.conversations[match[1].trim()]; tgBot.sendMessage(m.chat.id, c ? `💬 *${c.senderName} History:*\n` + c.messages.slice(-12).map(x => `[${x.time}] *${x.role}:* ${x.text}`).join('\n') : '⚠️ এই PSID-র কোনো হিস্ট্রি পাওয়া যায়নি।', { parse_mode: 'Markdown' }); });
  tgBot.onText(/\/memory/, m => { if (!isOwner(m.chat.id)) return; tgBot.sendMessage(m.chat.id, `🧠 *ZEVIAN Memory Status*\n• Saved Conversations: ${Object.keys(state.conversations).length}\n• Active Statuses: ${getActiveStatuses().length}\n• Knowledge Base Items: ${state.kbItems.length}\n• Blocked Users: ${state.blockedUsers.length}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🧹 Clear Conversation Memory', callback_data: 'clear_mem' }]] } }); });
  tgBot.onText(/\/testgemini/, async m => { if (!isOwner(m.chat.id)) return; const r = await analyzeMessage('test_bn', 'ki koris?'); tgBot.sendMessage(m.chat.id, r ? `✅ *Gemini v4.5 OK (Banglish Mirror)!*\nInput: \`ki koris?\`\nClass: \`${r.classification}\`\nReply: ${r.suggested_reply}` : `❌ Error: \`${lastGeminiError}\``, { parse_mode: 'Markdown' }); });
  tgBot.onText(/\/pending/, m => { if (!isOwner(m.chat.id)) return; const l = Object.values(state.pendingReplies).filter(p => p.status === 'WAITING'); if (!l.length) return tgBot.sendMessage(m.chat.id, '✅ কোনো Pending প্রশ্ন নেই!'); l.forEach(p => tgBot.sendMessage(m.chat.id, `🆔 \`${p.id}\` | 👤 ${p.senderName}\n❓ ${p.question}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✍️ Reply', callback_data: `reply:${p.id}` }, { text: '🚫 Ignore', callback_data: `ignore:${p.id}` }]] } })); });
  tgBot.onText(/\/addkb ([\s\S]+)/, (m, match) => { if (!isOwner(m.chat.id)) return; const p = match[1].split('|'); state.kbItems.unshift({ id: `kb-${Date.now()}`, question: (p[0] || '').trim(), answer: (p[1] || p[0] || '').trim() }); tgBot.sendMessage(m.chat.id, '✅ FAQ / Knowledge Base-এ যুক্ত হয়েছে!'); });
  tgBot.onText(/\/setprompt ([\s\S]+)/, (m, match) => { if (!isOwner(m.chat.id)) return; state.config.systemPrompt = match[1].trim(); tgBot.sendMessage(m.chat.id, '✅ System Prompt আপডেট হয়েছে!'); });
  tgBot.onText(/\/ignore (\S+)/, (m, match) => { if (!isOwner(m.chat.id)) return; const pid = match[1].trim(); if (state.pendingReplies[pid]) { state.pendingReplies[pid].status = 'IGNORED'; tgBot.sendMessage(m.chat.id, `🚫 \`${pid}\` ইগনোর হয়েছে।`, { parse_mode: 'Markdown' }); } });
  tgBot.onText(/\/block (\S+)/, (m, match) => { if (!isOwner(m.chat.id)) return; const u = match[1].trim(); if (!state.blockedUsers.includes(u)) state.blockedUsers.push(u); tgBot.sendMessage(m.chat.id, `⛔ \`${u}\` ব্লক হয়েছে।`, { parse_mode: 'Markdown' }); });
  tgBot.onText(/\/unblock (\S+)/, (m, match) => { if (!isOwner(m.chat.id)) return; const u = match[1].trim(); state.blockedUsers = state.blockedUsers.filter(x => x !== u); tgBot.sendMessage(m.chat.id, `✅ \`${u}\` আনব্লক হয়েছে।`, { parse_mode: 'Markdown' }); });
  tgBot.onText(/\/reply (\S+) ([\s\S]+)/, async (m, match) => { if (!isOwner(m.chat.id)) return; const t = match[1].trim(), pid = state.pendingReplies[t] ? t : null, psid = pid ? state.pendingReplies[pid].psid : t; const ok = await sendOwnerReply(psid, match[2].trim(), pid); tgBot.sendMessage(m.chat.id, ok ? '✅ উত্তর সফলভাবে পাঠানো হয়েছে!' : '❌ পাঠানো যায়নি।'); });

  tgBot.on('message', async m => {
    if (!isOwner(m.chat.id) || !m.text || m.text.startsWith('/')) return;
    const txt = m.text.trim();
    if (activeReplyPendingId) {
      const pid = activeReplyPendingId; activeReplyPendingId = null;
      const item = state.pendingReplies[pid];
      if (!item || item.status !== 'WAITING') return tgBot.sendMessage(m.chat.id, '⚠️ এই প্রশ্নটি ইতিমধ্যেই সম্পন্ন।');
      const ok = await sendOwnerReply(item.psid, txt, pid);
      return tgBot.sendMessage(m.chat.id, ok ? `✅ আপনার উত্তর *${item.senderName}*-কে পাঠানো হয়েছে!` : '❌ পাঠানো যায়নি।', { parse_mode: 'Markdown' });
    }
    if (STATUS_CUES.some(c => txt.includes(c))) askStatus(m.chat.id, txt);
  });

  tgBot.on('callback_query', async q => {
    const cid = q.message.chat.id;
    if (!isOwner(cid)) return;
    const d = q.data || '';
    if (d === 'toggle') { state.config.masterActive = !state.config.masterActive; sendMenu(cid); }
    else if (d === 'show_help') { sendHelp(cid); }
    else if (d === 'clear_mem') { state.conversations = {}; tgBot.sendMessage(cid, '🧹 সব কনভারসেশন মেমোরি ক্লিয়ার করা হয়েছে।'); }
    else if (d === 'show_st') { const l = getActiveStatuses(); tgBot.sendMessage(cid, l.length ? l.map(s => `📍 ${s.id}: ${s.text} (${s.expiresLabel})`).join('\n') : '📍 কোনো Active Status নেই।'); }
    else if (d === 'show_an') { tgBot.sendMessage(cid, `📊 In: ${state.stats.totalIn} | Out: ${state.stats.totalOut} | Auto-AI: ${state.stats.autoReplied} | Escalated: ${state.stats.escalated} | Owner: ${state.stats.ownerReplied}`); }
    else if (d === 'list_pending') { const l = Object.values(state.pendingReplies).filter(p => p.status === 'WAITING'); tgBot.sendMessage(cid, l.length ? l.map(p => `• ${p.id} (${p.senderName}): ${p.question}`).join('\n') : '✅ কোনো Pending প্রশ্ন নেই।'); }
    else if (d === 'st:cancel') { pendingDraftStatus = null; tgBot.sendMessage(cid, '❌ বাতিল হয়েছে।'); }
    else if (d.startsWith('st:')) { const [, vis, mins] = d.split(':'); if (pendingDraftStatus) { const st = addStatus(pendingDraftStatus, vis, Number(mins)); pendingDraftStatus = null; tgBot.sendMessage(cid, `✅ Status *${st.id}* (${st.visibility}, ${st.expiresLabel}) চালু হয়েছে!\n_"${st.text}"_`, { parse_mode: 'Markdown' }); } }
    else if (d.startsWith('sugg:')) { const [, pid, idx] = d.split(':'); const it = state.pendingReplies[pid]; const ch = it && it.suggestions && it.suggestions[Number(idx)]; if (it && it.status === 'WAITING' && ch) { const ok = await sendOwnerReply(it.psid, ch, pid); tgBot.sendMessage(cid, ok ? `✅ 1-Tap উত্তর *${it.senderName}*-কে পাঠানো হয়েছে:\n_"${ch}"_` : '❌ পাঠানো যায়নি', { parse_mode: 'Markdown' }); } }
    else if (d.startsWith('regen:')) { const pid = d.split(':')[1], it = state.pendingReplies[pid]; if (it && it.status === 'WAITING') { const ai = await analyzeMessage(it.psid, it.question); if (ai && ai.owner_suggestions && ai.owner_suggestions.length) { it.suggestions = ai.owner_suggestions.slice(0, 4); const sRow = it.suggestions.map((_, i) => ({ text: `✅ #${i + 1}`, callback_data: `sugg:${pid}:${i}` })); tgBot.sendMessage(cid, `🔄 *নতুন সাজেশন (${pid}):*\n` + it.suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n'), { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [sRow] } }); } } }
    else if (d.startsWith('reply:')) { const pid = d.split(':')[1]; if (state.pendingReplies[pid]?.status === 'WAITING') { activeReplyPendingId = pid; tgBot.sendMessage(cid, `✍️ *${state.pendingReplies[pid].senderName}*-এর প্রশ্নের (${pid}) উত্তর সরাসরি লিখুন:`, { parse_mode: 'Markdown' }); } }
    else if (d.startsWith('ignore:')) { const pid = d.split(':')[1]; if (state.pendingReplies[pid]) { state.pendingReplies[pid].status = 'IGNORED'; tgBot.sendMessage(cid, `🚫 ${pid} ইগনোর হয়েছে।`); } }
    else if (d.startsWith('block:')) { const u = d.split(':')[1]; if (!state.blockedUsers.includes(u)) state.blockedUsers.push(u); tgBot.sendMessage(cid, `⛔ ${u} ব্লক হয়েছে।`); }
    else if (d.startsWith('view:')) { const u = d.split(':')[1], c = state.conversations[u]; tgBot.sendMessage(cid, c ? c.messages.slice(-10).map(m => `[${m.time}] *${m.role}:* ${m.text}`).join('\n') : 'হিস্ট্রি নেই।', { parse_mode: 'Markdown' }); }
    tgBot.answerCallbackQuery(q.id, { text: 'OK' });
  });
}

app.get('/health', (req, res) => res.json({ ok: true, version: '4.5.0', mode: 'banglish_mirror', masterActive: state.config.masterActive, geminiOk: !lastGeminiError, activeStatuses: getActiveStatuses().length, pendingCount: Object.values(state.pendingReplies).filter(p => p.status === 'WAITING').length, uptime: Math.floor(process.uptime()) }));
app.get('/', (req, res) => res.send(`<html><body style="font-family:sans-serif;background:#070b14;color:#f1f5f9;padding:30px"><h2>🤖 ZEVIAN v4.5 Ultimate (Banglish Mirror Mode)</h2><p>Master: <b>${state.config.masterActive ? 'ACTIVE' : 'PAUSED'}</b> | Gemini: <b>${lastGeminiError ? 'ERROR' : 'READY'}</b> | Active Statuses: <b>${getActiveStatuses().length}</b></p><p><a style="color:#818cf8" href="/health">/health</a></p></body></html>`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('ZEVIAN v4.5 Ultimate running on port', PORT));
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
    pageDmEnabled: true,
    commentReplyEnabled: true,
    commentInboxEnabled: true,
    confidenceThreshold: 0.72,
    defaultTone: 'Casual & Friendly',
    systemPrompt: 'You are ZEVIAN, a natural, warm, friend-like AI personal Messenger assistant for this Facebook Page. Match the sender language (Bengali, English, or Banglish) and pronoun style (তুই -> তুই, তুমি -> তুমি, আপনি -> আপনি). Be concise (1-3 sentences) and conversational with light emojis. NEVER invent personal plans, location, eating status, or decisions.'
  },
  ownerStatuses: [],
  kbItems: [{ id: 'kb-1', question: 'ZEVIAN কী?', answer: 'ZEVIAN হলো এই ফেসবুক পেজের এআই পার্সোনাল মেসেঞ্জার অ্যাসিস্ট্যান্ট।' }],
  conversations: {},
  pendingReplies: {},
  blockedUsers: [],
  stats: { totalIn: 0, autoReplied: 0, escalated: 0, ownerReplied: 0 },
  pendingCounter: 1000,
  statusCounter: 100
};

const PERSONAL_CUES = ['কোথায় আছ', 'কোথায় আছ', 'কলেজে যাব', 'খেয়েছিস', 'খেয়েছিস', 'খেয়েছো', 'খেয়েছো', 'ফোন দিবো', 'ফোন দেবো', 'ফোন দিতে পারি', 'আজকে আসব', 'কালকে আসব', 'দেখা করতে পারব', 'বাসায় আছ', 'বাসায় আছ', 'কখন আসব', 'চিনতে পারছ', 'তুমি কি রাজি', 'kothay ach', 'phone dibo', 'kalke asb', 'basay ach', 'ki diye kheye', 'khaichis'];
const STATUS_CUES = ['বাইরে যাচ্ছি', 'ব্যস্ত আছি', 'ব্যস্ত থাকব', 'কলেজে যাচ্ছি', 'খেয়ে নিয়েছি', 'খেয়ে নিয়েছি', 'অনলাইনে থাকব না', 'পাওয়া যাবে না', 'পাওয়া যাবে না', 'ঘুমাচ্ছি'];

const processedIds = new Set();
let activeReplyPendingId = null, pendingDraftStatus = null, lastGeminiError = null, tgBot = null;

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
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${endpoint}?access_token=${encodeURIComponent(PAGE_TOKEN)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return res.json();
  } catch (e) { return { error: e.message }; }
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
  if (!state.conversations[psid]) state.conversations[psid] = { psid, senderName: name || `User ${psid.slice(-4)}`, lastUserAt: Date.now(), prefs: { language: 'auto', pronoun: 'auto' }, messages: [] };
  else if (name && state.conversations[psid].senderName.startsWith('User ')) state.conversations[psid].senderName = name;
  return state.conversations[psid];
}

function detectStyle(text, conv) {
  const t = text || '', low = t.toLowerCase();
  if (/[\u0980-\u09FF]/.test(t)) conv.prefs.language = 'bn';
  else if (/\b(ki|koris|kemon|acho|valo|tui|tumi|apni|kothay|khobor|kalke|ajke)\b/.test(low)) conv.prefs.language = 'banglish';
  else if (/[a-zA-Z]{3,}/.test(t)) conv.prefs.language = 'en';
  if (/\b(tui|tor|koris|achis|khaichis|jabi|asbi)\b/.test(low) || /(তুই|তোর|করিস|আছিস|খেয়েছিস|খেয়েছিস|যাবি|আসবি)/.test(t)) conv.prefs.pronoun = 'তুই (casual)';
  else if (/\b(apni|apnar|korchen|achen)\b/.test(low) || /(আপনি|আপনার|করছেন|আছেন)/.test(t)) conv.prefs.pronoun = 'আপনি (formal)';
  else if (/\b(tumi|tomar|korcho|acho)\b/.test(low) || /(তুমি|তোমার|করছ|আছো)/.test(t)) conv.prefs.pronoun = 'তুমি (friendly)';
}

function pushMsg(psid, role, text) {
  const c = getConv(psid);
  if (role === 'User') { c.lastUserAt = Date.now(); detectStyle(text, c); }
  c.messages.push({ role, text, time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) });
  if (c.messages.length > 20) c.messages = c.messages.slice(-20);
}

async function analyzeMessage(psid, userText) {
  if (!GEMINI_API_KEY) { lastGeminiError = 'Missing GEMINI_API_KEY'; return null; }
  const conv = getConv(psid);
  const history = conv.messages.slice(-10).map(m => `${m.role}: ${m.text}`).join('\n');
  const activeSt = getActiveStatuses();
  const stBlock = activeSt.length ? activeSt.map(s => `- ${s.text}`).join('\n') : '(None)';
  const kbBlock = state.kbItems.map(i => `Q: ${i.question} | A: ${i.answer}`).join('\n');
  const prompt = `${state.config.systemPrompt}\nOwner: ${state.config.ownerDisplayName} | Sender Style: ${conv.prefs.language}, ${conv.prefs.pronoun}\nApproved Active Owner Status:\n${stBlock}\nKnowledge Base:\n${kbBlock}\nRecent Chat:\n${history || '(New)'}\nLatest User Message: "${userText}"\nClassify into ONE of: GENERAL, PERSONAL, UNCERTAIN, SENSITIVE, URGENT, COMPLAINT, SPAM, FOLLOW_UP.\n- If Approved Active Status answers the question, set classification="GENERAL", requires_owner=false, reply naturally using that status.\n- If PERSONAL/UNCERTAIN/SENSITIVE/URGENT without active status, set requires_owner=true, suggested_reply="", and provide 3-4 short replies in owner_suggestions (array) matching the user's language and pronoun.\n- If GENERAL casual chat, set requires_owner=false and write a warm friend-like reply in suggested_reply.\nReturn ONLY valid JSON: {"classification":"GENERAL","confidence":0.95,"requires_owner":false,"reason":"...","suggested_reply":"...","owner_suggestions":["...","...","..."]}`;

  const models = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash', 'gemini-3.8-flash'];
  for (const m of models) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.65, responseMimeType: 'application/json' } })
      });
      const d = await res.json();
      if (!res.ok) { lastGeminiError = `${m} HTTP ${res.status}: ${d.error ? d.error.message : 'Error'}`; continue; }
      const raw = d.candidates?.[0]?.content?.parts?.[0]?.text;
      if (raw) { lastGeminiError = null; return JSON.parse(raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim()); }
    } catch (e) { lastGeminiError = `${m}: ${e.message}`; }
  }
  return null;
}

function escalate(psid, name, q, cls, reason, suggs = []) {
  state.pendingCounter += 1; state.stats.escalated += 1;
  const pid = `PR-${state.pendingCounter}`;
  const clean = Array.isArray(suggs) && suggs.length ? suggs.slice(0, 4) : ['হ্যাঁ, ঠিক আছে।', 'না, এখন না।', 'একটু পরে জানাচ্ছি।'];
  state.pendingReplies[pid] = { id: pid, psid, senderName: name, question: q, classification: cls, reason, suggestions: clean, status: 'WAITING' };
  if (tgBot && ADMIN_CHAT_ID) {
    const sLines = clean.map((s, i) => `${i + 1}. ${s}`).join('\n');
    const sRow = clean.map((_, i) => ({ text: `✅ #${i + 1}`, callback_data: `sugg:${pid}:${i}` }));
    tgBot.sendMessage(ADMIN_CHAT_ID, `🚨 *ZEVIAN — ${cls} QUESTION*\n\n🆔 \`${pid}\` | 👤 ${name}\n💬 PSID: \`${psid}\`\n💡 ${reason}\n\n❓ *Message:*\n${q}\n\n✨ *1-Tap Suggestions:*\n${sLines}`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [sRow, [{ text: '✍️ Custom Reply', callback_data: `reply:${pid}` }, { text: '🚫 Ignore', callback_data: `ignore:${pid}` }], [{ text: '💬 History', callback_data: `view:${psid}` }, { text: '⛔ Block', callback_data: `block:${psid}` }]] }
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
        getConv(psid, name);

        if (!ev.message?.text && ev.message?.attachments?.length) {
          const att = ev.message.attachments[0];
          if (att.type === 'image' && ev.message.sticker_id) { await callGraph('me/messages', { recipient: { id: psid }, message: { text: '😊👍' } }); }
          else { escalate(psid, name, `[${att.type.toUpperCase()}] ${att.payload?.url || ''}`, 'UNCERTAIN', 'Media attachment', ['দেখলাম, ধন্যবাদ!', 'একটু পরে জানাচ্ছি।']); }
          continue;
        }
        const text = ev.message?.text;
        if (!text) continue;
        pushMsg(psid, 'User', text);
        await callGraph('me/messages', { recipient: { id: psid }, sender_action: 'typing_on' });
        const ai = await analyzeMessage(psid, text);
        const low = text.toLowerCase();
        if (PERSONAL_CUES.some(c => low.includes(c)) && getActiveStatuses().length === 0) {
          await callGraph('me/messages', { recipient: { id: psid }, message: { text: 'এই প্রশ্নটির উত্তর আমার Owner দিতে পারবেন। একটু অপেক্ষা করো 😊' } });
          escalate(psid, name, text, 'PERSONAL', 'Personal question (no active status)', ai ? ai.owner_suggestions : []);
          continue;
        }
        if (!ai) { escalate(psid, name, text, 'UNCERTAIN', `Gemini error: ${lastGeminiError}`); continue; }
        const cls = (ai.classification || 'UNCERTAIN').toUpperCase();
        if (cls === 'SPAM') continue;
        if ((cls === 'GENERAL' || cls === 'FOLLOW_UP') && !ai.requires_owner && Number(ai.confidence || 0) >= state.config.confidenceThreshold && ai.suggested_reply) {
          const rep = ai.suggested_reply.trim();
          await callGraph('me/messages', { recipient: { id: psid }, message: { text: rep } });
          pushMsg(psid, 'ZEVIAN', rep); state.stats.autoReplied += 1;
          if (tgBot && ADMIN_CHAT_ID) tgBot.sendMessage(ADMIN_CHAT_ID, `💬 *ZEVIAN (${cls})*\n👤 ${name} [${getConv(psid).prefs.language}/${getConv(psid).prefs.pronoun}]\n📩 ${text}\n🤖 ${rep}`, { parse_mode: 'Markdown' }).catch(() => {});
        } else {
          if (cls === 'PERSONAL') await callGraph('me/messages', { recipient: { id: psid }, message: { text: 'এই প্রশ্নটির উত্তর আমার Owner দিতে পারবেন। একটু অপেক্ষা করো 😊' } });
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
          const rep = (ai && ai.suggested_reply) || `ধন্যবাদ ${fn}! কীভাবে সাহায্য করতে পারি?`;
          if (state.config.commentReplyEnabled) await callGraph(`${cid}/comments`, { message: `ধন্যবাদ ${fn}! আপনার ইনবক্সে বিস্তারিত পাঠিয়ে দেওয়া হয়েছে 😊` });
          if (state.config.commentInboxEnabled) await callGraph(`${pageId}/messages`, { recipient: { comment_id: cid }, message: { text: rep } });
        }
      }
    }
  }
});

if (BOT_TOKEN) {
  tgBot = new TelegramBot(BOT_TOKEN, { polling: true });
  const isOwner = cid => !ADMIN_CHAT_ID || String(cid) === String(ADMIN_CHAT_ID);
  const sendMenu = cid => {
    const wait = Object.values(state.pendingReplies).filter(p => p.status === 'WAITING').length;
    const act = getActiveStatuses();
    tgBot.sendMessage(cid, `🤖 *ZEVIAN v4.0 Ultimate Panel*\n• Master: ${state.config.masterActive ? '✅ ON' : '⏸ PAUSED'} | Gemini: ${lastGeminiError ? '⚠️ Error' : '✅ Ready'}\n• Active Status: _${act.length ? act[0].text : 'None'}_\n• Chats: ${Object.keys(state.conversations).length} | Pending: ${wait} | Auto: ${state.stats.autoReplied}`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: state.config.masterActive ? '⏸ Pause' : '▶️ Resume', callback_data: 'toggle' }, { text: '📋 Pending', callback_data: 'list_pending' }], [{ text: '📍 My Status', callback_data: 'show_st' }, { text: '📊 Analytics', callback_data: 'show_an' }]] }
    });
  };
  const askStatus = (cid, txt) => {
    pendingDraftStatus = txt.trim();
    tgBot.sendMessage(cid, `📍 *এই তথ্যটি Active Status হিসেবে রাখব?*\n\n_"${pendingDraftStatus}"_`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '✅ Share (1h)', callback_data: 'st:share:60' }, { text: '✅ Share (3h)', callback_data: 'st:share:180' }], [{ text: '✅ Share (6h)', callback_data: 'st:share:360' }, { text: '🔒 Private', callback_data: 'st:private:360' }], [{ text: '❌ Cancel', callback_data: 'st:cancel' }]] }
    });
  };
  tgBot.onText(/\/(start|panel|status)/, m => isOwner(m.chat.id) && sendMenu(m.chat.id));
  tgBot.onText(/\/help/, m => isOwner(m.chat.id) && tgBot.sendMessage(m.chat.id, `📖 *ZEVIAN v4.0 Commands:*\n/status — প্যানেল\n/pending — অপেক্ষমাণ প্রশ্ন\n/inbox — সাম্প্রতিক চ্যাট\n/mystatus | /setstatus <তথ্য> | /clearstatus\n/reply <PR-ID> <উত্তর> | /ignore <PR-ID>\n/block <PSID> | /addkb <প্রশ্ন> | <উত্তর>\n/analytics | /testgemini`, { parse_mode: 'Markdown' }));
  tgBot.onText(/\/analytics/, m => isOwner(m.chat.id) && tgBot.sendMessage(m.chat.id, `📊 Total: ${state.stats.totalIn} | Auto-AI: ${state.stats.autoReplied} | Escalated: ${state.stats.escalated} | Owner Sent: ${state.stats.ownerReplied}`));
  tgBot.onText(/\/mystatus/, m => { if (!isOwner(m.chat.id)) return; const l = getActiveStatuses(); tgBot.sendMessage(m.chat.id, l.length ? l.map(s => `📍 \`${s.id}\`: ${s.text} (${s.expiresLabel})`).join('\n') : '📍 কোনো Active Status নেই।', { parse_mode: 'Markdown' }); });
  tgBot.onText(/\/clearstatus/, m => { if (!isOwner(m.chat.id)) return; state.ownerStatuses.forEach(s => { s.active = false; }); tgBot.sendMessage(m.chat.id, '🛑 সব Status বন্ধ করা হয়েছে।'); });
  tgBot.onText(/\/setstatus ([\s\S]+)/, (m, match) => isOwner(m.chat.id) && askStatus(m.chat.id, match[1]));
  tgBot.onText(/\/inbox/, m => { if (!isOwner(m.chat.id)) return; const l = Object.values(state.conversations).slice(-8); tgBot.sendMessage(m.chat.id, l.length ? l.map(c => `👤 *${c.senderName}* [${c.prefs.language}/${c.prefs.pronoun}]\n└ ${c.messages[c.messages.length - 1]?.text || ''}`).join('\n\n') : '💬 কোনো চ্যাট নেই।', { parse_mode: 'Markdown' }); });
  tgBot.onText(/\/testgemini/, async m => { if (!isOwner(m.chat.id)) return; const r = await analyzeMessage('test', 'ki koris?'); tgBot.sendMessage(m.chat.id, r ? `✅ *Gemini v4 OK!*\nClass: \`${r.classification}\`\nReply: ${r.suggested_reply}` : `❌ Error: \`${lastGeminiError}\``, { parse_mode: 'Markdown' }); });
  tgBot.onText(/\/pending/, m => { if (!isOwner(m.chat.id)) return; const l = Object.values(state.pendingReplies).filter(p => p.status === 'WAITING'); if (!l.length) return tgBot.sendMessage(m.chat.id, '✅ কোনো Pending প্রশ্ন নেই!'); l.forEach(p => tgBot.sendMessage(m.chat.id, `🆔 \`${p.id}\` | 👤 ${p.senderName}\n❓ ${p.question}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✍️ Reply', callback_data: `reply:${p.id}` }, { text: '🚫 Ignore', callback_data: `ignore:${p.id}` }]] } })); });
  tgBot.onText(/\/addkb ([\s\S]+)/, (m, match) => { if (!isOwner(m.chat.id)) return; const p = match[1].split('|'); state.kbItems.unshift({ id: `kb-${Date.now()}`, question: (p[0] || '').trim(), answer: (p[1] || p[0] || '').trim() }); tgBot.sendMessage(m.chat.id, '✅ FAQ যুক্ত হয়েছে!'); });
  tgBot.onText(/\/block (\S+)/, (m, match) => { if (!isOwner(m.chat.id)) return; const u = match[1].trim(); if (!state.blockedUsers.includes(u)) state.blockedUsers.push(u); tgBot.sendMessage(m.chat.id, `⛔ \`${u}\` ব্লক হয়েছে।`, { parse_mode: 'Markdown' }); });
  tgBot.onText(/\/reply (\S+) ([\s\S]+)/, async (m, match) => { if (!isOwner(m.chat.id)) return; const t = match[1].trim(), pid = state.pendingReplies[t] ? t : null, psid = pid ? state.pendingReplies[pid].psid : t; const ok = await sendOwnerReply(psid, match[2].trim(), pid); tgBot.sendMessage(m.chat.id, ok ? '✅ পাঠানো হয়েছে!' : '❌ পাঠানো যায়নি।'); });

  tgBot.on('message', async m => {
    if (!isOwner(m.chat.id) || !m.text || m.text.startsWith('/')) return;
    const txt = m.text.trim();
    if (activeReplyPendingId) {
      const pid = activeReplyPendingId; activeReplyPendingId = null;
      const item = state.pendingReplies[pid];
      if (!item || item.status !== 'WAITING') return tgBot.sendMessage(m.chat.id, '⚠️ সম্পন্ন হয়ে গেছে।');
      const ok = await sendOwnerReply(item.psid, txt, pid);
      return tgBot.sendMessage(m.chat.id, ok ? `✅ উত্তর *${item.senderName}*-কে পাঠানো হয়েছে!` : '❌ পাঠানো যায়নি।', { parse_mode: 'Markdown' });
    }
    if (STATUS_CUES.some(c => txt.includes(c))) askStatus(m.chat.id, txt);
  });

  tgBot.on('callback_query', async q => {
    const cid = q.message.chat.id;
    if (!isOwner(cid)) return;
    const d = q.data || '';
    if (d === 'toggle') { state.config.masterActive = !state.config.masterActive; sendMenu(cid); }
    else if (d === 'show_st') { const l = getActiveStatuses(); tgBot.sendMessage(cid, l.length ? l.map(s => `📍 ${s.id}: ${s.text} (${s.expiresLabel})`).join('\n') : '📍 কোনো Active Status নেই।'); }
    else if (d === 'show_an') { tgBot.sendMessage(cid, `📊 Total: ${state.stats.totalIn} | Auto-AI: ${state.stats.autoReplied} | Escalated: ${state.stats.escalated} | Owner: ${state.stats.ownerReplied}`); }
    else if (d === 'list_pending') { const l = Object.values(state.pendingReplies).filter(p => p.status === 'WAITING'); tgBot.sendMessage(cid, l.length ? l.map(p => `• ${p.id} (${p.senderName}): ${p.question}`).join('\n') : '✅ কোনো Pending প্রশ্ন নেই।'); }
    else if (d === 'st:cancel') { pendingDraftStatus = null; tgBot.sendMessage(cid, '❌ বাতিল হয়েছে।'); }
    else if (d.startsWith('st:')) { const [, vis, mins] = d.split(':'); if (pendingDraftStatus) { const st = addStatus(pendingDraftStatus, vis, Number(mins)); pendingDraftStatus = null; tgBot.sendMessage(cid, `✅ Status *${st.id}* (${st.visibility}, ${st.expiresLabel}) চালু হয়েছে!\n_"${st.text}"_`, { parse_mode: 'Markdown' }); } }
    else if (d.startsWith('sugg:')) { const [, pid, idx] = d.split(':'); const it = state.pendingReplies[pid]; const ch = it && it.suggestions && it.suggestions[Number(idx)]; if (it && it.status === 'WAITING' && ch) { const ok = await sendOwnerReply(it.psid, ch, pid); tgBot.sendMessage(cid, ok ? `✅ 1-Tap উত্তর *${it.senderName}*-কে পাঠানো হয়েছে:\n_"${ch}"_` : '❌ পাঠানো যায়নি', { parse_mode: 'Markdown' }); } }
    else if (d.startsWith('reply:')) { const pid = d.split(':')[1]; if (state.pendingReplies[pid]?.status === 'WAITING') { activeReplyPendingId = pid; tgBot.sendMessage(cid, `✍️ *${state.pendingReplies[pid].senderName}*-এর প্রশ্নের (${pid}) উত্তর লিখুন:`, { parse_mode: 'Markdown' }); } }
    else if (d.startsWith('ignore:')) { const pid = d.split(':')[1]; if (state.pendingReplies[pid]) { state.pendingReplies[pid].status = 'IGNORED'; tgBot.sendMessage(cid, `🚫 ${pid} ইগনোর হয়েছে।`); } }
    else if (d.startsWith('block:')) { const u = d.split(':')[1]; if (!state.blockedUsers.includes(u)) state.blockedUsers.push(u); tgBot.sendMessage(cid, `⛔ ${u} ব্লক হয়েছে।`); }
    else if (d.startsWith('view:')) { const u = d.split(':')[1], c = state.conversations[u]; tgBot.sendMessage(cid, c ? c.messages.slice(-10).map(m => `[${m.time}] *${m.role}:* ${m.text}`).join('\n') : 'হিস্ট্রি নেই।', { parse_mode: 'Markdown' }); }
    tgBot.answerCallbackQuery(q.id, { text: 'OK' });
  });
}

app.get('/health', (req, res) => res.json({ ok: true, version: '4.0.0', masterActive: state.config.masterActive, geminiOk: !lastGeminiError, activeStatuses: getActiveStatuses().length, pendingCount: Object.values(state.pendingReplies).filter(p => p.status === 'WAITING').length, uptime: Math.floor(process.uptime()) }));
app.get('/', (req, res) => res.send(`<html><body style="font-family:sans-serif;background:#070b14;color:#f1f5f9;padding:30px"><h2>🤖 ZEVIAN v4.0 Ultimate Assistant</h2><p>Master: <b>${state.config.masterActive ? 'ACTIVE' : 'PAUSED'}</b> | Gemini: <b>${lastGeminiError ? 'ERROR' : 'READY'}</b> | Active Statuses: <b>${getActiveStatuses().length}</b></p><p><a style="color:#818cf8" href="/health">/health</a></p></body></html>`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('ZEVIAN v4.0 Ultimate running on port', PORT));
