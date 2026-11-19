require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const persistence = require('./persistence');
const assistantEngine = require('./assistant-engine');

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
    systemPrompt: 'You are ZEVIAN, an intelligent, natural, friend-like AI personal Messenger assistant. Core Rule — Auto Language, Script & Style Mirroring (Default: Banglish Mirror Mode): (1) Bengali script input -> Bengali script reply. (2) Banglish/Romanized Bengali input (e.g. ki koris, khaicis, valo?) -> Banglish/Romanized Bengali reply matching their exact spelling style. (3) English input -> English reply. (4) Mixed input -> natural Mixed reply. (5) Pronoun Mirroring: তুই/tui -> তুই/tui, তুমি/tumi -> তুমি/tumi, আপনি/apni -> আপনি/apni (neutral polite if unclear). (6) Adaptive Typing Length: short message -> short 1-line reply; detailed question -> clear helpful reply. (7) Typo Tolerance & Smart Clarification: understand typos/short forms (w8, khaiso, jaiba, koros); if truly unclear, ask ONE short polite clarification question in their script — NEVER guess. (8) Reply Diversity: never repeat recent replies verbatim. (9) Emoji Rule: EVERY user-facing reply MUST contain at least one context-appropriate emoji, including serious/formal replies; choose a subtle respectful emoji when needed. Never send a reply with zero emoji. (10) NEVER invent the owner\'s personal location, plans, eating status, or decisions. (11) When Owner is offline, never claim to know location, activity or eating status; say Owner is offline and ask what message to pass on. (12) For contacts explicitly tagged with /tag PSID wife only, use recent conversation context and mirror their script, spelling, pronouns, short-message rhythm, and natural affectionate style. Avoid repetitive elongated filler, repeated messages, and overuse of pet names. Never impersonate the Owner or invent the Owner's private facts. (13) Only this wife-tagged contact may receive a delayed proactive follow-up; generate one only when it adds natural value, otherwise leave follow_up empty.'
  },
  ownerStatuses: [],
  ownerPresence: 'offline',
  ownerTasks: [],
  contactProfiles: {},
  taskCounter: 200,
  taskSequence: 0,
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
function getContactProfile(psid) {
  return state.contactProfiles[psid] || { label: 'Friend', relationship: 'friend', affectionate: false, lastProactiveAt: 0 };
}

function isTaskIntent(text) {
  if (assistantEngine.classifyRelayIntent(text).isRelay) return true;
  const t = String(text || '').toLowerCase();
  return /(মনে করিয়ে|মনে করিয়ে|মনে রাখ|বলে দিও|জানিয়ে দিও|জানিয়ে দিও|ফোন দিতে বল|কল দিতে বল|আমাকে ফোন|আমায় ফোন|আমায় ফোন|call me|tell him|tell safi|remind|online ashle|online hole|safi online|অনলাইনে আসলে|স্যার ডাকছে|স্যার নাকি ডাকছে|safi sir dakche|sir dakche|safi ke phone dite bol|সাফিকে বল|সাফি কে বল|safi ke bolo|phone dite bol|কালকে.{0,20}(কলেজ|স্যার|যাবি|যাবে)|আগামীকাল.{0,20}(কলেজ|স্যার|যাবি|যাবে)|tomorrow.{0,30}(college|sir|teacher)|kalke.{0,30}(college|sir|teacher))/i.test(t);
}

function inferTaskDueAt(message) {
  const t = String(message || '').toLowerCase();
  const now = Date.now();
  if (/(আজকে|আজ|today|ajke)/i.test(t)) return now + 60 * 60 * 1000;
  if (/(কালকে|আগামীকাল|কাল|tomorrow|kalke|kal)/i.test(t)) return now + 24 * 60 * 60 * 1000;
  if (/(পরশু|day after tomorrow|porshu)/i.test(t)) return now + 48 * 60 * 60 * 1000;
  if (/(আগামী সপ্তাহ|next week)/i.test(t)) return now + 7 * 24 * 60 * 60 * 1000;
  return null;
}

function inferTaskPriority(message) {
  const t = String(message || '').toLowerCase();
  if (/(জরুরি|জরুরী|urgent|asap|এখনই|এক্ষুনি|emergency)/i.test(t)) return 'URGENT';
  if (/(স্যার|sir|কলেজ|college|ফোন|call|মনে কর|remind|অনলাইনে আসলে)/i.test(t)) return 'HIGH';
  return 'NORMAL';
}

function addOwnerTask(psid, senderName, message) {
  const intent = assistantEngine.classifyRelayIntent(message);
  const duplicate = state.ownerTasks.find(t => t.status === 'OPEN' && t.psid === psid && t.sourceMessage === message);
  if (duplicate) return duplicate;
  state.taskCounter += 1;
  const task = {
    id: 'TK-' + state.taskCounter,
    psid, senderName, sourceMessage: String(message).slice(0, 1000),
    title: String(message).slice(0, 180),
    status: 'OPEN', priority: intent.isRelay ? intent.priority : inferTaskPriority(message), dueAt: intent.isRelay ? intent.dueAt : inferTaskDueAt(message), dueDate: intent.dueDate || null, dueTimeSource: intent.dueTimeSource || null, timeSpecified: Boolean(intent.timeSpecified), reminderDelivery: intent.dueAt ? { status: 'PENDING', attempts: 0, nextAttemptAt: intent.dueAt, sentAt: null } : null, createdAt: Date.now(), notifiedAt: null, snoozedUntil: null, completedAt: null
  };
  state.ownerTasks.unshift(task);
  if (state.ownerTasks.length > 300) state.ownerTasks.length = 300;
  if (tgBot && ADMIN_CHAT_ID) tgBot.sendMessage(ADMIN_CHAT_ID,
    '📌 ZEVIAN REMINDER ADDED\n\n🆔 ' + task.id + '\n👤 ' + senderName + '\n💬 ' + task.sourceMessage + '\n\nOwner online হলে /tasks দিয়ে দেখতে পারবেন 🙂'
  ).catch(() => {});
  return task;
}

function offlinePersonalReply(text, conv, task) {
  const q = String(text || '').toLowerCase();
  const profile = getContactProfile(conv.psid);
  const isBanglish = conv.prefs.script === 'Banglish (Romanized Bengali)';
  const isEnglish = conv.prefs.script === 'English';
  const isWife = profile.relationship === 'wife' || profile.affectionate;
  if (isWife) {
    if (/(ki koris|কি কর)/i.test(q)) return isBanglish ? 'Ei to, Safi Sir-er kajgulo dekhashona korchi Sona 🙂 Tumi ki korcho? 💙' : 'এইতো, সাফি স্যারের কাজগুলো সামলাচ্ছি সোনা 🙂 তুমি কী করছো? 💙';
    if (/(kha|খে|খাই)/i.test(q)) return isBanglish ? 'Eta Safi Sir-er kach theke confirm kore bolte hobe Bou 😊 Tumi kheyecho to? 💗' : 'এটা সাফি স্যারের কাছ থেকেই নিশ্চিত করে বলতে হবে বউ 😊 তুমি খেয়েছো তো? 💗';
    if (/(koi|kothay|কোথায়|কোথায়)/i.test(q)) return isBanglish ? 'Safi Sir ekhon online nei Janu. Hoyto kono kaje byasto achhen. Ki dorkar bolo, ami mone koriye rakhbo 💙' : 'সাফি স্যার এখন অনলাইনে নেই জানু। হয়তো কোনো কাজে ব্যস্ত আছেন। কী দরকার বলো, আমি মনে করিয়ে রাখব 💙';
    return isBanglish ? 'Safi Sir ekhon online nei Sona. Tomar kothata ami note kore rakhlam, uni online hole janabo 😊💗' : 'সাফি স্যার এখন অনলাইনে নেই সোনা। তোমার কথাটা নোট করে রাখলাম, উনি অনলাইনে এলে জানাবো 😊💗';
  }
  if (/(কি কর|ki koris|ki koros|what are you doing)/i.test(q)) return isEnglish ? 'I’m here helping with Safi Sir’s messages and work 🙂 What can I help you with?' : isBanglish ? 'Ei to, Safi Sir-er kajgulo niye achi 🙂 Tomar ki dorkar bolo?' : 'এইতো, সাফি স্যারের কাজগুলো সামলাচ্ছি 🙂 তোমার কী দরকার বলো?';
  if (/(কই|কোথায়|কোথায়|koi|kothay|where are you)/i.test(q)) return isEnglish ? 'Safi Sir is offline right now. He may be busy with something. What did you need? I can leave him a reminder 🙂' : isBanglish ? 'Safi Sir ekhon online nei. Hoyto kono kaje byasto achhen. Ki dorkar bolo, ami mone koriye rakhbo 🙂' : 'সাফি স্যার এখন অনলাইনে নেই। হয়তো কোনো কাজে ব্যস্ত আছেন। কী দরকার বলো, আমি তাঁকে মনে করিয়ে রাখব 🙂';
  if (/(kha|খে|খাই|eaten|eat)/i.test(q)) return isEnglish ? 'I’d need to confirm that with Safi Sir. He is offline right now 🙂 Have you eaten?' : isBanglish ? 'Eta Safi Sir-er kach theke jene bolte hobe. Uni ekhon online nei 🙂 Tumi kheyecho?' : 'এটা সাফি স্যারের কাছ থেকেই জেনে বলতে হবে। তিনি এখন অনলাইনে নেই 🙂 তুমি খেয়েছো?';
  if (/(কলেজ|college|jabi|jaba|যাবি|যাবে|যাবেন)/i.test(q)) return isEnglish ? 'Is there something about college I should pass on? I’ll let Safi Sir know when he is back online 🙂' : isBanglish ? 'College niye kono dorkar ache? Ki bolte hobe bolo, Safi Sir online hole janabo 🙂' : 'কলেজের বিষয়ে কোনো দরকার আছে? কী বলতে হবে বলো, সাফি স্যার অনলাইনে এলে জানাবো 🙂';
  return task
    ? (isEnglish ? 'Safi Sir is offline right now. I’ve saved your message as a reminder for him 🙂' : isBanglish ? 'Safi Sir ekhon online nei. Tomar kothata reminder hisebe save kore rakhlam 🙂' : 'সাফি স্যার এখন অনলাইনে নেই। তোমার কথাটি তাঁর জন্য রিমাইন্ডার হিসেবে রেখে দিলাম 🙂')
    : (isEnglish ? 'Safi Sir is offline right now. What did you need? I can pass along an important message 🙂' : isBanglish ? 'Safi Sir ekhon online nei. Ki dorkar bolo? Dorkar hole message-ta mone koriye debo 🙂' : 'সাফি স্যার এখন অনলাইনে নেই। কী দরকার বলো? প্রয়োজন হলে কথাটি তাঁকে মনে করিয়ে দেব 🙂');
}

function scheduleRelationshipFollowup(psid, conv, followup, inboundAt) {
  const profile = getContactProfile(psid);
  if (profile.relationship !== 'wife' || profile.affectionate !== true || !followup || typeof followup !== 'string') return;
  const schedule = assistantEngine.makeProactiveSchedule(profile, { ...conv, lastUserAt: inboundAt }, withEmoji(followup.slice(0, 400), '💙'));
  if (schedule) profile.pendingProactive = schedule;
}

async function processDueTaskReminders(now = Date.now()) {
  if (!tgBot || !ADMIN_CHAT_ID) return;
  for (const task of state.ownerTasks) {
    const delivery = task.reminderDelivery;
    if (task.status !== 'OPEN' || !task.dueAt || !delivery || delivery.status === 'SENT' || Number(delivery.nextAttemptAt || task.dueAt) > now) continue;
    if (delivery.status === 'SENDING' && now - Number(delivery.attemptAt || 0) < 5 * 60 * 1000) continue;
    delivery.status = 'SENDING'; delivery.attemptAt = now;
    try {
      await tgBot.sendMessage(ADMIN_CHAT_ID, `⏰ ZEVIAN REMINDER\n\n🆔 ${task.id} | ${task.priority || 'NORMAL'}\n👤 ${task.senderName}\n📝 ${task.title}\n\n/done ${task.id} • /snooze ${task.id} 1h`);
      delivery.status = 'SENT'; delivery.sentAt = Date.now(); delivery.lastError = null;
    } catch (error) {
      delivery.status = 'PENDING'; delivery.attempts = Number(delivery.attempts || 0) + 1;
      delivery.nextAttemptAt = now + Math.min(6 * 60 * 60 * 1000, 60 * 1000 * (2 ** Math.min(delivery.attempts, 8)));
      delivery.lastError = String(error.message || error).slice(0, 240);
    }
  }
}

async function processWifeProactiveMessages(now = Date.now()) {
  for (const [psid, profile] of Object.entries(state.contactProfiles)) {
    const schedule = profile && profile.pendingProactive;
    if (!schedule || !['PENDING', 'SENDING'].includes(schedule.status)) continue;
    if (schedule.status === 'SENDING' && now - Number(schedule.attemptAt || 0) < 5 * 60 * 1000) continue;
    if (schedule.status === 'SENDING') schedule.status = 'PENDING';
    const conv = state.conversations[psid];
    if (!assistantEngine.isProactiveScheduleValid(schedule, conv, profile, now)) {
      if (now >= Number(schedule.expiresAt || 0) || Number(conv && conv.lastUserAt || 0) !== Number(schedule.inboundAt) || profile.relationship !== 'wife' || profile.affectionate !== true) schedule.status = 'CANCELLED';
      continue;
    }
    if (now < Number(schedule.nextAttemptAt || schedule.scheduledAt)) continue;
    schedule.status = 'SENDING'; schedule.attemptAt = now;
    const sent = await sendPageReply(psid, schedule.message, 'ZEVIAN');
    if (sent) { profile.lastProactiveAt = Date.now(); schedule.status = 'SENT'; schedule.sentAt = Date.now(); }
    else { schedule.status = 'PENDING'; schedule.attempts = Number(schedule.attempts || 0) + 1; schedule.nextAttemptAt = now + Math.min(30 * 60 * 1000, 30 * 1000 * (2 ** Math.min(schedule.attempts, 6))); }
  }
}

async function runScheduledJobs() {
  await processDueTaskReminders();
  await processWifeProactiveMessages();
}

function hasEmoji(text) {
  return /\p{Extended_Pictographic}/u.test(String(text || ''));
}

function withEmoji(text, fallback = '🙂') {
  const clean = String(text || '').trim();
  return clean ? (hasEmoji(clean) ? clean : clean + ' ' + fallback) : fallback;
}

function fallbackSuggestions(script) {
  if (script === 'Banglish (Romanized Bengali)') return ['Hmm, ektu pore janacchi 🙂', 'Ekhon sure na, pore bolbo 🙏', 'Dekhe tomake janacchi 😊'];
  if (script === 'English') return ['I will let you know shortly 🙂', 'I am not sure yet; I will confirm later 🙏', 'Let me check and get back to you 😊'];
  if (script === 'Mixed (Bangla+English)') return ['আচ্ছা, ektu পরে জানাচ্ছি 🙂', 'এখন sure না, পরে confirm করব 🙏', 'দেখে তোমাকে জানাচ্ছি 😊'];
  return ['আচ্ছা, একটু পরে জানাচ্ছি 🙂', 'এখন নিশ্চিত নই, পরে জানাবো 🙏', 'বিষয়টা দেখে তোমাকে জানাচ্ছি 😊'];
}

function fallbackUserReply(script, ownerNotified) {
  if (script === 'Banglish (Romanized Bengali)') return ownerNotified ? 'Ektu technical problem hocche. Tomar message-ta owner-er kache pathano hoyeche, tini dekhe janaben 🙂' : 'Ektu technical problem hocche. Doya kore kichukhon por abar message dio 🙂';
  if (script === 'English') return ownerNotified ? 'I am having a brief technical issue. I have sent your message to the page owner, who can follow up 🙂' : 'I am having a brief technical issue. Please try again in a little while 🙂';
  return ownerNotified ? 'সাময়িকভাবে AI উত্তর দিতে সমস্যায় পড়েছে। তোমার মেসেজটি Owner-এর কাছে পাঠানো হয়েছে, তিনি দেখে জানাবেন 🙂' : 'সাময়িকভাবে উত্তর দিতে সমস্যা হচ্ছে। অনুগ্রহ করে একটু পরে আবার মেসেজ দিও 🙂';
}

function isPersonalQuestion(text) {
  const t = String(text || '').toLowerCase();
  return /(কোথায়|কোথায়).{0,8}(আছ|আছেন|আছো)|কলেজ.{0,18}(যাবি|যাবে|যাবেন|যাব|যাচ্ছ)|(?:আজ|কাল|আগামীকাল).{0,20}(যাবি|যাবে|যাবেন|যাব|আসবি|আসবে|আসব)|খেয়েছ|খেয়েছ|খাইছ|ফোন.{0,12}(দিব|দেব|কর)|কখন.{0,12}(আস|যাব)|\b(where are you|are you at home|are you home|what are you doing|are you coming|will you come|have you eaten|did you eat|can i call you|can you call me|when are you free|are you busy|what are your plans|when can we meet|ki koris|ki koros|ki korcho|ki korteso|kothay acho|kothay aso|kothay chili|koi chili|koi chilis|koi achis|koi achos|kalke jaba|kalke jabi|kalke asbi|kalke asba|ajke jabi|ajke asbi|kalke college jabi|college jaba|college jabi|khaiso|khaichis|khaicis)\b/i.test(t);
}
function statusMayAnswerQuestion(text) {
  const q = String(text || '').toLowerCase();
  return getActiveStatuses().some(item => {
    const st = String(item.text || '').toLowerCase();
    const asksLocation = /(কোথায়|কোথায়|where|kothay)/i.test(q);
    const asksActivity = /(কি কর|কি করছ|what are you doing|ki koris|ki koros)/i.test(q);
    const asksAvailability = /(আসবে|আসব|আছ|available|free|ব্যস্ত|busy|asba|ashba)/i.test(q);
    const asksSchedule = /(কাল|আজ|tomorrow|today|kalke|ajke)/i.test(q) && /(কলেজ|college|যাব|যাবে|যাবি|আস|jabi|jaba|jabo|asbo|asba)/i.test(q);
    const asksCollege = /(কলেজ|college)/i.test(q);
    const asksFood = /(খেয়েছ|খেয়েছ|খাইছ|khaiso|khaichis|kheyecho)/i.test(q);
    const statusHasLocation = /(বাইরে|বাসায়|বাসায়|কলেজ|কাজে|outside|college|office|basay|baire)/i.test(st);
    const statusHasAvailability = /(ব্যস্ত|কাজে|ক্লাস|busy|meeting|class|পরে|দেরি|ফিরে|আসছি|pore|deri|free|available)/i.test(st);
    const statusHasCollege = /(কলেজ|college)/i.test(st);
    const statusHasSchedule = /(কাল|আজ|tomorrow|today|কলেজ|college|যাব|যাবে|যাবি|আস|jabo|jabi|jaba|asbo|asba)/i.test(st);
    const statusHasFood = /(খেয়েছি|খেয়েছি|খাইছি|খাওয়া|খাওয়া|kheyechi|khaisi|khaichi)/i.test(st);
    const scheduleDirectlyMatches = asksSchedule && statusHasSchedule && (!asksCollege || statusHasCollege);
    return (asksLocation && statusHasLocation) || (asksActivity && (statusHasLocation || statusHasAvailability)) || (asksAvailability && statusHasAvailability) || scheduleDirectlyMatches || (asksFood && statusHasFood);
  });
}
const STATUS_CUES = [
  'বাইরে যাচ্ছি', 'ব্যস্ত আছি', 'ব্যস্ত থাকব', 'কলেজে যাচ্ছি', 'খেয়ে নিয়েছি', 'খেয়ে নিয়েছি',
  'অনলাইনে থাকব না', 'পাওয়া যাবে না', 'পাওয়া যাবে না', 'ঘুমাচ্ছি', 'বাসায় আছি', 'বাসায় আছি',
  'ami baire', 'ami busy', 'busy achi', 'office e achi', 'college e achi', 'class e achi', 'kheyechi', 'khaisi', 'ghumacchi', 'basay achi'
];

const processedIds = new Set();
let activeReplyPendingId = null, pendingDraftStatus = null, lastGeminiError = null, lastGeminiModel = null, lastGeminiTestAt = null, tgBot = null;

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
  // Fail closed: never accept an unsigned webhook when the App Secret is missing.
  if (!APP_SECRET || !req.rawBody) return false;
  const sig = req.headers['x-hub-signature-256'];
  if (typeof sig !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(sig)) return false;
  const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex'));
  const received = Buffer.from(sig);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
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
  const t = String(text || '').trim(), low = t.toLowerCase();
  const hasBn = /[\u0980-\u09FF]/.test(t);
  const hasEn = /[a-zA-Z]{2,}/.test(t);
  const hasBanglish = /\b(ami|amar|amr|tumi|tomar|tmr|tui|tor|ki|kno|keno|kor|koro|koris|koros|korteso|korcho|kemon|acho|aso|ase|ache|nai|na|valo|bhalo|kothay|koi|khobor|kalke|ajke|khaiso|khaichis|jabo|jabi|jaba|jao|asbo|asbi|asba|hobe|hoise|bol|bolo|bolchi|thak|chup|kichu|bujhi|accha|acha|diba|dibo)\b/.test(low);
  if (hasBn && hasEn) conv.prefs.script = 'Mixed (Bangla+English)';
  else if (hasBn) conv.prefs.script = 'Bengali Script';
  else if (hasBanglish) conv.prefs.script = 'Banglish (Romanized Bengali)';
  else if (hasEn) conv.prefs.script = 'English';
  if (/\b(tui|tor|koris|koros|achis|khaichis|khaicis|jabi|asbi)\b/.test(low) || /(তুই|তোর|করিস|আছিস|খেয়েছিস|খেয়েছিস|খাইছিস|যাবি|আসবি)/u.test(t)) conv.prefs.pronoun = 'তুই (casual)';
  else if (/\b(apni|apnar|korchen|achen)\b/.test(low) || /(আপনি|আপনার|করছেন|আছেন)/u.test(t)) conv.prefs.pronoun = 'আপনি (formal)';
  else if (/\b(tumi|tomar|korcho|acho|jaba|jabe)\b/.test(low) || /(তুমি|তোমার|করছ|আছো|যাবে)/u.test(t)) conv.prefs.pronoun = 'তুমি (friendly)';
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
  lastGeminiModel = null;
  lastGeminiTestAt = new Date().toISOString();
  if (!GEMINI_API_KEY) { lastGeminiError = 'Missing GEMINI_API_KEY'; return null; }
  const conv = getConv(psid);
  const history = conv.messages.slice(-10).map(m => `${m.role}: ${m.text}`).join('\n');
  const recentBotReplies = conv.messages.filter(m => m.role === 'ZEVIAN').slice(-3).map(m => m.text).join(' | ');
  const activeSt = getActiveStatuses();
  const stBlock = activeSt.length ? activeSt.map(s => `- ${s.text}`).join('\n') : '(None)';
  const kbBlock = state.kbItems.map(i => `Q: ${i.question} | A: ${i.answer}`).join('\n');
  const contact = getContactProfile(psid);
  const relationshipBlock = contact.relationship === 'wife' && contact.affectionate === true ? 'This sender is explicitly tagged by the Owner with /tag PSID wife. Match the real chat examples: concise, casual Banglish when she writes Banglish; mirror tui/tumi; natural affectionate wording, occasional emojis, context continuity, playful warmth when appropriate. Avoid repeating the same filler or sending many duplicate elongated messages. Never impersonate Safi or invent his private facts. A short proactive follow-up is allowed only if natural and policy-eligible.' : `Contact label: ${contact.label || 'Friend'}. Do not send proactive messages to this contact.`;

  const prompt = `${state.config.systemPrompt}
Owner Display Name: ${state.config.ownerDisplayName}
Contact Relationship: ${relationshipBlock}
Owner Presence: ${state.ownerPresence}
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
5. If PERSONAL (owner's plans/location/eating/college/calls without an active status that directly answers the exact question), SENSITIVE, URGENT, or COMPLAINT: set requires_owner=true and suggested_reply="". Never infer an answer from an unrelated status.
6. Every suggested_reply and every owner_suggestions item must include at least one suitable emoji and must use the sender's language/script.
Return ONLY valid JSON: {"classification":"GENERAL","confidence":0.95,"requires_owner":false,"reason":"...","suggested_reply":"...","owner_suggestions":["...","...","..."],"follow_up":""}. Set follow_up only for explicitly tagged wife/partner contacts and only when a natural second message would add value; otherwise empty string.`;

  // 2.5 model access is restricted for many new API projects; migrate old Render settings automatically.
  const configuredModel = (process.env.GEMINI_MODEL || '').trim();
  const legacyModel = /^gemini-2\.5-/i.test(configuredModel);
  const models = [...new Set([(!legacyModel && configuredModel) || null, 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash'].filter(Boolean))];
  for (const m of models) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY }, signal: AbortSignal.timeout(25000),
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.65, responseMimeType: 'application/json', maxOutputTokens: 700 } })
      });
      const d = await res.json();
      if (!res.ok) {
        lastGeminiError = `${m} HTTP ${res.status}: ${d.error ? d.error.message : 'Error'}`;
        if (res.status === 401 || res.status === 403) return null;
        if ([400, 404, 429, 500, 502, 503, 504].includes(res.status)) continue;
        return null;
      }
      const raw = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
      if (raw) {
        const parsed = JSON.parse(raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim());
        const allowed = ['GENERAL', 'PERSONAL', 'UNCERTAIN', 'SENSITIVE', 'URGENT', 'COMPLAINT', 'SPAM', 'FOLLOW_UP'];
        const classification = String(parsed.classification || 'UNCERTAIN').toUpperCase();
        const safeClass = allowed.includes(classification) ? classification : 'UNCERTAIN';
        const requiresOwner = Boolean(parsed.requires_owner) || ['PERSONAL', 'UNCERTAIN', 'SENSITIVE', 'URGENT', 'COMPLAINT'].includes(safeClass);
        const suggestions = Array.isArray(parsed.owner_suggestions) ? parsed.owner_suggestions.slice(0, 4).map(v => withEmoji(v, '🙂')) : [];
        lastGeminiError = null;
        lastGeminiModel = m;
        return {
          classification: safeClass,
          confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
          requires_owner: requiresOwner,
          reason: String(parsed.reason || 'Owner review required').slice(0, 250),
          suggested_reply: requiresOwner ? '' : (String(parsed.suggested_reply || '').trim() ? withEmoji(parsed.suggested_reply, '🙂') : ''),
          owner_suggestions: suggestions.length ? suggestions : fallbackSuggestions(conv.prefs.script),
          follow_up: !requiresOwner && typeof parsed.follow_up === 'string' ? parsed.follow_up.trim().slice(0, 400) : ''
        };
      }
    } catch (e) { lastGeminiError = `${m}: ${e.message}`; }
  }
  return null;
}

function escalate(psid, name, q, cls, reason, suggs = []) {
  state.pendingCounter += 1; state.stats.escalated += 1;
  const pid = `PR-${state.pendingCounter}`;
  const clean = (Array.isArray(suggs) && suggs.length ? suggs.slice(0, 4) : fallbackSuggestions(getConv(psid).prefs.script)).map(v => withEmoji(v, '🙂'));
  state.pendingReplies[pid] = { id: pid, psid, senderName: name, question: q, classification: cls, reason, suggestions: clean, status: 'WAITING' };
  if (tgBot && ADMIN_CHAT_ID) {
    const sLines = clean.map((s, i) => `${i + 1}. ${s}`).join('\n');
    const sRow = clean.map((_, i) => ({ text: `✅ #${i + 1}`, callback_data: `sugg:${pid}:${i}` }));
    tgBot.sendMessage(ADMIN_CHAT_ID, `🚨 ZEVIAN — ${cls} QUESTION\n\n🆔 ${pid} | 👤 ${name}\n💬 PSID: ${psid}\n💡 ${reason}\n\n❓ Message:\n${q}\n\n✨ AI Suggestions (1-Tap Send):\n${sLines}`, {
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
  const safeText = withEmoji(text, '🙂');
  const res = await callGraph('me/messages', { recipient: { id: psid }, message: { text: safeText } });
  if (res && res.message_id) {
    pushMsg(psid, 'Owner', safeText); state.stats.ownerReplied += 1;
    if (pid && state.pendingReplies[pid]) { state.pendingReplies[pid].status = 'ANSWERED'; state.pendingReplies[pid].ownerReply = safeText; }
    return true;
  }
  return false;
}

async function sendPageReply(psid, text, role = 'ZEVIAN') {
  const safeText = withEmoji(text, '🙂');
  const res = await callGraph('me/messages', { recipient: { id: psid }, message: { text: safeText } });
  if (res && res.message_id) {
    pushMsg(psid, role, safeText);
    if (role === 'ZEVIAN') state.stats.autoReplied += 1;
    return true;
  }
  return false;
}

app.get('/webhook', (req, res) => {
  const verifyToken = (process.env.FB_VERIFY_TOKEN || '').trim();
  if (!verifyToken) return res.status(503).send('Webhook verification is not configured');
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verifyToken) {
    return res.status(200).send(String(req.query['hub.challenge'] || ''));
  }
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
        if (mid) {
          processedIds.add(mid);
          if (processedIds.size > 5000) processedIds.delete(processedIds.values().next().value);
        }
        state.stats.totalIn += 1;
        const name = await fetchSenderName(psid);
        const conv = getConv(psid, name);

        if (!ev.message?.text && ev.message?.attachments?.length) {
          const att = ev.message.attachments[0];
          if (ev.message.sticker_id) {
            await sendPageReply(psid, '😊', 'ZEVIAN');
          } else {
            await sendPageReply(psid, conv.prefs.script === 'English' ? 'I received your attachment. I will review it and get back to you 🙂' : 'তোমার পাঠানো ফাইল/ছবি পেয়েছি। দেখে জানাচ্ছি 🙂', 'ZEVIAN');
            escalate(psid, name, `[${String(att.type || 'file').toUpperCase()} attachment received]`, 'UNCERTAIN', `User sent ${att.type || 'file'} media`, fallbackSuggestions(conv.prefs.script));
          }
          continue;
        }
        const text = ev.message?.text;
        if (!text) continue;
        pushMsg(psid, 'User', text);
        await callGraph('me/messages', { recipient: { id: psid }, sender_action: 'typing_on' });
        const relayIntent = assistantEngine.classifyRelayIntent(text);
        const ownerTask = (relayIntent.isRelay || isTaskIntent(text)) ? addOwnerTask(psid, name, text) : null;
        if (relayIntent.isRelay) {
          await sendPageReply(psid, assistantEngine.buildRelayAcknowledgement(conv.prefs.script, ownerTask), 'ZEVIAN');
          continue;
        }
        // Owner presence decides whether personal questions are escalated or handled with a transparent offline response.
        if (isPersonalQuestion(text) && !statusMayAnswerQuestion(text) && state.ownerPresence === 'offline') {
          const offlineReply = offlinePersonalReply(text, conv, ownerTask);
          await sendPageReply(psid, offlineReply, 'ZEVIAN');
          continue;
        }
        // When Owner is online, personal questions are routed to Owner approval.
        if (isPersonalQuestion(text) && !statusMayAnswerQuestion(text)) {
          const holdMsg = conv.prefs.script === 'Banglish (Romanized Bengali)'
            ? 'Ei proshnotar uttor amar Owner dite parben. Ektu opekkha koro 🙂'
            : conv.prefs.script === 'English'
            ? 'Only my Owner can answer this personal question. Please wait a moment 🙂'
            : 'এই ব্যক্তিগত প্রশ্নটির উত্তর আমার Owner দিতে পারবেন। একটু অপেক্ষা করো 🙂';
          await sendPageReply(psid, holdMsg, 'ZEVIAN');
          escalate(psid, name, text, 'PERSONAL', 'Personal question; no directly relevant approved status', fallbackSuggestions(conv.prefs.script));
          continue;
        }

        const ai = await analyzeMessage(psid, text);
        if (!ai) {
          const ownerNotified = Boolean(tgBot && ADMIN_CHAT_ID);
          await sendPageReply(psid, fallbackUserReply(conv.prefs.script, ownerNotified), 'ZEVIAN');
          escalate(psid, name, text, 'UNCERTAIN', `Gemini unavailable: ${lastGeminiError || 'all model attempts failed'}`, fallbackSuggestions(conv.prefs.script));
          continue;
        }
        const cls = (ai.classification || 'UNCERTAIN').toUpperCase();
        if (cls === 'SPAM') continue;
        if ((cls === 'GENERAL' || cls === 'FOLLOW_UP') && !ai.requires_owner && Number(ai.confidence || 0) >= state.config.confidenceThreshold && ai.suggested_reply) {
          const replyText = withEmoji(ai.suggested_reply, '🙂');
          const sent = await sendPageReply(psid, replyText, 'ZEVIAN');
          if (sent && tgBot && ADMIN_CHAT_ID) tgBot.sendMessage(ADMIN_CHAT_ID, `💬 ZEVIAN (${cls})\n👤 ${name} [${conv.prefs.script} | ${conv.prefs.pronoun}]\n📩 ${text}\n🤖 ${replyText}`).catch(() => {});
          if (sent && ai.follow_up) scheduleRelationshipFollowup(psid, conv, ai.follow_up, conv.lastUserAt);
        } else {
          const holdMsg = conv.prefs.script === 'Banglish (Romanized Bengali)'
            ? 'Ei bishoyta amar Owner-er sathe confirm kore janacchi 🙂'
            : conv.prefs.script === 'English'
            ? 'I will check this with my Owner and get back to you 🙂'
            : 'বিষয়টি আমার Owner-এর সঙ্গে নিশ্চিত করে জানাচ্ছি 🙂';
          await sendPageReply(psid, holdMsg, 'ZEVIAN');
          escalate(psid, name, text, cls, ai.reason || 'Owner approval needed', ai.owner_suggestions || fallbackSuggestions(conv.prefs.script));
        }
      }
    }
    if (entry.changes) {
      for (const ch of entry.changes) {
        if (ch.field === 'feed' && ch.value?.item === 'comment' && ch.value?.verb === 'add') {
          const cid = ch.value.comment_id, fid = ch.value.from?.id, fn = ch.value.from?.name || 'Friend', ct = ch.value.message || '';
          if (!cid || fid === pageId || !ct || processedIds.has(cid)) continue;
          processedIds.add(cid);
          if (processedIds.size > 5000) processedIds.delete(processedIds.values().next().value);
          const ai = await analyzeMessage(`c_${fid || cid}`, `[Post Comment]: ${ct}`);
          const rep = withEmoji((ai && ai.suggested_reply) || `ধন্যবাদ ${fn}! কীভাবে সাহায্য করতে পারি?`, '😊');
          if (state.config.commentReplyEnabled) await callGraph(`${cid}/comments`, { message: `ধন্যবাদ ${fn}! আপনার ইনবক্সে বিস্তারিত পাঠিয়ে দেওয়া হয়েছে 😊` });
          if (state.config.commentInboxEnabled) await callGraph(`${pageId}/messages`, { recipient: { comment_id: cid }, message: { text: rep } });
        }
      }
    }
  }
});

if (BOT_TOKEN) {
  tgBot = new TelegramBot(BOT_TOKEN, { polling: false });

  // Register native Telegram Slash Command Menu automatically!
  tgBot.setMyCommands([
    { command: 'start', description: 'ZEVIAN কন্ট্রোল প্যানেল খুলুন' },
    { command: 'status', description: 'সিস্টেম ও বটের বর্তমান অবস্থা দেখুন' },
    { command: 'online', description: 'Owner online presence চালু করুন' },
    { command: 'offline', description: 'Owner offline presence চালু করুন' },
    { command: 'tasks', description: 'Owner reminder ও task দেখুন' },
    { command: 'snooze', description: 'Reminder পরে দেখানোর জন্য Snooze করুন' },
    { command: 'delete_task', description: 'একটি Reminder archive করুন' },
    { command: 'done', description: 'একটি task সম্পন্ন করুন' },
    { command: 'tag', description: 'কন্টাক্টের সম্পর্ক ও tone tag করুন' },
    { command: 'untag', description: 'কন্টাক্টের custom tag সরান' },
    { command: 'tags', description: 'Tagged contacts দেখুন' },
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

  // Owner controls must be disabled unless an explicit Telegram admin chat ID is configured.
  const isOwner = cid => Boolean(ADMIN_CHAT_ID) && String(cid) === String(ADMIN_CHAT_ID);
  const sendMenu = cid => {
    const wait = Object.values(state.pendingReplies).filter(p => p.status === 'WAITING').length;
    const act = getActiveStatuses();
    tgBot.sendMessage(cid, `🤖 *ZEVIAN v4.8 Control Center*\n• Owner Presence: ${state.ownerPresence === 'online' ? '🟢 ONLINE' : '🌙 OFFLINE'}\n• Master: ${state.config.masterActive ? '✅ ON' : '⏸ PAUSED'} | Mode: *Banglish Mirror*\n• Gemini: ${lastGeminiModel ? '✅ ' + lastGeminiModel : (lastGeminiError ? '⚠️ Error (/testgemini)' : '⏳ Not tested yet')}\n• Active Status: _${act.length ? act[0].text : 'কোনো Status নেই'}_\n• Active Chats: ${Object.keys(state.conversations).length} | Pending: ${wait} | Auto: ${state.stats.autoReplied}`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: state.ownerPresence === 'online' ? '🌙 Set Offline' : '🟢 Set Online', callback_data: 'presence_toggle' }, { text: '📌 Tasks', callback_data: 'show_tasks' }],
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
      `• /online — আপনি অনলাইনে; ব্যক্তিগত প্রশ্ন আপনার কাছে পাঠাবে\n` +
      `• /offline — আপনি অনলাইনে নেই; ZEVIAN নিজে সামলাবে\n` +
      `• /tasks — Reminders দেখুন; /done TK-201 দিয়ে সম্পন্ন করুন\n` +
      `• /snooze TK-201 1d — পরে দেখান; /delete_task TK-201 — archive\n` +
      `• /tag PSID wife — কন্টাক্টকে Wife/Partner হিসেবে ট্যাগ করুন\n` +
      `• /untag PSID — কাস্টম সম্পর্ক সরান; /tags — ট্যাগ লিস্ট\n` +
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
  tgBot.onText(/\/online$/i, m => {
    if (!isOwner(m.chat.id)) return;
    state.ownerPresence = 'online';
    const open = state.ownerTasks.filter(t => t.status === 'OPEN');
    const visible = open.filter(t => !t.snoozedUntil || t.snoozedUntil <= Date.now());
    visible.forEach(t => { t.notifiedAt = Date.now(); });
    const summary = visible.slice(0, 15).map(t => t.id + ' [' + (t.priority || 'NORMAL') + ']' + (t.dueAt ? ' • ' + new Date(t.dueAt).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' }) : '') + ' — ' + t.senderName + ': ' + t.title).join('\n');
    tgBot.sendMessage(m.chat.id, '🟢 Owner presence: ONLINE\nএখন ব্যক্তিগত প্রশ্ন আপনার কাছে পাঠানো হবে।\n\n📌 Due / Ready Reminder: ' + visible.length + ' / ' + open.length + '\n' + (summary || 'এখন কোনো Ready Reminder নেই।') + '\n\n/tasks দিয়ে সব দেখুন • /done TK-201');
    sendMenu(m.chat.id);
  });
  tgBot.onText(/\/offline$/i, m => {
    if (!isOwner(m.chat.id)) return;
    state.ownerPresence = 'offline';
    tgBot.sendMessage(m.chat.id, '🌙 Owner presence: OFFLINE\nএখন ব্যক্তিগত প্রশ্নে ZEVIAN ভদ্রভাবে জানাবে আপনি অনলাইনে নেই এবং প্রয়োজন বুঝে Reminder তৈরি করবে 🙂');
    sendMenu(m.chat.id);
  });
  tgBot.onText(/\/snooze\s+(TK-\d+)\s+(1h|3h|6h|1d|2d)/i, (m, match) => {
    if (!isOwner(m.chat.id)) return;
    const task = state.ownerTasks.find(t => t.id.toUpperCase() === match[1].toUpperCase() && t.status === 'OPEN');
    if (!task) return tgBot.sendMessage(m.chat.id, 'Open Task পাওয়া যায়নি।');
    const duration = { '1h': 3600000, '3h': 10800000, '6h': 21600000, '1d': 86400000, '2d': 172800000 }[match[2].toLowerCase()];
    task.snoozedUntil = Date.now() + duration;
    tgBot.sendMessage(m.chat.id, '⏰ ' + task.id + ' Snooze করা হয়েছে: ' + match[2]);
  });
  tgBot.onText(/\/delete_task\s+(TK-\d+)/i, (m, match) => {
    if (!isOwner(m.chat.id)) return;
    const task = state.ownerTasks.find(t => t.id.toUpperCase() === match[1].toUpperCase());
    if (!task) return tgBot.sendMessage(m.chat.id, 'Task ID পাওয়া যায়নি।');
    task.status = 'DELETED'; task.deletedAt = Date.now();
    tgBot.sendMessage(m.chat.id, '🗑️ ' + task.id + ' archive করা হয়েছে।');
  });
  tgBot.onText(/\/tasks$/i, m => {
    if (!isOwner(m.chat.id)) return;
    const open = state.ownerTasks.filter(t => t.status === 'OPEN');
    const formatTask = t => t.id + ' [' + (t.priority || 'NORMAL') + ']' + (t.dueAt ? ' • Due ' + new Date(t.dueAt).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' }) : '') + (t.snoozedUntil && t.snoozedUntil > Date.now() ? ' • Snoozed' : '') + '\n' + t.senderName + ': ' + t.title;
    tgBot.sendMessage(m.chat.id, open.length ? '📌 Open Reminders (' + open.length + ')\n\n' + open.slice(0, 30).map(formatTask).join('\n\n') + '\n\n/done TK-201 • /snooze TK-201 1d • /delete_task TK-201' : '✅ কোনো Open Reminder নেই 🙂');
  });
  tgBot.onText(/\/done\s+(TK-\d+)/i, (m, match) => {
    if (!isOwner(m.chat.id)) return;
    const task = state.ownerTasks.find(t => t.id.toUpperCase() === match[1].toUpperCase());
    if (!task) return tgBot.sendMessage(m.chat.id, 'এই Task ID পাওয়া যায়নি।');
    task.status = 'DONE'; task.completedAt = Date.now();
    tgBot.sendMessage(m.chat.id, '✅ ' + task.id + ' সম্পন্ন হিসেবে চিহ্নিত হয়েছে।');
  });
  tgBot.onText(/\/tag\s+(\S+)\s+([\s\S]+)/i, (m, match) => {
    if (!isOwner(m.chat.id)) return;
    const psid = match[1].trim(), raw = match[2].trim(), wife = /^(wife|bou|বউ|স্ত্রী|partner|জান)$/i.test(raw);
    state.contactProfiles[psid] = { ...getContactProfile(psid), label: wife ? 'Wife / Partner' : raw.slice(0, 40), relationship: wife ? 'wife' : 'custom', affectionate: wife };
    tgBot.sendMessage(m.chat.id, wife ? '💗 কন্টাক্টটি Wife/Partner হিসেবে ট্যাগ করা হয়েছে। ZEVIAN স্বাভাবিক affectionate tone ব্যবহার করবে; Owner-এর ব্যক্তিগত তথ্য বানিয়ে বলবে না।' : '🏷️ কন্টাক্ট ট্যাগ করা হয়েছে: ' + raw);
  });
  tgBot.onText(/\/untag\s+(\S+)/i, (m, match) => {
    if (!isOwner(m.chat.id)) return;
    delete state.contactProfiles[match[1].trim()];
    tgBot.sendMessage(m.chat.id, '🏷️ কাস্টম সম্পর্ক/টোন সরানো হয়েছে।');
  });
  tgBot.onText(/\/tags$/i, m => {
    if (!isOwner(m.chat.id)) return;
    const entries = Object.entries(state.contactProfiles);
    tgBot.sendMessage(m.chat.id, entries.length ? '🏷️ Tagged Contacts\n\n' + entries.map(([id,p]) => id + ' — ' + p.label).join('\n') : 'এখনো কোনো কন্টাক্ট ট্যাগ করা হয়নি।');
  });
  tgBot.onText(/\/analytics/, m => isOwner(m.chat.id) && tgBot.sendMessage(m.chat.id, `📊 *ZEVIAN Analytics*\n• Incoming: ${state.stats.totalIn}\n• Outgoing: ${state.stats.totalOut}\n• Auto-Replied (AI): ${state.stats.autoReplied}\n• Escalated to Owner: ${state.stats.escalated}\n• Owner Replies: ${state.stats.ownerReplied}\n• Failed: ${state.stats.failed}`, { parse_mode: 'Markdown' }));
  tgBot.onText(/\/mystatus/, m => { if (!isOwner(m.chat.id)) return; const l = getActiveStatuses(); tgBot.sendMessage(m.chat.id, l.length ? `📍 *Active Shareable Statuses:*\n` + l.map(s => `• \`${s.id}\`: ${s.text} (${s.expiresLabel})`).join('\n') : '📍 কোনো Active Status নেই। সেট করতে লিখুন: `/setstatus আমি বাইরে যাচ্ছি`', { parse_mode: 'Markdown' }); });
  tgBot.onText(/\/clearstatus/, m => { if (!isOwner(m.chat.id)) return; state.ownerStatuses.forEach(s => { s.active = false; }); tgBot.sendMessage(m.chat.id, '🛑 সব Active Status বন্ধ করা হয়েছে।'); });
  tgBot.onText(/\/setstatus ([\s\S]+)/, (m, match) => isOwner(m.chat.id) && askStatus(m.chat.id, match[1]));
  tgBot.onText(/\/inbox/, m => { if (!isOwner(m.chat.id)) return; const l = Object.values(state.conversations).slice(-8); tgBot.sendMessage(m.chat.id, l.length ? l.map(c => `👤 *${c.senderName}* (\`${c.psid}\`)\n🗣️ ${c.prefs.script} | ${c.prefs.pronoun}\n└ ${c.messages[c.messages.length - 1]?.text || ''}`).join('\n\n') : '💬 কোনো চ্যাট নেই।', { parse_mode: 'Markdown' }); });
  tgBot.onText(/\/history (\S+)/, (m, match) => { if (!isOwner(m.chat.id)) return; const c = state.conversations[match[1].trim()]; tgBot.sendMessage(m.chat.id, c ? `💬 *${c.senderName} History:*\n` + c.messages.slice(-12).map(x => `[${x.time}] *${x.role}:* ${x.text}`).join('\n') : '⚠️ এই PSID-র কোনো হিস্ট্রি পাওয়া যায়নি।', { parse_mode: 'Markdown' }); });
  tgBot.onText(/\/memory/, m => { if (!isOwner(m.chat.id)) return; tgBot.sendMessage(m.chat.id, `🧠 *ZEVIAN Memory Status*\n• Saved Conversations: ${Object.keys(state.conversations).length}\n• Active Statuses: ${getActiveStatuses().length}\n• Knowledge Base Items: ${state.kbItems.length}\n• Blocked Users: ${state.blockedUsers.length}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🧹 Clear Conversation Memory', callback_data: 'clear_mem' }]] } }); });
  tgBot.onText(/\/testgemini/, async m => { if (!isOwner(m.chat.id)) return; const r = await analyzeMessage('test_bn', 'ki koris?'); tgBot.sendMessage(m.chat.id, r ? `✅ *Gemini v4.7 OK (Banglish Mirror)!*\nModel: \`${lastGeminiModel || 'auto'}\`\nInput: \`ki koris?\`\nClass: \`${r.classification}\`\nReply: ${r.suggested_reply}` : `❌ Error: \`${lastGeminiError}\``, { parse_mode: 'Markdown' }); });
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
    else if (d === 'presence_toggle') { state.ownerPresence = state.ownerPresence === 'online' ? 'offline' : 'online'; if (state.ownerPresence === 'online') { const open = state.ownerTasks.filter(t => t.status === 'OPEN'); open.forEach(t => { t.notifiedAt = Date.now(); }); tgBot.sendMessage(cid, '🟢 আপনি Online। Open Reminder: ' + open.length + '\n' + open.slice(0, 15).map(t => t.id + ' — ' + t.title).join('\n')); } else tgBot.sendMessage(cid, '🌙 আপনি Offline। ZEVIAN ব্যক্তিগত প্রশ্নগুলো ভদ্রভাবে সামলাবে।'); sendMenu(cid); }
    else if (d === 'show_tasks') { const open = state.ownerTasks.filter(t => t.status === 'OPEN'); tgBot.sendMessage(cid, open.length ? open.map(t => t.id + ' — ' + t.senderName + ': ' + t.title).join('\n\n') : 'কোনো Open Reminder নেই।'); }
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

app.get('/health', (req, res) => res.json({ ok: true, version: '5.0.0', persistence: persistence.status(), mode: 'banglish_mirror', ownerPresence: state.ownerPresence, openTasks: state.ownerTasks.filter(t => t.status === 'OPEN').length, taggedContacts: Object.keys(state.contactProfiles).length, masterActive: state.config.masterActive, geminiOk: Boolean(lastGeminiModel), geminiStatus: lastGeminiModel ? 'ready' : (lastGeminiError ? 'error' : 'not_tested'), geminiModel: lastGeminiModel, geminiTestedAt: lastGeminiTestAt, activeStatuses: getActiveStatuses().length, pendingCount: Object.values(state.pendingReplies).filter(p => p.status === 'WAITING').length, uptime: Math.floor(process.uptime()) }));
app.get('/', (req, res) => res.send(`<html><body style="font-family:sans-serif;background:#070b14;color:#f1f5f9;padding:30px"><h2>🤖 ZEVIAN v5.0 Smart Offline Assistant</h2><p>Master: <b>${state.config.masterActive ? 'ACTIVE' : 'PAUSED'}</b> | Gemini: <b>${lastGeminiModel ? 'READY' : (lastGeminiError ? 'ERROR' : 'NOT TESTED')}</b> | Active Statuses: <b>${getActiveStatuses().length}</b></p><p><a style="color:#818cf8" href="/health">/health</a></p></body></html>`));

const PORT = process.env.PORT || 3000;
const missingRequired = [
  ['FB_APP_SECRET', APP_SECRET],
  ['FB_VERIFY_TOKEN', (process.env.FB_VERIFY_TOKEN || '').trim()],
  ['TELEGRAM_ADMIN_CHAT_ID', ADMIN_CHAT_ID]
].filter(([, value]) => !value).map(([name]) => name);
if (missingRequired.length) {
  console.error('ZEVIAN security configuration missing:', missingRequired.join(', '));
}
async function bootstrap() {
  try {
    const connected = await persistence.init();
    if (connected) {
      const saved = await persistence.load();
      if (saved && typeof saved === 'object') {
        for (const key of Object.keys(state)) {
          if (Object.prototype.hasOwnProperty.call(saved, key)) state[key] = saved[key];
        }
        console.log('[persistence] Encrypted owner state restored from PostgreSQL');
      } else {
        console.log('[persistence] New encrypted state store initialized');
        await persistence.save(state);
      }
    }
  } catch (error) {
    console.error('[persistence] Initialization failed; running in memory-only mode:', error.message);
  }
  if (tgBot) {
    try { await tgBot.startPolling(); }
    catch (error) { console.error('[telegram] Polling start failed:', error.message); }
  }
  setInterval(() => { persistence.save(state); }, 1500).unref();
  setInterval(() => { runScheduledJobs().catch(error => console.error('[scheduler] Job cycle failed:', error.message)); }, 15000).unref();
  app.listen(PORT, () => console.log('ZEVIAN v5.0 Smart Offline Assistant running on port', PORT));
}
process.on('SIGTERM', async () => {
  try { await persistence.save(state); await persistence.close(); } finally { process.exit(0); }
});
process.on('SIGINT', async () => {
  try { await persistence.save(state); await persistence.close(); } finally { process.exit(0); }
});
bootstrap();
