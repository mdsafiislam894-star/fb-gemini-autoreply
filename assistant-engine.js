'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const WIFE_PROACTIVE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const PROACTIVE_DELAY_MS = 10 * 60 * 1000;
const DEFAULT_REMINDER_HOUR = 9;
const DHAKA_OFFSET_MINUTES = 360;


function classifyActivityQuestion(message) {
  const text = String(message || '').trim();
  const t = text.toLowerCase();
  const hasBangla = /[\u0980-\u09ff]/.test(text);
  const hasBanglishCue = /\b(ki|koro|koros|koris|korcho|korteso|kortese|kortesen|obostha|khobor|koi|kothay|achis|achos|acho|aso)\b/i.test(t);
  const hasOwner = /\b(safi|owner|sir)\b/i.test(t) || /(সাফি|ওনার|মালিক|স্যার)/u.test(text);
  const activity = /\b(ki|what|doing|koro|koros|koris|korcho|korteso|kortese|kortesen|obostha|kemon|how are you|koi|kothay|achis|achos|acho|aso|where are you)\b/i.test(t) || /(কি কর|কী কর|করছেন|করছে|কেমন আছ|কেমন আছো|কেমন আছেন|ভালো আছ|ভালো আছো|কোথায়|কোথায়|কই)/u.test(text);
  const script = hasBangla ? 'Bengali' : (hasBanglishCue ? 'Banglish' : 'English');
  if (hasOwner && activity) return { kind: 'owner_activity', script };
  if (!hasOwner && activity) return { kind: 'assistant_activity', script };
  return { kind: 'other', script };
}

function classifyGreeting(message) {
  const text = String(message || '').trim();
  const t = text.toLowerCase().replace(/[.!?…]+$/g, '').trim();
  if (/^(হাই+|হ্যালো+|আসসালামু আলাইকুম|সালাম)$/u.test(t)) return { kind: 'greeting', script: 'Bengali' };
  if (/^(oi+|oie+|hey+|hii+|hiii+|hello+|heyy+)$/i.test(t)) return { kind: 'greeting', script: /^(oi+|oie+)$/i.test(t) ? 'Banglish' : 'English' };
  if (/^(hi+|hello+|hey+)$/i.test(t)) return { kind: 'greeting', script: 'English' };
  return { kind: 'other', script: 'English' };
}

function buildGreetingReply(script) {
  if (script === 'Banglish') return 'Oiii! Bolo, ki khobor? 🙂';
  if (script === 'Bengali') return 'হ্যালো! বলো, কেমন আছো? 🙂';
  return 'Hey! How’s it going? 🙂';
}

function isEmojiOnly(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (!/\p{Extended_Pictographic}/u.test(t)) return false;
  const stripped = t.replace(/\p{Extended_Pictographic}/gu, '').replace(/[\uFE0F\u200D\u20E3\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}\u{E0001}\u{E007F}]/gu, '').replace(/[\s.,!?;:()~_+\-*#@$%^&'"/\\<>{}[\]|`=]+/g, '');
  return stripped.length === 0;
}

function buildEmojiReply(text, script = 'Banglish') {
  const t = String(text || '');
  if (/[❤️💖💕💓💗💘💝💞💟🥰😍😘💌]/u.test(t)) {
    if (script === 'Bengali') return 'অনেক ভালোবাসা রইলো! 💖';
    if (script === 'English') return 'Lots of love to you! 💖';
    return 'Onek bhalobasha roilo! 💖';
  }
  if (/[😂🤣😆😹😸]/u.test(t)) {
    if (script === 'Bengali') return 'কী ব্যাপার, খুব হাসির কিছু হলো নাকি? 😆';
    if (script === 'English') return 'Haha, glad you found that funny! 😆';
    return 'Haha, eto hashi keno bolo to? 😆';
  }
  if (/[👍👌✌️🤝🙌👏]/u.test(t)) {
    if (script === 'Bengali') return 'ধন্যবাদ! কোনো প্রয়োজন হলে নির্দ্বিধায় বলো 😊';
    if (script === 'English') return 'Awesome! Let me know if you need anything else 😊';
    return 'Dhonnobad! Kono help lagle janao kintu 😊';
  }
  if (/[👋✋🙋‍♂️🙋‍♀️]/u.test(t)) {
    if (script === 'Bengali') return 'হ্যালো! বলো, কীভাবে সাহায্য করতে পারি? 🙂';
    if (script === 'English') return 'Hey there! How can I help you today? 🙂';
    return 'Heyy! Ki khobor, bolo kivabe help korte pari? 🙂';
  }
  if (/[🔥⭐🌟✨💯😎]/u.test(t)) {
    if (script === 'Bengali') return 'একদম দারুণ! 🔥';
    if (script === 'English') return 'Super awesome! 🔥';
    return 'Joss! Ekdom darun 🔥';
  }
  if (/[🥺😢😭💔😿😞😔]/u.test(t)) {
    if (script === 'Bengali') return 'আরে মন খারাপ কোরো না, সব ঠিক হয়ে যাবে 💙';
    if (script === 'English') return 'Hey, don’t be sad! Everything will be alright 💙';
    return 'Arey mon kharap koro na, shob thik hoye jabe 💙';
  }
  if (/[🙏💐🌸🌹🌷🌺]/u.test(t)) {
    if (script === 'Bengali') return 'সবসময় স্বাগতম! ভালো থেকো 🙂';
    if (script === 'English') return 'You are always welcome! 🙂';
    return 'Shobshomoy swagotom! Valo theko 🙂';
  }
  if (script === 'Bengali') return 'সুন্দর! বলো, কেমন কাটছে সময়? 😊';
  if (script === 'English') return 'Nice! How are you doing today? 😊';
  return 'Sundor! Bolo, kemon cholche shobkichu? 😊';
}

function classifyChitChat(message) {
  const text = String(message || '').trim();
  const t = text.toLowerCase().replace(/[.!?…]+$/g, '').trim();
  const hasBangla = /[\u0980-\u09ff]/.test(text);
  const script = hasBangla ? 'Bengali' : (/^[a-zA-Z0-9\s.,!?]+$/.test(t) && !/\b(tumi|ami|kemon|valo|bhalo|dhonnobad|shuvo|korte|koro)\b/.test(t) ? 'English' : 'Banglish');

  if (/^(tumi ke|who are you|tmr nam ki|tomar nam ki|apnar nam ki|naam ki|nam ki|tumi ki ai|apni ke|তুমি কে|তোমার নাম কি|তোমার নাম কী|আপনার নাম কী|আপনার নাম কি)\??$/i.test(t)) {
    return {
      kind: 'identity',
      reply: script === 'Bengali'
        ? 'আমি ZEVIAN, এই ফেসবুক পেজের স্মার্ট এআই পার্সোনাল অ্যাসিস্ট্যান্ট 🙂 বলো, কীভাবে সাহায্য করতে পারি?'
        : script === 'English'
        ? 'I am ZEVIAN, the smart AI personal assistant for this Page 🙂 How can I help you today?'
        : 'Ami ZEVIAN, ei Facebook Page-er smart AI personal assistant 🙂 Bolo, kivabe sahajjo korte pari?'
    };
  }

  if (/^(thanks|thank you|thx|thnk u|dhonnobad|onek dhonnobad|ধন্যবাদ|অনেক ধন্যবাদ|shukriya|shukran)$/i.test(t)) {
    return {
      kind: 'thanks',
      reply: script === 'Bengali'
        ? 'তোমাকেও অনেক ধন্যবাদ! কোনো প্রয়োজনে নির্দ্বিধায় জানিও 😊'
        : script === 'English'
        ? 'You are most welcome! Let me know if you need anything else 😊'
        : 'Tomakeo onek dhonnobad! Kono proyojone nirdidhay janio 😊'
    };
  }

  if (/^(good morning|shuvo shokal|suprovat|শুভ সকাল|সুপ্রভাত)$/i.test(t)) {
    return {
      kind: 'morning',
      reply: script === 'Bengali'
        ? 'শুভ সকাল! তোমার আজকের দিনটি অনেক সুন্দর কাটুক ☀️'
        : script === 'English'
        ? 'Good morning! Wishing you a wonderful and productive day ahead ☀️'
        : 'Shuvo shokal! Tomar ajker din-ti onek shundor katuk ☀️'
    };
  }

  if (/^(good night|shuvo ratri|shuvo rat|শুভ রাত্রি|শুভ রাত|gn)$/i.test(t)) {
    return {
      kind: 'night',
      reply: script === 'Bengali'
        ? 'শুভ রাত্রি! ভালো থেকো এবং সুন্দর ও আরামদায়ক ঘুম হোক 🌙'
        : script === 'English'
        ? 'Good night! Have a peaceful and restful sleep 🌙'
        : 'Shuvo ratri! Valo theko ebong shundor ghum hok 🌙'
    };
  }

  if (/^(bye|goodbye|tata|ta ta|see you|tc|take care|বিদায়|বিদায়)$/i.test(t)) {
    return {
      kind: 'bye',
      reply: script === 'Bengali'
        ? 'বিদায়! ভালো থেকো এবং নিজের যত্ন নিও 🙂'
        : script === 'English'
        ? 'Goodbye! Take good care of yourself and talk soon 🙂'
        : 'Biday! Valo theko ar nijer jotno nio 🙂'
    };
  }

  return null;
}

function buildAssistantActivityReply(script, message = '') {
  const text = String(message || '');
  const t = text.toLowerCase();
  const asksLocation = /\b(koi|kothay|where are you)\b/i.test(t) || /(কোথায় আছ|কোথায় আছ|কই আছ)/u.test(text);
  const asksWellbeing = /\b(kemon|how are you|obostha|khobor)\b/i.test(t) || /(কেমন আছ|কেমন আছো|কেমন আছেন|ভালো আছ|ভালো আছো)/u.test(text);

  if (script === 'Banglish') {
    if (asksLocation) return 'Ei to, ekhanei achi 🙂';
    if (asksWellbeing) return 'Ei to bhalo achi, tumi kemon acho? 🙂';
    return 'Ei to, tomar sathe kotha bolchi 🙂';
  }
  if (script === 'Bengali') {
    if (asksLocation) return 'এইতো, এখানেই আছি 🙂';
    if (asksWellbeing) return 'ভালো আছি, তুমি কেমন আছো? 🙂';
    return 'এইতো, তোমার সঙ্গে কথা বলছি 🙂';
  }
  if (asksLocation) return 'I’m right here 🙂';
  if (asksWellbeing) return 'I’m doing well, how about you? 🙂';
  return 'I’m here chatting with you 🙂';
}

function toLatinDigits(value) { return String(value || '').replace(/[০-৯]/g, digit => String('০১২৩৪৫৬৭৮৯'.indexOf(digit))); }
function dhakaDateParts(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(timestamp));
  const result = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { year: Number(result.year), month: Number(result.month), day: Number(result.day) };
}
function shiftDate({ year, month, day }, days) { const d = new Date(Date.UTC(year, month - 1, day + days)); return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }; }
function dateString(date) { return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`; }
function parseDueDate(text, now) {
  const t = toLatinDigits(text).toLowerCase(), base = dhakaDateParts(now);
  if (/(পরশু|day after tomorrow|porshu)/i.test(t)) return shiftDate(base, 2);
  if (/(আগামীকাল|কালকে|কাল|tomorrow|kalke|kal\b)/i.test(t)) return shiftDate(base, 1);
  if (/(আজকে|আজ|today|ajke|aj\b)/i.test(t)) return base;
  return null;
}
function parseClockTime(text) {
  const t = toLatinDigits(text).toLowerCase();
  const match = t.match(/(?:(সকাল|দুপুর|বিকেল|সন্ধ্যা|রাত|shokal|sokal|dupur|bikel|shondha|rat|raat|am|pm)\s*)?(\d{1,2})(?::(\d{2}))?\s*(টা|টায়|টার|ta|tay|am|pm)?\b/i);
  if (!match) return null;
  let hour = Number(match[2]); const minute = Number(match[3] || 0), marker = `${match[1] || ''} ${match[4] || ''}`.trim();
  if (minute > 59 || hour > 23 || hour < 0) return null;
  const afternoon = /(দুপুর|বিকেল|সন্ধ্যা|রাত|dupur|bikel|shondha|rat|raat|pm)/i.test(marker), morning = /(সকাল|shokal|sokal|am)/i.test(marker);
  if (afternoon && hour < 12) hour += 12; if (morning && hour === 12) hour = 0;
  return hour > 23 ? null : { hour, minute };
}
function localDhakaToUtc(date, hour, minute) { return Date.UTC(date.year, date.month - 1, date.day, hour, minute) - DHAKA_OFFSET_MINUTES * 60000; }
function classifyRelayIntent(message, now = Date.now()) {
  const original = String(message || '').trim(), t = toLatinDigits(original).toLowerCase();
  const relay = /(বলে\s*দিও|বলে\s*দিবি|জানিয়ে\s*দিও|জানিয়ে\s*দিও|মনে\s*করিয়ে\s*দিও|মনে\s*করিয়ে\s*দিও|সাফি\s*কে\s*বল|সাফিকে\s*বল|বলবে\s*সাফিকে|tell\s+safi|tell\s+him|call\s+me|আমাকে\s*ফোন|আমায়\s*ফোন|আমায়\s*ফোন|let\s+safi\s+know|remind\s+safi|safi\s+ke\s+bolo|safi\s+ke\s+bole\s+dio|safire\s+bole\s+dibi|safike\s+bol|safire\s+bol|bole\s+dibi|bol\s+dibi|janai\s+dio|mone\s+koriye\s+dio)/i.test(t);
  const contextualRelay = /(সাফি|safi).{0,45}(স্যার|sir|কলেজ|college|ফোন|call|যেতে|jaite|jabe|jabi)/i.test(t) && /(বলে|বল|জান|tell|bole|bol|jan|dibi|dio)/i.test(t);
  const isRelay = relay || contextualRelay;
  if (!isRelay) return { isRelay: false, title: '', dueDate: null, dueAt: null, timeSpecified: false, dueTimeSource: null, priority: 'NORMAL' };
  const due = parseDueDate(t, now), clock = parseClockTime(t), dueAt = due ? localDhakaToUtc(due, clock ? clock.hour : DEFAULT_REMINDER_HOUR, clock ? clock.minute : 0) : null;
  const urgent = /(জরুরি|জরুরী|urgent|asap|এখনই|এক্ষুনি|emergency)/i.test(t), important = /(স্যার|sir|কলেজ|college|ফোন|call|মনে কর|remind)/i.test(t);
  return { isRelay: true, title: original.slice(0, 180), dueDate: due ? dateString(due) : null, dueAt, timeSpecified: Boolean(clock), dueTimeSource: clock ? 'user' : (due ? 'default' : null), priority: urgent ? 'URGENT' : (important ? 'HIGH' : 'NORMAL') };
}
function buildRelayAcknowledgement(script, task) {
  if (script === 'English') return task?.dueDate ? `Got it — I'll let Safi know and save this as a reminder for ${task.dueDate}${task.timeSpecified ? '' : ' at 9:00 AM Dhaka time'} 🙂` : `Got it — I'll let Safi know and keep this as a reminder for him 🙂`;
  if (script === 'Bengali Script') return task?.dueDate ? `আচ্ছা, সাফিকে জানিয়ে রাখছি। ${task.timeSpecified ? 'সময়টাও' : 'সময় উল্লেখ না থাকায় সকাল ৯টায়'} রিমাইন্ডার সেট করে রাখলাম 🙂` : `আচ্ছা, সাফিকে জানিয়ে রাখছি। কথাটা রিমাইন্ডার হিসেবেও রেখে দিলাম 🙂`;
  return task?.dueDate ? `Accha, Safi-ke janacchi. ${task.timeSpecified ? 'Time-shoho' : 'Shokal 9tay default'} reminder set kore rakhlam 🙂` : `Accha, Safi-ke janacchi. Kothata reminder hisebe note kore rakhlam 🙂`;
}
function canSendWifeProactive(profile, conversation, now = Date.now()) {
  if (!profile || profile.relationship !== 'wife' || profile.affectionate !== true) return false;
  const lastUserAt = Number(conversation && conversation.lastUserAt || 0);
  if (!lastUserAt || now < lastUserAt || now - lastUserAt >= DAY_MS) return false;
  const lastProactiveAt = Number(profile.lastProactiveAt || 0);
  return !lastProactiveAt || now - lastProactiveAt >= WIFE_PROACTIVE_COOLDOWN_MS;
}
function makeProactiveSchedule(profile, conversation, message, now = Date.now()) {
  if (!canSendWifeProactive(profile, conversation, now)) return null;
  const clean = String(message || '').trim().slice(0, 400); if (!clean) return null;
  return { message: clean, inboundAt: Number(conversation.lastUserAt), scheduledAt: now + PROACTIVE_DELAY_MS, expiresAt: Number(conversation.lastUserAt) + DAY_MS, status: 'PENDING' };
}
function isTaskReminderDue(task, now = Date.now()) {
  if (!task || task.status !== 'OPEN' || !task.dueAt || !task.reminderDelivery) return false;
  const delivery = task.reminderDelivery;
  if (delivery.status === 'SENT') return false;
  if (Number(task.snoozedUntil || 0) > now) return false;
  if (delivery.status === 'SENDING' && now - Number(delivery.attemptAt || 0) < 5 * 60 * 1000) return false;
  return Number(delivery.nextAttemptAt || task.dueAt) <= now;
}

function isProactiveScheduleValid(schedule, conversation, profile, now = Date.now()) {
  if (!schedule || schedule.status !== 'PENDING') return false;
  if (!canSendWifeProactive(profile, { lastUserAt: schedule.inboundAt }, now)) return false;
  if (Number(conversation && conversation.lastUserAt || 0) !== Number(schedule.inboundAt)) return false;
  return now >= Number(schedule.scheduledAt) && now < Number(schedule.expiresAt);
}
module.exports = {
  classifyGreeting,
  buildGreetingReply,
  isEmojiOnly,
  buildEmojiReply,
  classifyChitChat,
  classifyActivityQuestion,
  buildAssistantActivityReply,
  classifyRelayIntent,
  buildRelayAcknowledgement,
  canSendWifeProactive,
  makeProactiveSchedule,
  isProactiveScheduleValid,
  isTaskReminderDue,
  __test: { parseDueDate, parseClockTime, localDhakaToUtc }
};
