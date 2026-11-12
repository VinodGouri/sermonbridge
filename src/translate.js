// Translation layer.
//
// PHASE 1 (now): free Google Translate via google-translate-api-x. No API key.
// PHASE 3 (later): swap `translateText` for an LLM call that is given the
//   Brethren-assembly register + glossary.te.json, so assembly terms and
//   Scripture come out in the wording your congregation knows. The rest of the
//   app (fan-out, rooms, pages) does not change when you swap this one function.

import translate from 'google-translate-api-x';

/**
 * Translate a single line of English into the target language.
 * @param {string} text        the English transcript line
 * @param {string} targetLang  Google Translate language code, e.g. "te"
 * @returns {Promise<string>}  the translated text
 */
export async function translateText(text, targetLang) {
  const result = await translate(text, { from: 'en', to: targetLang });
  return result.text;
}
