// Translation layer.
//
// PHASE 1 (now): free Google Translate via google-translate-api-x. No API key.
// PHASE 3 (later): swap `translateText` for an LLM call that is given the
//   Brethren-assembly register + glossary.te.json AND the `context` sentences,
//   so assembly terms, Scripture and pronouns come out right. The rest of the
//   app (sentence buffer, rooms, pages) does not change when you swap this one function.

import translate from 'google-translate-api-x';

/**
 * Translate one sentence of English into the target language.
 * @param {string}   text        the English sentence (or the growing draft of it)
 * @param {string}   targetLang  Google Translate language code, e.g. "te"
 * @param {string[]} context     the few sentences spoken just before this one.
 *                               Google's free API cannot use background context,
 *                               so it is ignored here; the AI translator will use it.
 * @returns {Promise<string>}    the translated text
 */
export async function translateText(text, targetLang, context = []) {
  const result = await translate(text, { from: 'en', to: targetLang });
  return result.text;
}
