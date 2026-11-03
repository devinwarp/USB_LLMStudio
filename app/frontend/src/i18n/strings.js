// UI language scaffold. Add a locale to LOCALES and a matching table to STRINGS;
// keys missing from a table fall back to English, so screens can be translated gradually.

export const LOCALE = Object.freeze({
  EN: "en",
  AR: "ar",
});

export const DIRECTION = Object.freeze({
  LTR: "ltr",
  RTL: "rtl",
});

export const DEFAULT_LOCALE = LOCALE.EN;
export const LOCALE_STORAGE_KEY = "uiLocale";

// ttsVoiceLanguage: Kokoro voice language to prefer for this locale. Kokoro ships no
// Arabic voice, so Arabic keeps the existing voices (null). Set it here once an offline
// Arabic voice is bundled. Whisper already transcribes Arabic: pick it under
// Settings > Speech, or leave Auto detect on.
export const LOCALES = Object.freeze({
  [LOCALE.EN]: { label: "English", dir: DIRECTION.LTR },
  [LOCALE.AR]: { label: "العربية", dir: DIRECTION.RTL, ttsVoiceLanguage: null },
});

export const STRINGS = Object.freeze({
  [LOCALE.EN]: {
    "nav.newChat": "New chat",
    "nav.images": "Images",
    "nav.transcribe": "Transcribe",
    "nav.voice": "Voice",
    "nav.models": "Models",
    "recents.chats": "Chats",
    "recents.transcriptions": "Transcriptions",
    "chat.placeholder": "Ask anything",
    "chat.placeholderNoModel": "Select a model to start chatting",
    "chat.send": "Send message",
    "settings.language": "Language",
    "settings.languageDescription": "Language and text direction of the app",
    "nav.settings": "Settings",
    "recents.empty": "Your chats and recordings will show up here.",
    "recents.noMatches": "No matches.",
    "chat.homeTitle": "What should we make today?",
    "chat.suggestImage": "Create an image",
    "chat.suggestTranscribe": "Transcribe a recording",
    "chat.suggestSpeech": "Turn text into speech",
    "chat.web": "Web",
  },
  [LOCALE.AR]: {
    "nav.newChat": "محادثة جديدة",
    "nav.images": "الصور",
    "nav.transcribe": "تفريغ الصوت",
    "nav.voice": "الصوت",
    "nav.models": "النماذج",
    "recents.chats": "المحادثات",
    "recents.transcriptions": "التفريغات",
    "chat.placeholder": "اسأل أي شيء",
    "chat.placeholderNoModel": "اختر نموذجًا لبدء المحادثة",
    "chat.send": "إرسال الرسالة",
    "settings.language": "اللغة",
    "settings.languageDescription": "لغة التطبيق واتجاه النص",
    "nav.settings": "الإعدادات",
    "recents.empty": "ستظهر محادثاتك وتسجيلاتك هنا.",
    "recents.noMatches": "لا توجد نتائج.",
    "chat.homeTitle": "ماذا نصنع اليوم؟",
    "chat.suggestImage": "أنشئ صورة",
    "chat.suggestTranscribe": "فرّغ تسجيلًا صوتيًا",
    "chat.suggestSpeech": "حوّل النص إلى كلام",
    "chat.web": "الويب",
  },
});

export function normalizeLocale(value) {
  return Object.hasOwn(LOCALES, value) ? value : DEFAULT_LOCALE;
}

export function translate(locale, key) {
  return STRINGS[normalizeLocale(locale)]?.[key] ?? STRINGS[DEFAULT_LOCALE][key] ?? key;
}

export function localeDirection(locale) {
  return LOCALES[normalizeLocale(locale)].dir;
}

// Sets lang and dir on <html>, which flips flex layouts and text alignment for RTL.
export function applyLocaleToDocument(locale, root = globalThis.document?.documentElement) {
  if (!root) return;
  const safe = normalizeLocale(locale);
  root.setAttribute("lang", safe);
  root.setAttribute("dir", localeDirection(safe));
}
