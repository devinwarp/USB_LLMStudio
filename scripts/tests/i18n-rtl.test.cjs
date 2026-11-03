const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..", "..");
const loadStrings = () => import(pathToFileURL(path.join(root, "app/frontend/src/i18n/strings.js")).href);

test("every locale has a direction and only uses keys that English defines", async () => {
  const { LOCALES, STRINGS, DEFAULT_LOCALE, DIRECTION } = await loadStrings();
  const englishKeys = new Set(Object.keys(STRINGS[DEFAULT_LOCALE]));
  for (const [locale, info] of Object.entries(LOCALES)) {
    assert.ok(Object.values(DIRECTION).includes(info.dir), `${locale} has no valid dir`);
    assert.ok(info.label, `${locale} has no label`);
    for (const key of Object.keys(STRINGS[locale] || {})) {
      assert.ok(englishKeys.has(key), `${locale} defines unknown key ${key}`);
    }
  }
});

test("Arabic is right-to-left, has no offline TTS voice yet, and is fully translated", async () => {
  const { LOCALE, LOCALES, STRINGS, DEFAULT_LOCALE, DIRECTION, localeDirection } = await loadStrings();
  assert.equal(localeDirection(LOCALE.AR), DIRECTION.RTL);
  assert.equal(localeDirection(LOCALE.EN), DIRECTION.LTR);
  assert.equal(LOCALES[LOCALE.AR].ttsVoiceLanguage, null);
  assert.deepEqual(Object.keys(STRINGS[LOCALE.AR]).sort(), Object.keys(STRINGS[DEFAULT_LOCALE]).sort());
  for (const text of Object.values(STRINGS[LOCALE.AR])) {
    assert.match(text, /[؀-ۿ]/, `not Arabic: ${text}`);
  }
});

test("translate falls back to English, then to the key; unknown locales use the default", async () => {
  const { LOCALE, STRINGS, translate, normalizeLocale, DEFAULT_LOCALE } = await loadStrings();
  assert.equal(translate(LOCALE.AR, "nav.models"), STRINGS[LOCALE.AR]["nav.models"]);
  assert.equal(translate("xx", "nav.models"), STRINGS[DEFAULT_LOCALE]["nav.models"]);
  assert.equal(translate(LOCALE.AR, "missing.key"), "missing.key");
  assert.equal(normalizeLocale(null), DEFAULT_LOCALE);
  assert.equal(normalizeLocale("__proto__"), DEFAULT_LOCALE);
});

test("applyLocaleToDocument sets lang and dir on the root element", async () => {
  const { LOCALE, DIRECTION, DEFAULT_LOCALE, applyLocaleToDocument } = await loadStrings();
  const attributes = {};
  const rootElement = { setAttribute: (name, value) => { attributes[name] = value; } };
  applyLocaleToDocument(LOCALE.AR, rootElement);
  assert.deepEqual(attributes, { lang: LOCALE.AR, dir: DIRECTION.RTL });
  applyLocaleToDocument("bogus", rootElement);
  assert.deepEqual(attributes, { lang: DEFAULT_LOCALE, dir: DIRECTION.LTR });
  assert.doesNotThrow(() => applyLocaleToDocument(LOCALE.AR, null));
});

test("Whisper can be pinned to Arabic from Settings", () => {
  const settings = fs.readFileSync(path.join(root, "app/frontend/src/components/Settings.jsx"), "utf8");
  assert.match(settings, /\{ value: "ar", label: "Arabic" \}/);
});
