require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
const GRAPH_VERSION = 'v21.0';
const config = {
  masterActive: true,
  pageDmEnabled: true,
  commentReplyEnabled: true,
  commentInboxEnabled: true,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  systemPrompt: 'তুমি এই ফেসবুক পেজের অফিসিয়াল এআই অ্যাসিস্ট্যান্ট। কেউ মেসেজ বা কমেন্ট করলে স্বাভাবিক, ভদ্র ও সংক্ষিপ্ত বাংলা, ইংরেজি বা বাংলিশে (ইউজারের ভাষায়) উত্তর দেবে। আগের চ্যাট মনে রেখে কথা বলবে। কখনো ব্যক্তিগত তথ্য বা অজানা তথ্য বানিয়ে বলবে না।'
};

const PERSONAL_CUES = ['কোথায় আছ', 'কলেজে যাব', 'খেয়েছিস', 'খেয়েছিস', 'ফোন দিবো', 'ফোন দেবো', 'আজকে আসব', 'বাসায় আছ', 'বাসায় আছ', 'kothay ach', 'phone dibo'];
const memory = {};
const processedIds = new Set();
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;
let tgBot = null;
async function callGraph(endpoint, payload) {
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!token) return null;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${endpoint}?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return res.json();
}

function isPersonalQuestion(text) {
  const low = (text || '').toLowerCase();
  return PERSONAL_CUES.some(cue => low.includes(cue));
}

async function askGemini(uid, text) {
  if (!memory[uid]) memory[uid] = [];
  memory[uid].push({ role: 'user', text });
  if (memory[uid].length > 20) memory[uid] = memory[uid].slice(-20);
  const history = memory[uid].map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n');
  let reply = 'আসসালামু আলাইকুম! আপনার মেসেজের জন্য ধন্যবাদ। অ্যাডমিন খুব শীঘ্রই যোগাযোগ করবেন।';
  if (ai) {
    try {
      const res = await ai.models.generateContent({
        model: config.geminiModel,
        contents: `History:\n${history}\n\nWrite a helpful, concise reply in the user's language:`,
        config: { systemInstruction: config.systemPrompt, temperature: 0.6 }
      });
      if (res && res.text) reply = res.text.trim();
    } catch (e) { console.error('Gemini Error:', e.message); }
  }
  memory[uid].push({ role: 'assistant', text: reply });
  return reply;
}

function notifyTelegram(msg) {
  if (tgBot && ADMIN_CHAT_ID) {
    tgBot.sendMessage(ADMIN_CHAT_ID, msg, { parse_mode: 'Markdown' }).catch(() => {});
  }
}

app.get('/webhook', (req, res) => {
  const verifyToken = process.env.FB_VERIFY_TOKEN || 'safi_page_verify_2026';
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verifyToken) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  return res.sendStatus(403);
});
app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object !== 'page') return res.sendStatus(404);
  res.status(200).send('EVENT_RECEIVED');
  if (!config.masterActive) return;

  for (const entry of body.entry || []) {
    const pageId = entry.id;

    // 1. Page Messenger DMs
    if (entry.messaging && config.pageDmEnabled) {
      for (const ev of entry.messaging) {
        const psid = ev.sender && ev.sender.id;
        const mid = ev.message && ev.message.mid;
        const text = ev.message && ev.message.text;
        if (!psid || psid === pageId || !text || ev.message.is_echo) continue;
        if (mid && processedIds.has(mid)) continue;
        if (mid) processedIds.add(mid);

        if (isPersonalQuestion(text)) {
          notifyTelegram(`🚨 *ব্যক্তিগত প্রশ্ন (Owner Reply Needed)*\n👤 PSID: \`${psid}\`\n💬 মেসেজ: ${text}\n\nউত্তর পাঠাতে লিখুন:\n\`/reply ${psid} আপনার উত্তর\``);
          continue;
        }

        await callGraph('me/messages', { recipient: { id: psid }, sender_action: 'typing_on' });
        const reply = await askGemini(psid, text);
        await callGraph('me/messages', { recipient: { id: psid }, message: { text: reply } });
        notifyTelegram(`💬 *Page DM Auto-Reply*\n👤 PSID: \`${psid}\`\n📩 User: ${text}\n🤖 Gemini: ${reply}\n\nনিজে রিপ্লাই দিতে: \`/reply ${psid} আপনার উত্তর\``);
      }
    }

    // 2. Page Post Comments (Public Reply + Comment-to-Inbox)
    if (entry.changes) {
      for (const ch of entry.changes) {
        if (ch.field === 'feed' && ch.value && ch.value.item === 'comment' && ch.value.verb === 'add') {
          const cid = ch.value.comment_id;
          const fromId = ch.value.from && ch.value.from.id;
          const fromName = (ch.value.from && ch.value.from.name) || 'Friend';
          const cText = ch.value.message || '';
          if (!cid || fromId === pageId || !cText || processedIds.has(cid)) continue;
          processedIds.add(cid);

          const inboxReply = await askGemini(`c_${fromId || cid}`, `[Post Comment]: ${cText}`);
          if (config.commentReplyEnabled) {
            await callGraph(`${cid}/comments`, { message: `ধন্যবাদ ${fromName}! আপনার ইনবক্সে বিস্তারিত পাঠিয়ে দেওয়া হয়েছে, অনুগ্রহ করে চেক করুন। 📩` });
          }
          if (config.commentInboxEnabled) {
            await callGraph(`${pageId}/messages`, { recipient: { comment_id: cid }, message: { text: inboxReply } });
          }
          notifyTelegram(`📝 *Comment-to-Inbox সম্পন্ন*\n👤 ${fromName}\n💬 কমেন্ট: ${cText}\n🤖 ইনবক্স রিপ্লাই: ${inboxReply}`);
        }
      }
    }
  }
});
if (process.env.TELEGRAM_BOT_TOKEN) {
  tgBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
  const isOwner = (cid) => !ADMIN_CHAT_ID || String(cid) === String(ADMIN_CHAT_ID);
  const sendMenu = (cid) => tgBot.sendMessage(cid, `🤖 *ZEVIAN Page × Gemini Panel*\n• Master: ${config.masterActive ? '✅ ON' : '⏸ PAUSED'}\n• Page DM: ${config.pageDmEnabled ? '✅ ON' : '❌ OFF'}\n• Comment-to-Inbox: ${config.commentInboxEnabled ? '✅ ON' : '❌ OFF'}\n• Memory Threads: ${Object.keys(memory).length}`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: config.masterActive ? '⏸ Pause All' : '▶️ Resume All', callback_data: 'toggle' }, { text: '💬 Toggle Comment DM', callback_data: 'toggle_comment' }], [{ text: '🧹 Clear Memory', callback_data: 'clear' }]] }
  });
  tgBot.onText(/\/(start|panel|status)/, (m) => isOwner(m.chat.id) && sendMenu(m.chat.id));
  tgBot.onText(/\/setprompt ([\s\S]+)/, (m, match) => { if (!isOwner(m.chat.id)) return; config.systemPrompt = match[1].trim(); tgBot.sendMessage(m.chat.id, '✅ System Prompt আপডেট হয়েছে!'); });
  tgBot.onText(/\/reply (\S+) ([\s\S]+)/, async (m, match) => {
    if (!isOwner(m.chat.id)) return;
    const psid = match[1].trim();
    const msgText = match[2].trim();
    const res = await callGraph('me/messages', { recipient: { id: psid }, message: { text: msgText } });
    tgBot.sendMessage(m.chat.id, res && res.message_id ? `✅ মেসেজ সফলভাবে \`${psid}\`-এ পাঠানো হয়েছে!` : `❌ পাঠানো যায়নি: ${JSON.stringify(res)}`, { parse_mode: 'Markdown' });
  });
  tgBot.on('callback_query', (q) => {
    if (!isOwner(q.message.chat.id)) return;
    if (q.data === 'toggle') config.masterActive = !config.masterActive;
    if (q.data === 'toggle_comment') config.commentInboxEnabled = !config.commentInboxEnabled;
    if (q.data === 'clear') Object.keys(memory).forEach(k => delete memory[k]);
    tgBot.answerCallbackQuery(q.id, { text: 'Updated!' });
    sendMenu(q.message.chat.id);
  });
}

app.get('/health', (req, res) => res.json({ ok: true, mode: 'official_page', masterActive: config.masterActive, telegramConnected: Boolean(tgBot), uptime: Math.floor(process.uptime()) }));
app.get('/', (req, res) => res.send(`<html><body style="font-family:sans-serif;background:#070b14;color:#f1f5f9;padding:30px"><h2>🤖 ZEVIAN Official Page × Gemini Server</h2><p>Master: <b>${config.masterActive ? 'ACTIVE' : 'PAUSED'}</b> | Page DM: <b>${config.pageDmEnabled ? 'ON' : 'OFF'}</b> | Comment-to-Inbox: <b>${config.commentInboxEnabled ? 'ON' : 'OFF'}</b></p><p>Webhook Endpoint: <code>/webhook</code> | Health: <a style="color:#818cf8" href="/health">/health</a></p></body></html>`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('ZEVIAN Page Server running on port', PORT));
