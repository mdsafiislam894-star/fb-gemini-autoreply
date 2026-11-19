require('dotenv').config();
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const GRAPH_VERSION = 'v21.0';
const ADMIN_CHAT_ID = (process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const PAGE_TOKEN = (process.env.FB_PAGE_ACCESS_TOKEN || '').trim();

const config = {
  masterActive: true,
  pageDmEnabled: true,
  commentReplyEnabled: true,
  commentInboxEnabled: true,
  geminiModel: 'gemini-3.5-flash-lite',
  knowledgeBase: 'Page Name: ZEVIAN. ZEVIAN is an AI-powered personal messaging assistant for this Facebook Page.',
  systemPrompt: 'You are ZEVIAN, a friendly, natural, polite personal Messenger assistant for this Facebook Page. Reply naturally in the exact language of the user (Bengali, English, or Banglish). Keep replies concise (1-3 sentences) and conversational with light emojis when natural. NEVER invent the owner\'s personal plans, location, feelings, promises, or private facts.'
};

const PERSONAL_CUES = [
  'কোথায় আছ', 'কোথায় আছ', 'কলেজে যাব', 'খেয়েছিস', 'খেয়েছিস', 'খেয়েছো', 'খেয়েছো',
  'ফোন দিবো', 'ফোন দেবো', 'ফোন দিতে পারি', 'আজকে আসব', 'কালকে আসব', 'দেখা করতে পারব',
  'বাসায় আছ', 'বাসায় আছ', 'কখন আসব', 'চিনতে পারছ', 'তুমি কি রাজি', 'kothay ach',
  'phone dibo', 'kalke asb', 'basay ach', 'ki diye kheye'
];

const conversations = {};
const pendingReplies = {};
const processedIds = new Set();
let pendingCounter = 1000;
let activeReplyPendingId = null;
let lastGeminiError = null;
let tgBot = null;

async function callGraph(endpoint, payload) {
  if (!PAGE_TOKEN) return { error: 'Missing FB_PAGE_ACCESS_TOKEN' };
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${endpoint}?access_token=${encodeURIComponent(PAGE_TOKEN)}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return res.json();
}

async function fetchSenderName(psid) {
  if (!PAGE_TOKEN) return `User ${psid.slice(-4)}`;
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${psid}?fields=first_name,last_name&access_token=${encodeURIComponent(PAGE_TOKEN)}`);
    const data = await res.json();
    if (data && data.first_name) return `${data.first_name} ${data.last_name || ''}`.trim();
  } catch (_) {}
  return `User ${psid.slice(-4)}`;
}

function getOrCreateConv(psid, senderName) {
  if (!conversations[psid]) conversations[psid] = { psid, senderName: senderName || `User ${psid.slice(-4)}`, messages: [] };
  else if (senderName && conversations[psid].senderName.startsWith('User ')) conversations[psid].senderName = senderName;
  return conversations[psid];
}

function pushHistory(psid, role, text) {
  const conv = getOrCreateConv(psid);
  conv.messages.push({ role, text, time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) });
  if (conv.messages.length > 20) conv.messages = conv.messages.slice(-20);
}

function isObviousPersonal(text) {
  const low = (text || '').toLowerCase();
  return PERSONAL_CUES.some(cue => low.includes(cue));
}

async function callGeminiClassifier(psid, userText) {
  if (!GEMINI_API_KEY) { lastGeminiError = 'GEMINI_API_KEY is missing in Render'; return null; }
  const conv = getOrCreateConv(psid);
  const history = conv.messages.slice(-10).map(m => `${m.role}: ${m.text}`).join('\n');
  const prompt = `${config.systemPrompt}\n\nKnowledge Base:\n${config.knowledgeBase}\n\nRecent Conversation:\n${history || '(New)'}\n\nLatest User Message:\n"${userText}"\n\nClassify into ONE of: GENERAL, PERSONAL, UNCERTAIN, SENSITIVE, SPAM.\n- GENERAL: greetings, casual chat, Page/KB questions -> set requires_owner=false and write a natural reply in the user's language in "suggested_reply".\n- PERSONAL: owner's location, plans, college, eating, calls, personal decision -> set requires_owner=true, suggested_reply="".\n- UNCERTAIN/SENSITIVE: ambiguous or private -> set requires_owner=true.\nReturn ONLY valid JSON with keys: classification, confidence, language, requires_owner, reason, suggested_reply.`;
  const modelsToTry = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash', 'gemini-3.8-flash'];
  for (const model of modelsToTry) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.65, responseMimeType: 'application/json' } }) });
      const data = await res.json();
      if (!res.ok) { lastGeminiError = `${model} HTTP ${res.status}: ${data.error ? data.error.message : JSON.stringify(data)}`; continue; }
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (rawText) { lastGeminiError = null; return JSON.parse(rawText.replace(/^```json\s*/i, '').replace(/```$/i, '').trim()); }
    } catch (e) { lastGeminiError = `${model} Exception: ${e.message}`; }
  }
  return null;
}

function createPendingAndNotify(psid, senderName, question, classification, reason) {
  pendingCounter += 1;
  const pid = `PR-${pendingCounter}`;
  const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  pendingReplies[pid] = { id: pid, psid, senderName, question, classification, reason, status: 'WAITING', createdAt: timeStr };
  if (tgBot && ADMIN_CHAT_ID) {
    const title = classification === 'PERSONAL' ? '🚨 ZEVIAN — New Personal Question' : `⚠️ ZEVIAN — ${classification} Question`;
    tgBot.sendMessage(ADMIN_CHAT_ID, `${title}\n\n🆔 Pending ID: \`${pid}\`\n👤 Sender: ${senderName}\n💬 Conversation: \`${psid}\`\n🕒 Time: ${timeStr}\n📌 Classification: *${classification}*\n💡 Reason: ${reason}\n\n❓ *Question:*\n${question}\n\n📊 Status: Waiting for Owner Reply`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '✍️ Reply', callback_data: `reply:${pid}` }, { text: '🚫 Ignore', callback_data: `ignore:${pid}` }], [{ text: '💬 View Conversation', callback_data: `view:${psid}` }]] }
    }).catch(() => {});
  }
  return pid;
}

app.get('/webhook', (req, res) => {
  const verifyToken = (process.env.FB_VERIFY_TOKEN || 'safi_page_verify_2026').trim();
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verifyToken) return res.status(200).send(req.query['hub.challenge']);
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object !== 'page') return res.sendStatus(404);
  res.status(200).send('EVENT_RECEIVED');
  if (!config.masterActive) return;

  for (const entry of body.entry || []) {
    const pageId = entry.id;
    if (entry.messaging && config.pageDmEnabled) {
      for (const ev of entry.messaging) {
        const psid = ev.sender?.id, mid = ev.message?.mid, text = ev.message?.text;
        if (!psid || psid === pageId || !text || ev.message.is_echo) continue;
        if (mid && processedIds.has(mid)) continue;
        if (mid) processedIds.add(mid);
        const senderName = await fetchSenderName(psid);
        getOrCreateConv(psid, senderName);
        pushHistory(psid, 'User', text);

        if (isObviousPersonal(text)) {
          await callGraph('me/messages', { recipient: { id: psid }, message: { text: 'এই প্রশ্নটির উত্তর আমার Owner দিতে পারবেন। একটু অপেক্ষা করো 😊' } });
          createPendingAndNotify(psid, senderName, text, 'PERSONAL', 'Personal question detected');
          continue;
        }
        await callGraph('me/messages', { recipient: { id: psid }, sender_action: 'typing_on' });
        const aiResult = await callGeminiClassifier(psid, text);
        if (!aiResult) { createPendingAndNotify(psid, senderName, text, 'UNCERTAIN', `Gemini error: ${lastGeminiError || 'Unknown'}`); continue; }
        const cls = (aiResult.classification || 'UNCERTAIN').toUpperCase();
        if (cls === 'SPAM') continue;
        if (cls === 'GENERAL' && !aiResult.requires_owner && aiResult.suggested_reply) {
          const replyText = aiResult.suggested_reply.trim();
          await callGraph('me/messages', { recipient: { id: psid }, message: { text: replyText } });
          pushHistory(psid, 'ZEVIAN', replyText);
          if (tgBot && ADMIN_CHAT_ID) {
            tgBot.sendMessage(ADMIN_CHAT_ID, `💬 *ZEVIAN Auto-Reply (GENERAL)*\n👤 ${senderName} (\`${psid}\`)\n📩 User: ${text}\n🤖 ZEVIAN: ${replyText}`, {
              parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💬 View Conversation', callback_data: `view:${psid}` }]] }
            }).catch(() => {});
          }
        } else {
          if (cls === 'PERSONAL') await callGraph('me/messages', { recipient: { id: psid }, message: { text: 'এই প্রশ্নটির উত্তর আমার Owner দিতে পারবেন। একটু অপেক্ষা করো 😊' } });
          createPendingAndNotify(psid, senderName, text, cls, aiResult.reason || 'Owner review required');
        }
      }
    }
    if (entry.changes) {
      for (const ch of entry.changes) {
        if (ch.field === 'feed' && ch.value?.item === 'comment' && ch.value?.verb === 'add') {
          const cid = ch.value.comment_id, fromId = ch.value.from?.id, fromName = ch.value.from?.name || 'Friend', cText = ch.value.message || '';
          if (!cid || fromId === pageId || !cText || processedIds.has(cid)) continue;
          processedIds.add(cid);
          const aiRes = await callGeminiClassifier(`c_${fromId || cid}`, `[Post Comment]: ${cText}`);
          const inboxReply = (aiRes && aiRes.suggested_reply) || `ধন্যবাদ ${fromName}! কীভাবে সাহায্য করতে পারি?`;
          if (config.commentReplyEnabled) await callGraph(`${cid}/comments`, { message: `ধন্যবাদ ${fromName}! আপনার ইনবক্সে বিস্তারিত পাঠিয়ে দেওয়া হয়েছে 😊` });
          if (config.commentInboxEnabled) await callGraph(`${pageId}/messages`, { recipient: { comment_id: cid }, message: { text: inboxReply } });
        }
      }
    }
  }
});

if (process.env.TELEGRAM_BOT_TOKEN) {
  tgBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN.trim(), { polling: true });
  const isOwner = cid => !ADMIN_CHAT_ID || String(cid) === String(ADMIN_CHAT_ID);
  const sendMenu = cid => {
    const waitingCount = Object.values(pendingReplies).filter(p => p.status === 'WAITING').length;
    tgBot.sendMessage(cid, `🤖 *ZEVIAN Control Center*\n• Master: ${config.masterActive ? '✅ ON' : '⏸ PAUSED'}\n• Page DM: ${config.pageDmEnabled ? '✅ ON' : '❌ OFF'}\n• Comment-to-Inbox: ${config.commentInboxEnabled ? '✅ ON' : '❌ OFF'}\n• Active Chats: ${Object.keys(conversations).length}\n• Pending: ${waitingCount}\n• Gemini: ${lastGeminiError ? '⚠️ Error (/testgemini)' : '✅ Ready'}`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: config.masterActive ? '⏸ Pause All' : '▶️ Resume All', callback_data: 'toggle' }, { text: '📋 Pending List', callback_data: 'list_pending' }], [{ text: '💬 Toggle Comment DM', callback_data: 'toggle_comment' }, { text: '🧹 Clear Memory', callback_data: 'clear' }]] }
    });
  };
  tgBot.onText(/\/(start|panel|status)/, m => isOwner(m.chat.id) && sendMenu(m.chat.id));
  tgBot.onText(/\/help/, m => isOwner(m.chat.id) && tgBot.sendMessage(m.chat.id, `📖 *ZEVIAN Commands:*\n/status — স্ট্যাটাস\n/pending — পেন্ডিং প্রশ্ন\n/reply <PR-ID> <উত্তর>\n/ignore <PR-ID>\n/setprompt <নির্দেশনা>\n/addkb <তথ্য>\n/testgemini — Gemini চেক`, { parse_mode: 'Markdown' }));
  tgBot.onText(/\/testgemini/, async m => {
    if (!isOwner(m.chat.id)) return;
    const res = await callGeminiClassifier('test_owner', 'হ্যালো, কেমন আছো?');
    tgBot.sendMessage(m.chat.id, res ? `✅ *Gemini API সচল!*\nClass: \`${res.classification}\`\nReply: ${res.suggested_reply}` : `❌ *Gemini এরর:*\n\`${lastGeminiError}\``, { parse_mode: 'Markdown' });
  });
  tgBot.onText(/\/pending/, m => {
    if (!isOwner(m.chat.id)) return;
    const list = Object.values(pendingReplies).filter(p => p.status === 'WAITING');
    if (!list.length) return tgBot.sendMessage(m.chat.id, '✅ কোনো Pending প্রশ্ন নেই!');
    list.forEach(p => tgBot.sendMessage(m.chat.id, `🆔 \`${p.id}\` | 👤 ${p.senderName}\n❓ ${p.question}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✍️ Reply', callback_data: `reply:${p.id}` }, { text: '🚫 Ignore', callback_data: `ignore:${p.id}` }]] } }));
  });
  tgBot.onText(/\/setprompt ([\s\S]+)/, (m, match) => { if (isOwner(m.chat.id)) { config.systemPrompt = match[1].trim(); tgBot.sendMessage(m.chat.id, '✅ Prompt আপডেট হয়েছে!'); } });
  tgBot.onText(/\/addkb ([\s\S]+)/, (m, match) => { if (isOwner(m.chat.id)) { config.knowledgeBase += `\n- ${match[1].trim()}`; tgBot.sendMessage(m.chat.id, '✅ Knowledge Base আপডেট হয়েছে!'); } });
  tgBot.onText(/\/ignore (\S+)/, (m, match) => { if (isOwner(m.chat.id) && pendingReplies[match[1].trim()]) { pendingReplies[match[1].trim()].status = 'IGNORED'; tgBot.sendMessage(m.chat.id, `🚫 \`${match[1].trim()}\` ইগনোর হয়েছে।`, { parse_mode: 'Markdown' }); } });

  async function deliverOwnerReply(chatId, pid, answerText) {
    const item = pendingReplies[pid];
    if (!item || item.status !== 'WAITING') return tgBot.sendMessage(chatId, `⚠️ \`${pid}\` পাওয়া যায়নি বা উত্তর হয়ে গেছে।`, { parse_mode: 'Markdown' });
    const res = await callGraph('me/messages', { recipient: { id: item.psid }, message: { text: answerText } });
    if (res && res.message_id) { item.status = 'ANSWERED'; item.ownerReply = answerText; pushHistory(item.psid, 'Owner', answerText); tgBot.sendMessage(chatId, `✅ উত্তর *${item.senderName}*-কে (\`${pid}\`) পাঠানো হয়েছে!`, { parse_mode: 'Markdown' }); }
    else tgBot.sendMessage(chatId, `❌ পাঠানো যায়নি: \`${JSON.stringify(res)}\``, { parse_mode: 'Markdown' });
  }
  tgBot.onText(/\/reply (\S+) ([\s\S]+)/, async (m, match) => {
    if (!isOwner(m.chat.id)) return;
    const target = match[1].trim(), answerText = match[2].trim();
    if (pendingReplies[target]) return deliverOwnerReply(m.chat.id, target, answerText);
    const res = await callGraph('me/messages', { recipient: { id: target }, message: { text: answerText } });
    if (res && res.message_id) { pushHistory(target, 'Owner', answerText); tgBot.sendMessage(m.chat.id, `✅ \`${target}\`-এ পাঠানো হয়েছে!`, { parse_mode: 'Markdown' }); }
    else tgBot.sendMessage(m.chat.id, `❌ পাঠানো যায়নি: ${JSON.stringify(res)}`);
  });
  tgBot.on('message', async m => {
    if (!isOwner(m.chat.id) || !m.text || m.text.startsWith('/')) return;
    if (activeReplyPendingId) { const pid = activeReplyPendingId; activeReplyPendingId = null; await deliverOwnerReply(m.chat.id, pid, m.text.trim()); }
  });
  tgBot.on('callback_query', q => {
    const cid = q.message.chat.id;
    if (!isOwner(cid)) return;
    const data = q.data || '';
    if (data === 'toggle') { config.masterActive = !config.masterActive; sendMenu(cid); }
    else if (data === 'toggle_comment') { config.commentInboxEnabled = !config.commentInboxEnabled; sendMenu(cid); }
    else if (data === 'clear') { Object.keys(conversations).forEach(k => delete conversations[k]); sendMenu(cid); }
    else if (data === 'list_pending') {
      const list = Object.values(pendingReplies).filter(p => p.status === 'WAITING');
      tgBot.sendMessage(cid, list.length ? list.map(p => `• \`${p.id}\` (${p.senderName}): ${p.question}`).join('\n') : '✅ কোনো Pending প্রশ্ন নেই।', { parse_mode: 'Markdown' });
    } else if (data.startsWith('reply:')) {
      const pid = data.split(':')[1];
      if (!pendingReplies[pid] || pendingReplies[pid].status !== 'WAITING') tgBot.sendMessage(cid, `⚠️ \`${pid}\` ইতিমধ্যেই সম্পন্ন।`, { parse_mode: 'Markdown' });
      else { activeReplyPendingId = pid; tgBot.sendMessage(cid, `✍️ *${pendingReplies[pid].senderName}*-এর প্রশ্নের (\`${pid}\`) উত্তর সরাসরি মেসেজ করে লিখুন:\n\n❓ _"${pendingReplies[pid].question}"_`, { parse_mode: 'Markdown' }); }
    } else if (data.startsWith('ignore:')) {
      const pid = data.split(':')[1];
      if (pendingReplies[pid]) { pendingReplies[pid].status = 'IGNORED'; tgBot.sendMessage(cid, `🚫 \`${pid}\` ইগনোর করা হয়েছে।`, { parse_mode: 'Markdown' }); }
    } else if (data.startsWith('view:')) {
      const psid = data.split(':')[1], conv = conversations[psid];
      const lines = conv ? conv.messages.slice(-10).map(m => `[${m.time}] *${m.role}:* ${m.text}`).join('\n') : 'হিস্ট্রি নেই।';
      tgBot.sendMessage(cid, `💬 *History (${conv ? conv.senderName : psid}):*\n\n${lines}`, { parse_mode: 'Markdown' });
    }
    tgBot.answerCallbackQuery(q.id, { text: 'OK' });
  });
}

app.get('/health', (req, res) => res.json({ ok: true, mode: 'zevian_official_page', masterActive: config.masterActive, geminiOk: !lastGeminiError, lastGeminiError, pendingCount: Object.values(pendingReplies).filter(p => p.status === 'WAITING').length, uptime: Math.floor(process.uptime()) }));
app.get('/', (req, res) => res.send(`<html><body style="font-family:sans-serif;background:#070b14;color:#f1f5f9;padding:30px"><h2>🤖 ZEVIAN — AI Personal Messenger Assistant</h2><p>Master: <b>${config.masterActive ? 'ACTIVE' : 'PAUSED'}</b> | Gemini: <b>${lastGeminiError ? 'ERROR: ' + lastGeminiError : 'READY'}</b></p><p><a style="color:#818cf8" href="/health">/health</a></p></body></html>`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('ZEVIAN AI Assistant running on port', PORT));
