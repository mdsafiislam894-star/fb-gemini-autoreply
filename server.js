require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const config = {
  masterActive: true,
  personalEnabled: process.env.PERSONAL_BOT_ENABLED !== 'false',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  minDelayMs: 3000,
  maxDelayMs: 6000,
  ownerPauseMin: 30,
  systemPrompt: 'তুমি মো: সাফি ইসলামের (Md Safi Islam) পার্সোনাল এআই অ্যাসিস্ট্যান্ট। কেউ মেসেজ দিলে স্বাভাবিক, আন্তরিক ও সংক্ষিপ্ত বাংলায় উত্তর দেবে। আগের চ্যাট মনে রেখে কথা বলবে। জরুরি বা ব্যক্তিগত বিষয়ে জানাবে যে সাফি ফ্রি হয়েই নিজে যোগাযোগ করবেন।',
  blacklist: []
};

const memory = {};
const ownerPausedUntil = new Map();
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
let fcaApi = null;
let tgBot = null;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;

async function askGemini(uid, text) {
  if (!memory[uid]) memory[uid] = [];
  memory[uid].push({ role: 'user', text });
  if (memory[uid].length > 20) memory[uid] = memory[uid].slice(-20);
  const history = memory[uid].map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n');
  let reply = 'আসসালামু আলাইকুম! আপনার মেসেজ পেয়েছি, সাফি ভাইয়া ফ্রি হয়েই যোগাযোগ করবেন।';
  if (ai) {
    try {
      const res = await ai.models.generateContent({
        model: config.geminiModel,
        contents: `History:\n${history}\n\nReply naturally in Bengali:`,
        config: { systemInstruction: config.systemPrompt, temperature: 0.65 }
      });
      if (res && res.text) reply = res.text.trim();
    } catch (e) { console.error('Gemini Error:', e.message); }
  }
  memory[uid].push({ role: 'assistant', text: reply });
  return reply;
}

function startPersonalBot() {
  if (!config.personalEnabled || !process.env.FB_APPSTATE_JSON) {
    console.log('[FB Bot] Waiting for FB_APPSTATE_JSON env var.');
    return;
  }
  try {
    const appState = JSON.parse(process.env.FB_APPSTATE_JSON);
    const fca = require('@tas33n/ws3-fca');
    const login = typeof fca === 'function' ? fca : fca.login || fca.default;
    login({ appState }, { listenEvents: true, selfListen: true, autoMarkRead: true }, (err, api) => {
      if (err) return console.error('[FB Bot] Login error:', err.message || err);
      fcaApi = api;
      const myId = String(api.getCurrentUserID());
      console.log('[FB Bot] Connected as UID:', myId);
      api.listenMqtt((lErr, ev) => {
        if (lErr || !ev || (ev.type !== 'message' && ev.type !== 'message_reply')) return;
        if (ev.isGroup) return;
        const tid = String(ev.threadID);
        if (String(ev.senderID) === myId) {
          ownerPausedUntil.set(tid, Date.now() + config.ownerPauseMin * 60000);
          return;
        }
        if (!config.masterActive || !config.personalEnabled || config.blacklist.includes(tid)) return;
        if ((ownerPausedUntil.get(tid) || 0) > Date.now() || !ev.body) return;
        const delay = Math.floor(Math.random() * (config.maxDelayMs - config.minDelayMs + 1)) + config.minDelayMs;
        if (api.sendTypingIndicator) api.sendTypingIndicator(tid, () => {});
        setTimeout(async () => {
          const reply = await askGemini(tid, ev.body);
          api.sendMessage(reply, tid, () => {
            if (tgBot && ADMIN_CHAT_ID) {
              tgBot.sendMessage(ADMIN_CHAT_ID, `🔔 *FB Personal Auto-Reply*\n👤 Thread: \`${tid}\`\n💬 User: ${ev.body}\n🤖 Gemini: ${reply}\n\nরিপ্লাই দিতে লিখুন: \`/reply ${tid} আপনার উত্তর\``, { parse_mode: 'Markdown' }).catch(() => {});
            }
          });
        }, delay);
      });
    });
  } catch (e) { console.error('[FB Bot] Init error:', e.message); }
}

if (process.env.TELEGRAM_BOT_TOKEN) {
  tgBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
  const sendMenu = (cid) => tgBot.sendMessage(cid, `🤖 *FB × Gemini 24/7 Panel*\n• Master: ${config.masterActive ? '✅ ON' : '⏸ PAUSED'}\n• FB Connected: ${fcaApi ? '✅ YES' : '⚠️ Waiting AppState'}\n• Memory Threads: ${Object.keys(memory).length}`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: config.masterActive ? '⏸ Pause Bot' : '▶️ Resume Bot', callback_data: 'toggle' }, { text: '🧹 Clear Memory', callback_data: 'clear' }]] }
  });
  tgBot.onText(/\/(start|panel|status)/, (m) => sendMenu(m.chat.id));
  tgBot.onText(/\/setprompt ([\s\S]+)/, (m, match) => { config.systemPrompt = match[1].trim(); tgBot.sendMessage(m.chat.id, '✅ System Prompt আপডেট হয়েছে!'); });
  tgBot.onText(/\/reply (\S+) ([\s\S]+)/, (m, match) => {
    if (!fcaApi) return tgBot.sendMessage(m.chat.id, '⚠️ FB Bot এখনো কানেক্টেড নয়।');
    fcaApi.sendMessage(match[2].trim(), match[1].trim(), (e) => tgBot.sendMessage(m.chat.id, e ? '❌ পাঠানো যায়নি' : `✅ \`${match[1]}\`-এ পাঠানো হয়েছে!`, { parse_mode: 'Markdown' }));
  });
  tgBot.on('callback_query', (q) => {
    if (q.data === 'toggle') config.masterActive = !config.masterActive;
    if (q.data === 'clear') Object.keys(memory).forEach(k => delete memory[k]);
    tgBot.answerCallbackQuery(q.id, { text: 'Done!' });
    sendMenu(q.message.chat.id);
  });
}

app.get('/health', (req, res) => res.json({ ok: true, fbConnected: Boolean(fcaApi), telegramConnected: Boolean(tgBot), masterActive: config.masterActive, uptime: Math.floor(process.uptime()) }));
app.get('/', (req, res) => res.send(`<html><body style="font-family:sans-serif;background:#070b14;color:#f1f5f9;padding:30px"><h2>🤖 FB × Gemini 24/7 Auto-Reply Server</h2><p>Master Status: <b>${config.masterActive ? 'ACTIVE' : 'PAUSED'}</b> | FB Bot: <b>${fcaApi ? 'Connected' : 'Waiting FB_APPSTATE_JSON'}</b> | Telegram: <b>${tgBot ? 'Connected' : 'Waiting Token'}</b></p><p>Health Endpoint: <a style="color:#818cf8" href="/health">/health</a></p></body></html>`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log('Server running on', PORT); startPersonalBot(); });
