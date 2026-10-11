JLPT Study App
==============

Open index.html (double-click it). No install or internet needed.

What's inside
- Kana: hiragana and katakana charts with audio, flashcards and quizzes.
- Vocabulary, Kanji, Grammar for N5 through N1. Pick the level at the top right.
  Vocabulary and kanji come from the Anki decks in your JLPT N5-N1 folders
  (about 8,100 words and 2,200 kanji). Kanji readings and stroke counts come from
  the open kanji-data set (github.com/davidluzgouveia/kanji-data).
  Grammar patterns follow the tanos.co.uk lists in your folders, with a meaning
  and example sentence for each.
- Review: spaced-repetition flashcards. Space flips, 1-4 rates (Again/Hard/Good/Easy).
- Quiz: multiple choice (and typed romaji for kana). Missed items can be sent to Review.
- Listening: hear words and sentences in Japanese and pick the meaning or the written
  form, or type kana you hear. Press R to replay, or use Slow.
- Mock exam: a timed N5-N1 practice test (vocabulary, grammar, listening), scored out
  of 180 with the official pass marks. Missed questions can be sent to Review.
- Audio: uses your browser's built-in Japanese voice (Chrome and Edge have one).
  Pick the voice and speed, and turn flashcard auto-play on or off, on the Progress page.
- Progress: stats, a study calendar, daily new-card limit, and backup export/import.

Your progress is saved in the browser you use. Use Progress > Export now and then
to keep a backup file, and Import to move to another browser or computer.

Adding content
- data/n5.js ... data/n1.js: add words as {"w":"word","r":"reading","m":"meaning"}
  and kanji as {"k":"字","m":"meaning","on":["ジ"],"kun":["あざ"],"s":6}.
- data/grammar.js: add [pattern, meaning, Japanese example, English example].
