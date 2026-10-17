import { rankedEnglishWords } from "./learning-frequency-data.js";

export const FREQUENCY_LEVELS = Object.freeze({
  beginner: 1000,
  intermediate: 3000,
  advanced: 7000
});

const ranks = new Map(
  rankedEnglishWords.map((word, index) => [word, index + 1])
);

export function frequencyRank(word) {
  return ranks.get(word) || rankedEnglishWords.length + 1;
}

export function shouldHighlightEnglishWord(
  word,
  level,
  savedUnknown = new Set(),
  known = new Set(),
  englishPage = true
) {
  if (!/^[a-z]+(?:['’-][a-z]+)*$/i.test(word)) return false;
  const lower = word.toLowerCase();
  if (known.has(lower)) return false;
  if (savedUnknown.has(lower)) return true;
  if (!englishPage || !Object.hasOwn(FREQUENCY_LEVELS, level)) return false;
  // Automatic matching avoids names, initials and unranked contractions.
  if (!/^[a-z]{3,24}$/.test(word)) return false;
  return frequencyRank(word) > FREQUENCY_LEVELS[level];
}
