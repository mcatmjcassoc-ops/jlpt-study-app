/* JLPT Study — a self-contained study app. Everything is saved in this browser (localStorage). */
(function () {
  "use strict";

  const LEVELS = ["N5", "N4", "N3", "N2", "N1"];
  const STORE_KEY = "jlpt-study-v1";
  const DAY = 86400000;
  const $view = document.getElementById("view");

  // ---------- Storage ----------
  const defaultState = () => ({
    level: "N5",
    newPerDay: 15,
    cards: {},          // id -> { due, ivl, ease, reps, lapses, last }
    log: {},            // "YYYY-MM-DD" -> { reviews, correct, newCards }
    newToday: {},       // "YYYY-MM-DD|deckKey" -> count
    quizzes: [],        // { date, deck, level, mode, score, total }
    exams: [],          // { date, level, size, total, parts: [vocab, grammar, listening], pass }
    audio: { rate: 0.9, autoplay: true, voice: "" }
  });
  let state = load();
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) { const d = defaultState(), s = Object.assign(d, JSON.parse(raw)); s.audio = Object.assign(defaultState().audio, s.audio); return s; }
    } catch (e) { /* storage unavailable or corrupt */ }
    return defaultState();
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { toast("Couldn't save progress in this browser. Use Progress → Export to keep a backup."); }
  }

  // ---------- Helpers ----------
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const dayKey = (t = Date.now()) => { const d = new Date(t); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  const startOfDay = (t = Date.now()) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const sample = (a, n) => shuffle(a).slice(0, n);
  function toast(msg) {
    const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
  }
  let jaVoice = null;
  const jaVoices = () => ("speechSynthesis" in window ? speechSynthesis.getVoices().filter(v => /^ja/i.test(v.lang)) : []);
  function pickVoice() {
    if (!("speechSynthesis" in window)) return;
    const vs = jaVoices();
    jaVoice = vs.find(v => v.name === state.audio.voice) || vs.find(v => /natural|online|google/i.test(v.name)) || vs[0] || null;
  }
  if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
  function speak(text, rate) {
    if (!("speechSynthesis" in window)) return toast("Speech isn't available in this browser.");
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text); u.lang = "ja-JP"; u.rate = rate || state.audio.rate;
    if (jaVoice) u.voice = jaVoice;
    speechSynthesis.speak(u);
  }
  const speakBtn = text => `<button class="btn icon small" data-speak="${esc(text)}" title="Listen">🔊</button>`;

  // ---------- Content ----------
  const DECKS = {
    hiragana: { name: "Hiragana", leveled: false },
    katakana: { name: "Katakana", leveled: false },
    vocab: { name: "Vocabulary", leveled: true },
    kanji: { name: "Kanji", leveled: true },
    grammar: { name: "Grammar", leveled: true }
  };
  const deckKey = (deck, level) => DECKS[deck].leveled ? deck + ":" + level : deck;
  const cache = {};
  function items(deck, level) {
    const key = deckKey(deck, level);
    if (cache[key]) return cache[key];
    let out = [];
    if (deck === "hiragana" || deck === "katakana") {
      const kata = deck === "katakana";
      for (const group of ["basic", "dakuten", "combo"]) {
        for (const cell of JLPT.kana.rows[group]) {
          if (!cell) continue;
          const ch = kata ? JLPT.kana.toKata(cell[0]) : cell[0];
          out.push({ id: "kana:" + ch, deck, ch, romaji: cell[1], group });
        }
      }
    } else if (deck === "vocab") {
      out = (JLPT.levels[level] ? JLPT.levels[level].vocab : []).map(v => ({ id: "v:" + level + ":" + v.w, deck, level, w: v.w, r: v.r, m: v.m }));
    } else if (deck === "kanji") {
      out = (JLPT.levels[level] ? JLPT.levels[level].kanji : []).map(k => ({ id: "k:" + level + ":" + k.k, deck, level, k: k.k, m: k.m, on: k.on || [], kun: k.kun || [], s: k.s }));
    } else if (deck === "grammar") {
      out = (JLPT.grammar[level] || []).map(g => ({ id: "g:" + level + ":" + g[0], deck, level, p: g[0], m: g[1], ex: g[2], en: g[3] }));
    }
    return (cache[key] = out);
  }
  const allVocab = () => LEVELS.flatMap(l => items("vocab", l));

  // ---------- Spaced repetition (SM-2 style) ----------
  function cardStatus(id) {
    const c = state.cards[id];
    if (!c) return "new";
    if (c.due <= Date.now()) return "due";
    if (c.ivl >= 21) return "mature";
    return "learning";
  }
  const isLearned = id => { const c = state.cards[id]; return !!c && c.ivl >= 1; };
  function nextIntervals(c) {
    // Returns the interval (days) each grade would give, for button labels.
    return [1, 2, 3, 4].map(q => schedule(Object.assign({}, c || { ivl: 0, ease: 2.5, reps: 0, lapses: 0 }), q).ivl);
  }
  function schedule(c, q) {
    if (q === 1) {
      c.lapses = (c.lapses || 0) + (c.reps ? 1 : 0);
      c.reps = 0; c.ivl = 0; c.ease = Math.max(1.3, c.ease - 0.2);
      c.due = Date.now() + 60 * 1000;
      return c;
    }
    if (c.reps === 0) c.ivl = q === 2 ? 1 : q === 3 ? 1 : 4;
    else if (c.reps === 1) c.ivl = q === 2 ? 2 : q === 3 ? 3 : 6;
    else c.ivl = Math.max(c.ivl + 1, Math.round(c.ivl * (q === 2 ? 1.2 : q === 3 ? c.ease : c.ease * 1.3)));
    if (q === 2) c.ease = Math.max(1.3, c.ease - 0.15);
    if (q === 4) c.ease = c.ease + 0.15;
    c.reps++;
    c.due = startOfDay() + c.ivl * DAY;
    return c;
  }
  function grade(id, q) {
    const isNew = !state.cards[id];
    const c = state.cards[id] || { ivl: 0, ease: 2.5, reps: 0, lapses: 0 };
    schedule(c, q); c.last = Date.now();
    state.cards[id] = c;
    const d = dayKey();
    const lg = state.log[d] || (state.log[d] = { reviews: 0, correct: 0, newCards: 0 });
    lg.reviews++; if (q > 1) lg.correct++; if (isNew) lg.newCards++;
    save();
  }
  function newLeft(key) { return Math.max(0, state.newPerDay - (state.newToday[dayKey() + "|" + key] || 0)); }
  function useNew(key) { const k = dayKey() + "|" + key; state.newToday[k] = (state.newToday[k] || 0) + 1; }
  function deckCounts(deck, level) {
    const list = items(deck, level);
    let due = 0, learned = 0, seen = 0;
    const now = Date.now();
    for (const it of list) {
      const c = state.cards[it.id];
      if (!c) continue;
      seen++;
      if (c.due <= now) due++;
      if (c.ivl >= 1) learned++;
    }
    const key = deckKey(deck, level);
    return { total: list.length, due, learned, seen, newAvail: Math.min(newLeft(key), list.length - seen) };
  }
  function buildQueue(deck, level) {
    const list = items(deck, level), now = Date.now();
    const due = list.filter(it => state.cards[it.id] && state.cards[it.id].due <= now).sort((a, b) => state.cards[a.id].due - state.cards[b.id].due);
    const fresh = list.filter(it => !state.cards[it.id]).slice(0, newLeft(deckKey(deck, level)));
    return shuffle(due).concat(fresh.map(it => Object.assign({ isNew: true }, it)));
  }

  // ---------- Level picker & routing ----------
  function renderLevelPicker() {
    const el = document.getElementById("levelPicker");
    el.innerHTML = LEVELS.map(l => `<button data-level="${l}" class="${l === state.level ? "active" : ""}">${l}</button>`).join("");
  }
  document.getElementById("levelPicker").addEventListener("click", e => {
    const b = e.target.closest("button[data-level]"); if (!b) return;
    state.level = b.dataset.level; save(); renderLevelPicker(); route();
  });
  document.addEventListener("click", e => {
    const s = e.target.closest("[data-speak]");
    if (s) { e.stopPropagation(); speak(s.dataset.speak); }
  }, true);

  const routes = { home: viewHome, review: viewReview, kana: viewKana, vocab: viewVocab, kanji: viewKanji, grammar: viewGrammar, quiz: viewQuiz, listening: viewListening, exam: viewExam, progress: viewProgress };
  let cleanup = null;
  function route() {
    if (cleanup) { cleanup(); cleanup = null; }
    document.querySelectorAll(".modal-back").forEach(m => m.remove());
    const [path, qs] = (location.hash.replace(/^#\/?/, "") || "home").split("?");
    const params = new URLSearchParams(qs || "");
    const name = routes[path] ? path : "home";
    document.querySelectorAll("#nav a").forEach(a => a.classList.toggle("active", a.dataset.route === name));
    $view.innerHTML = "";
    window.scrollTo(0, 0);
    routes[name](params);
  }
  window.addEventListener("hashchange", route);
  // Clicking the link for the page you're already on starts it fresh (e.g. a new exam).
  document.getElementById("nav").addEventListener("click", e => {
    const a = e.target.closest("a"); if (a && a.getAttribute("href") === location.hash) route();
  });

  // ---------- Home ----------
  function streak() {
    let n = 0, t = Date.now();
    if (!state.log[dayKey(t)]) t -= DAY; // today not studied yet doesn't break the streak
    while (state.log[dayKey(t)] && state.log[dayKey(t)].reviews > 0) { n++; t -= DAY; }
    return n;
  }
  function deckCardHtml(deck, level) {
    const c = deckCounts(deck, level);
    const pct = c.total ? Math.round(100 * c.learned / c.total) : 0;
    const name = DECKS[deck].name + (DECKS[deck].leveled ? " " + level : "");
    const ready = c.due + c.newAvail;
    return `<div class="panel deck-card">
      <div class="row"><h3>${name}</h3><span class="spacer"></span>${c.due ? `<span class="pill due">${c.due} due</span>` : ""}</div>
      <div class="meta">${c.learned} of ${c.total} learned · ${c.newAvail} new available today</div>
      <div class="bar"><span style="width:${pct}%"></span></div>
      <div class="row" style="margin-top:6px">
        <a class="btn ${ready ? "primary" : ""} small" href="#/review?deck=${deck}">${ready ? "Study " + ready : "All caught up"}</a>
        <a class="btn small" href="#/quiz?deck=${deck}">Quiz</a>
      </div></div>`;
  }
  function viewHome() {
    const lv = state.level;
    const today = state.log[dayKey()] || { reviews: 0, correct: 0, newCards: 0 };
    const totalDue = ["hiragana", "katakana", "vocab", "kanji", "grammar"].reduce((s, d) => s + deckCounts(d, lv).due, 0);
    const kanaDone = ["hiragana", "katakana"].every(d => { const c = deckCounts(d, lv); return c.learned >= c.total * 0.8; });
    $view.innerHTML = `
      <h1>おかえり! Welcome back</h1>
      <p class="sub">Studying for <strong>JLPT ${lv}</strong>. Switch level at the top right.</p>
      <div class="grid cols-4">
        <div class="panel stat"><div class="num">${totalDue}</div><div class="lbl">cards due now</div></div>
        <div class="panel stat"><div class="num">${today.reviews}</div><div class="lbl">reviews today${today.reviews ? " · " + Math.round(100 * today.correct / today.reviews) + "% correct" : ""}</div></div>
        <div class="panel stat"><div class="num">${streak()}🔥</div><div class="lbl">day streak</div></div>
        <div class="panel stat"><div class="num">${Object.values(state.cards).filter(c => c.ivl >= 1).length}</div><div class="lbl">items learned (all levels)</div></div>
      </div>
      <h2>${lv} decks</h2>
      <div class="grid cols-3">${["vocab", "kanji", "grammar"].map(d => deckCardHtml(d, lv)).join("")}</div>
      <h2>Kana ${kanaDone ? "" : "<span class='pill due'>start here if you're new</span>"}</h2>
      <div class="grid cols-3">${["hiragana", "katakana"].map(d => deckCardHtml(d, lv)).join("")}</div>
      <h2>Practice</h2>
      <div class="grid cols-3">
        <div class="panel deck-card"><h3>🎧 Listening</h3><div class="meta">Hear ${lv} words and sentences, pick what they mean.</div><div class="row" style="margin-top:6px"><a class="btn small primary" href="#/listening">Start listening</a></div></div>
        <div class="panel deck-card"><h3>📝 Mock exam</h3><div class="meta">${(() => { const e = (state.exams || []).filter(x => x.level === lv).slice(-1)[0]; return e ? "Last score " + e.total + "/180 · " + (e.pass ? "pass" : "not yet a pass") : "Timed " + lv + " practice test scored out of 180."; })()}</div><div class="row" style="margin-top:6px"><a class="btn small primary" href="#/exam">Take a mock exam</a></div></div>
      </div>
      <h2>How it works</h2>
      <div class="panel">
        <p style="margin-top:0">Each day, press <strong>Study</strong> on a deck. You'll see cards that are due plus up to <strong>${state.newPerDay}</strong> new ones per deck. Rate how well you knew each card and the app schedules the next review: hard cards come back soon, easy ones wait longer. Shortcuts: <kbd>Space</kbd> to flip, <kbd>1</kbd>–<kbd>4</kbd> to rate.</p>
        <p style="margin-bottom:0">Use <strong>Quiz</strong> to test yourself, and <strong>Progress</strong> to back up your progress to a file.</p>
      </div>`;
  }

  // ---------- Review (flashcards) ----------
  function cardFaces(it, reverse) {
    if (it.deck === "hiragana" || it.deck === "katakana") {
      return { front: `<div class="big">${esc(it.ch)}</div><div class="hint">What is the reading?</div>`,
               back: `<div class="big">${esc(it.ch)}</div><hr><div class="meaning">${esc(it.romaji)}</div>`, say: it.ch };
    }
    if (it.deck === "vocab") {
      const word = `<div class="big ${it.w.length > 5 ? "long" : ""}">${esc(it.w)}</div>`;
      const reading = it.r ? `<div class="reading">${esc(it.r)}</div>` : "";
      if (reverse) return { front: `<div class="meaning">${esc(it.m)}</div><div class="hint">Say the Japanese word</div>`, back: `<div class="meaning">${esc(it.m)}</div><hr>${word}${reading}`, say: it.r || it.w };
      return { front: `${word}<div class="hint">Meaning and reading?</div>`, back: `${word}${reading}<hr><div class="meaning">${esc(it.m)}</div>`, say: it.r || it.w };
    }
    if (it.deck === "kanji") {
      const rd = `<div class="reading">${it.on.length ? "On: " + esc(it.on.join("、")) : ""}${it.on.length && it.kun.length ? "<br>" : ""}${it.kun.length ? "Kun: " + esc(it.kun.join("、")) : ""}</div>`;
      const ex = allVocab().filter(v => v.w.includes(it.k) && v.w.length > 1).slice(0, 3)
        .map(v => `${esc(v.w)}${v.r ? "（" + esc(v.r) + "）" : ""} ${esc(v.m.split(";")[0])}`).join("<br>");
      return { front: `<div class="big" style="font-family:var(--jp)">${esc(it.k)}</div><div class="hint">Meaning and readings?</div>`,
               back: `<div class="big" style="font-family:var(--jp)">${esc(it.k)}</div><div class="meaning">${esc(it.m)}</div>${rd}${ex ? `<hr><div class="hint" style="font-size:15px;color:var(--ink)">${ex}</div>` : ""}`,
               say: (it.kun[0] || it.on[0] || it.k).replace(/[.\-]/g, "") };
    }
    // grammar
    return { front: `<div class="big long">${esc(it.p)}</div><div class="hint">What does it mean?</div>`,
             back: `<div class="big long">${esc(it.p)}</div><hr><div class="meaning">${esc(it.m)}</div><div class="example">${esc(it.ex)}</div><div class="hint" style="font-size:15px">${esc(it.en)}</div>`, say: it.ex };
  }
  function fmtIvl(d) { return d === 0 ? "<1m" : d < 30 ? d + "d" : d < 365 ? Math.round(d / 30) + "mo" : (d / 365).toFixed(1) + "y"; }
  function viewReview(params) {
    const deck = DECKS[params.get("deck")] ? params.get("deck") : null;
    const lv = state.level;
    if (!deck) {
      $view.innerHTML = `<h1>Review</h1><p class="sub">Pick a deck to study. Due cards come first, then new ones.</p>
        <div class="grid cols-3">${["vocab", "kanji", "grammar", "hiragana", "katakana"].map(d => deckCardHtml(d, lv)).join("")}</div>`;
      return;
    }
    const key = deckKey(deck, lv);
    const queue = buildQueue(deck, lv);
    let reverse = false, flipped = false, done = 0, idx = 0, again = 0, spoken = false;
    const title = DECKS[deck].name + (DECKS[deck].leveled ? " " + lv : "");
    function render() {
      if (idx >= queue.length) {
        $view.innerHTML = `<div class="study-wrap"><div class="panel empty-state">
          <div style="font-size:48px">🎉</div><h2 style="margin-top:6px">${done ? "Session complete" : "Nothing due right now"}</h2>
          <p>${done ? `You reviewed ${done} card${done === 1 ? "" : "s"}.` : "Come back later, or raise the daily new-card limit in Progress."}</p>
          <div class="row" style="justify-content:center"><a class="btn primary" href="#/home">Home</a><a class="btn" href="#/quiz?deck=${deck}">Take a quiz</a></div>
        </div></div>`;
        return;
      }
      const it = queue[idx];
      const f = cardFaces(it, reverse && deck === "vocab");
      const ivls = nextIntervals(state.cards[it.id]);
      $view.innerHTML = `<div class="study-wrap">
        <div class="row"><h1 style="font-size:20px">${title}</h1><span class="spacer"></span>
          ${deck === "vocab" ? `<label class="row" style="gap:4px;font-size:13px;color:var(--muted)"><input type="checkbox" id="rev" ${reverse ? "checked" : ""}> English → Japanese</label>` : ""}
          <label class="row" style="gap:4px;font-size:13px;color:var(--muted)"><input type="checkbox" id="autoplay" ${state.audio.autoplay ? "checked" : ""}> 🔊 Auto-play</label>
          <a class="btn small" href="#/home">End</a></div>
        <div class="progress-line">${queue.length - idx} left · ${done} done ${it.isNew ? "· <span class='pill'>new</span>" : ""}</div>
        <div class="panel flash" id="flash">${flipped ? f.back : f.front}
          ${flipped ? `<div>${speakBtn(f.say)}</div>` : `<div class="hint" style="margin-top:14px">Click or press <kbd>Space</kbd> to show answer</div>`}</div>
        ${flipped ? `<div class="grade">
          <button class="again" data-q="1">Again<small>${fmtIvl(ivls[0])} · 1</small></button>
          <button data-q="2">Hard<small>${fmtIvl(ivls[1])} · 2</small></button>
          <button class="good" data-q="3">Good<small>${fmtIvl(ivls[2])} · 3</small></button>
          <button data-q="4">Easy<small>${fmtIvl(ivls[3])} · 4</small></button></div>` : ""}
      </div>`;
      if (flipped && state.audio.autoplay && !spoken) { spoken = true; speak(f.say); }
      document.getElementById("flash").onclick = () => { if (!flipped) { flipped = true; render(); } };
      const ap = document.getElementById("autoplay"); if (ap) ap.onchange = () => { state.audio.autoplay = ap.checked; save(); };
      const rv = document.getElementById("rev"); if (rv) rv.onchange = () => { reverse = rv.checked; flipped = false; render(); };
      $view.querySelectorAll(".grade button").forEach(b => b.onclick = () => rate(+b.dataset.q));
    }
    function rate(q) {
      const it = queue[idx];
      if (it.isNew) { useNew(key); it.isNew = false; }
      grade(it.id, q);
      if (q === 1 && again < 200) { again++; queue.splice(Math.min(queue.length, idx + 4), 0, Object.assign({}, it)); }
      done++; idx++; flipped = false; spoken = false; render();
    }
    function onKey(e) {
      if (e.target.tagName === "INPUT") return;
      if (e.code === "Space" || e.key === "Enter") { e.preventDefault(); if (!flipped && idx < queue.length) { flipped = true; render(); } }
      else if (flipped && /^[1-4]$/.test(e.key)) rate(+e.key);
    }
    document.addEventListener("keydown", onKey);
    cleanup = () => document.removeEventListener("keydown", onKey);
    render();
  }

  // ---------- Kana ----------
  function viewKana(params) {
    const script = params.get("s") === "katakana" ? "katakana" : "hiragana";
    const conv = ch => script === "katakana" ? JLPT.kana.toKata(ch) : ch;
    const grid = (group, cls) => `<div class="kana-grid ${cls || ""}">${JLPT.kana.rows[group].map(c => c
      ? `<div class="kana-cell ${isLearned("kana:" + conv(c[0])) ? "learned" : ""}" data-speak="${esc(conv(c[0]))}"><div class="k">${esc(conv(c[0]))}</div><div class="r">${c[1]}</div></div>`
      : `<div class="kana-cell empty"></div>`).join("")}</div>`;
    $view.innerHTML = `<div class="row"><h1>Kana</h1><span class="spacer"></span>
        <a class="btn ${script === "hiragana" ? "primary" : ""}" href="#/kana?s=hiragana">ひらがな Hiragana</a>
        <a class="btn ${script === "katakana" ? "primary" : ""}" href="#/kana?s=katakana">カタカナ Katakana</a></div>
      <p class="sub">Click any character to hear it. A green underline means you've learned it in Review.</p>
      <div class="row" style="margin-bottom:14px"><a class="btn primary" href="#/review?deck=${script}">Study ${script} flashcards</a><a class="btn" href="#/quiz?deck=${script}">Quiz ${script}</a></div>
      <div class="grid cols-3" style="align-items:start">
        <div><h2 style="margin-top:0">Basic</h2>${grid("basic")}</div>
        <div><h2 style="margin-top:0">Voiced (dakuten)</h2>${grid("dakuten")}</div>
        <div><h2 style="margin-top:0">Combinations</h2>${grid("combo", "combo")}</div>
      </div>`;
  }

  // ---------- Vocabulary ----------
  function statusPill(id) {
    const s = cardStatus(id);
    return s === "new" ? "" : s === "due" ? `<span class="pill due">due</span>` : `<span class="pill learned">${s === "mature" ? "mastered" : "learning"}</span>`;
  }
  function listPage(title, sub, deck, filterFn, renderList, perPage) {
    const lv = state.level;
    let q = "", page = 0, onlyFilter = "all";
    $view.innerHTML = `<div class="row"><h1>${title} ${lv}</h1><span class="spacer"></span>
        <a class="btn primary" href="#/review?deck=${deck}">Study</a><a class="btn" href="#/quiz?deck=${deck}">Quiz</a></div>
      <p class="sub">${sub}</p>
      <div class="row" style="margin-bottom:12px">
        <input type="search" id="q" placeholder="Search Japanese, reading or English…">
        <select id="only"><option value="all">All</option><option value="new">Not started</option><option value="learning">Learning / due</option><option value="mature">Mastered</option></select>
        <span class="spacer"></span><span id="count" class="sub" style="margin:0"></span></div>
      <div id="list"></div><div class="pager" id="pager"></div>`;
    const all = items(deck, lv);
    function draw() {
      const ql = q.toLowerCase();
      const filtered = all.filter(it => (!q || filterFn(it, ql)) && (onlyFilter === "all" ||
        (onlyFilter === "new" && cardStatus(it.id) === "new") ||
        (onlyFilter === "learning" && ["due", "learning"].includes(cardStatus(it.id))) ||
        (onlyFilter === "mature" && cardStatus(it.id) === "mature")));
      const pages = Math.max(1, Math.ceil(filtered.length / perPage));
      page = Math.min(page, pages - 1);
      document.getElementById("count").textContent = filtered.length + " of " + all.length;
      document.getElementById("list").innerHTML = filtered.length ? renderList(filtered.slice(page * perPage, (page + 1) * perPage)) : `<div class="panel empty-state">No matches.</div>`;
      document.getElementById("pager").innerHTML = pages > 1 ? `<button class="btn small" id="prev" ${page ? "" : "disabled"}>‹ Prev</button> Page ${page + 1} of ${pages} <button class="btn small" id="next" ${page < pages - 1 ? "" : "disabled"}>Next ›</button>` : "";
      const p = document.getElementById("prev"), n = document.getElementById("next");
      if (p) p.onclick = () => { page--; draw(); window.scrollTo(0, 0); };
      if (n) n.onclick = () => { page++; draw(); window.scrollTo(0, 0); };
    }
    document.getElementById("q").oninput = e => { q = e.target.value.trim(); page = 0; draw(); };
    document.getElementById("only").onchange = e => { onlyFilter = e.target.value; page = 0; draw(); };
    draw();
  }
  function viewVocab() {
    listPage("Vocabulary", "From the JLPT word lists in your study folder. Click 🔊 to hear a word.", "vocab",
      (it, q) => it.w.includes(q) || (it.r && it.r.includes(q)) || it.m.toLowerCase().includes(q),
      list => `<table class="list"><thead><tr><th>Word</th><th>Reading</th><th>Meaning</th><th></th></tr></thead><tbody>${list.map(it =>
        `<tr><td class="w">${esc(it.w)}</td><td class="r">${esc(it.r)}</td><td>${esc(it.m)}</td><td style="white-space:nowrap">${statusPill(it.id)} ${speakBtn(it.r || it.w)}</td></tr>`).join("")}</tbody></table>`, 50);
  }

  // ---------- Kanji ----------
  function showKanji(it) {
    const ex = allVocab().filter(v => v.w.includes(it.k)).slice(0, 12);
    const back = document.createElement("div"); back.className = "modal-back";
    back.innerHTML = `<div class="modal"><div class="row"><span class="pill">${it.level}</span>${statusPill(it.id)}<span class="spacer"></span><button class="btn small" id="x">Close</button></div>
      <div class="k">${esc(it.k)}</div>
      <dl class="kv"><dt>Meaning</dt><dd style="font-family:inherit">${esc(it.m)}</dd>
        <dt>On'yomi</dt><dd>${esc(it.on.join("、") || "—")}</dd><dt>Kun'yomi</dt><dd>${esc(it.kun.join("、") || "—")}</dd>
        ${it.s ? `<dt>Strokes</dt><dd>${it.s}</dd>` : ""}</dl>
      ${ex.length ? `<h2 style="font-size:16px">Words using ${esc(it.k)}</h2><table class="list">${ex.map(v => `<tr><td class="w" style="font-size:16px">${esc(v.w)}</td><td class="r">${esc(v.r)}</td><td>${esc(v.m.split(";").slice(0, 2).join(";"))}</td><td><span class="pill">${v.level}</span></td></tr>`).join("")}</table>` : ""}</div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.onclick = e => { if (e.target === back) close(); };
    back.querySelector("#x").onclick = close;
    const onEsc = e => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); } };
    document.addEventListener("keydown", onEsc);
  }
  function viewKanji() {
    listPage("Kanji", "Click a kanji for readings and example words. On'yomi in katakana, kun'yomi in hiragana.", "kanji",
      (it, q) => it.k === q || it.m.toLowerCase().includes(q) || it.on.some(r => r.includes(q)) || it.kun.some(r => r.includes(q)),
      list => `<div class="kanji-tiles">${list.map(it => `<div class="kanji-tile" data-k="${esc(it.id)}">
        <div class="row"><span class="k">${esc(it.k)}</span><span class="spacer"></span>${statusPill(it.id)}</div>
        <div class="m" title="${esc(it.m)}">${esc(it.m)}</div><div class="rd">${esc(it.on.slice(0, 2).join("・"))} ${esc(it.kun.slice(0, 2).join("・"))}</div></div>`).join("")}</div>`, 60);
    document.getElementById("list").addEventListener("click", e => {
      const t = e.target.closest(".kanji-tile"); if (!t) return;
      const it = items("kanji", state.level).find(x => x.id === t.dataset.k); if (it) showKanji(it);
    });
  }

  // ---------- Grammar ----------
  function viewGrammar() {
    listPage("Grammar", "Grammar points for this level with a meaning and example sentence.", "grammar",
      (it, q) => it.p.includes(q) || it.m.toLowerCase().includes(q) || it.ex.includes(q) || it.en.toLowerCase().includes(q),
      list => list.map(it => `<div class="grammar-item"><div class="row"><span class="p">${esc(it.p)}</span><span class="spacer"></span>${statusPill(it.id)}${speakBtn(it.ex)}</div>
        <div>${esc(it.m)}</div><div class="ex">${esc(it.ex)}</div><div class="en">${esc(it.en)}</div></div>`).join(""), 30);
  }

  // ---------- Quiz ----------
  const QUIZ_MODES = {
    hiragana: [["read", "Kana → romaji (choose)"], ["type", "Kana → romaji (type)"], ["reverse", "Romaji → kana"]],
    katakana: [["read", "Kana → romaji (choose)"], ["type", "Kana → romaji (type)"], ["reverse", "Romaji → kana"]],
    vocab: [["meaning", "Word → meaning"], ["word", "Meaning → word"], ["reading", "Word → reading"]],
    kanji: [["meaning", "Kanji → meaning"], ["kanji", "Meaning → kanji"], ["reading", "Kanji → reading"]],
    grammar: [["meaning", "Pattern → meaning"], ["pattern", "Sentence → pattern used"]]
  };
  function makeQuestion(deck, mode, it, pool) {
    const others = n => sample(pool.filter(x => x.id !== it.id), n * 3);
    const uniq = (correct, fn) => {
      const seen = new Set([correct]); const out = [];
      for (const o of others(4)) { const v = fn(o); if (v && !seen.has(v)) { seen.add(v); out.push(v); } if (out.length === 3) break; }
      return shuffle([correct].concat(out));
    };
    const short = m => m.split(/;\s*/).slice(0, 2).join("; ");
    if (deck === "hiragana" || deck === "katakana") {
      if (mode === "reverse") return { prompt: it.romaji, small: true, ask: "Which kana is this?", answer: it.ch, choices: uniq(it.ch, o => o.ch), jp: true };
      if (mode === "type") return { prompt: it.ch, ask: "Type the romaji", answer: it.romaji, typed: true, say: it.ch };
      return { prompt: it.ch, ask: "How is this read?", answer: it.romaji, choices: uniq(it.romaji, o => o.romaji), say: it.ch };
    }
    if (deck === "vocab") {
      if (mode === "word") return { prompt: short(it.m), small: true, ask: "Which word means this?", answer: it.w, choices: uniq(it.w, o => o.w), jp: true };
      if (mode === "reading") {
        return { prompt: it.w, ask: "How is this read?", answer: it.r, choices: uniq(it.r, o => o.r), jp: true };
      }
      return { prompt: it.w, ask: "What does this mean?", answer: short(it.m), choices: uniq(short(it.m), o => short(o.m)), say: it.r || it.w };
    }
    if (deck === "kanji") {
      const m1 = m => m.split(",").slice(0, 3).join(",");
      const rd = k => (k.on[0] || k.kun[0] || "");
      if (mode === "kanji") return { prompt: m1(it.m), small: true, ask: "Which kanji means this?", answer: it.k, choices: uniq(it.k, o => o.k), jp: true };
      if (mode === "reading") return { prompt: it.k, ask: "Which is a reading of this kanji?", answer: rd(it), choices: uniq(rd(it), o => (o.on.concat(o.kun).some(r => r === rd(it)) ? "" : rd(o))), jp: true };
      return { prompt: it.k, ask: "What does this kanji mean?", answer: m1(it.m), choices: uniq(m1(it.m), o => m1(o.m)) };
    }
    if (mode === "pattern") return { prompt: it.ex, small: true, ask: `“${it.en}” — which grammar point is used?`, answer: it.p, choices: uniq(it.p, o => o.p), jp: true };
    return { prompt: it.p, ask: "What does this grammar point mean?", answer: it.m, choices: uniq(it.m, o => o.m), small: false };
  }
  function viewQuiz(params) {
    const lv = state.level;
    let deck = DECKS[params.get("deck")] ? params.get("deck") : "vocab";
    $view.innerHTML = `<h1>Quiz</h1><p class="sub">Test yourself on ${lv} (kana quizzes cover all characters). Missed items can be sent to your review queue.</p>
      <div class="panel"><div class="row">
        <label>Deck <select id="qd">${Object.keys(DECKS).map(d => `<option value="${d}" ${d === deck ? "selected" : ""}>${DECKS[d].name}</option>`).join("")}</select></label>
        <label>Mode <select id="qm"></select></label>
        <label>Questions <select id="qn"><option>10</option><option selected>20</option><option>30</option><option>50</option></select></label>
        <label>From <select id="qs"><option value="all">Whole deck</option><option value="studied">Cards I've studied</option></select></label>
        <span class="spacer"></span><button class="btn primary" id="go">Start quiz</button></div></div>
      <div id="quiz"></div>`;
    const qd = document.getElementById("qd"), qm = document.getElementById("qm");
    const fillModes = () => { qm.innerHTML = QUIZ_MODES[qd.value].map(m => `<option value="${m[0]}">${m[1]}</option>`).join(""); };
    qd.onchange = fillModes; fillModes();
    document.getElementById("go").onclick = () => {
      deck = qd.value;
      let pool = items(deck, lv);
      if (document.getElementById("qs").value === "studied") pool = pool.filter(it => state.cards[it.id]);
      if (deck === "vocab" && qm.value === "reading") pool = pool.filter(it => it.r);
      if (pool.length < 4) return toast("Not enough items yet. Study some cards first, or choose Whole deck.");
      runQuiz(deck, qm.value, pool, +document.getElementById("qn").value);
    };
    if (params.get("deck")) document.getElementById("go").focus();
  }
  function runQuiz(deck, mode, pool, n) {
    const lv = state.level;
    const fullPool = deck === "vocab" && mode === "reading" ? items(deck, lv).filter(x => x.r) : items(deck, lv);
    const questions = sample(pool, Math.min(n, pool.length)).map(it => Object.assign({ id: it.id }, makeQuestion(deck, mode, it, fullPool)));
    runSession(document.getElementById("quiz"), questions, {
      onFinish: (score, total) => {
        state.quizzes.push({ date: Date.now(), deck, level: DECKS[deck].leveled ? lv : "", mode, score, total });
        if (state.quizzes.length > 100) state.quizzes.shift();
        save();
      },
      again: () => runQuiz(deck, mode, pool, n)
    });
  }

  // Sends missed items back to the review queue so they show up as due now.
  function requeue(ids) {
    for (const id of ids) {
      if (!id) continue;
      const c = state.cards[id] || { ivl: 0, ease: 2.5, reps: 0, lapses: 0 };
      c.due = Date.now(); c.ivl = 0; c.reps = 0; state.cards[id] = c;
    }
    save();
  }
  function missedHtml(missed) {
    if (!missed.length) return "<p>Perfect score!</p>";
    return `<table class="list" style="text-align:left;max-width:640px;margin:10px auto"><thead><tr><th>Question</th><th>Your answer</th><th>Correct answer</th></tr></thead><tbody>${missed.map(m =>
      `<tr><td class="${m.q.jp || m.q.audio ? "jp" : ""}">${esc(m.q.transcript || m.q.prompt)}${m.q.audio ? " " + speakBtn(m.q.audio) : ""}</td><td>${esc(m.given || "—")}</td><td class="jp">${esc(m.q.answer)}</td></tr>`).join("")}</tbody></table>
      ${missed.some(m => m.q.id) ? `<button class="btn primary" id="addMissed">Add missed to review</button>` : ""}`;
  }
  function wireMissed(missed) {
    const am = document.getElementById("addMissed");
    if (am) am.onclick = () => { requeue(missed.map(m => m.q.id)); am.disabled = true; am.textContent = "Added to review"; };
  }

  /* Runs a list of questions. Each question: { id?, prompt, ask, answer, choices | typed, jp?, small?,
     audio? (text spoken instead of showing the prompt), transcript? (shown after answering), say?, section? }.
     opts.exam: no feedback per question, a countdown, and results by section. */
  function runSession(box, questions, opts) {
    let i = 0, score = 0, answered = false, timer = null;
    const results = [];
    const norm = s => s.trim().toLowerCase();
    const exam = !!opts.exam;
    const endAt = exam && opts.minutes ? Date.now() + opts.minutes * 60000 : 0;
    const playQ = (q, slow) => q.audio && speak(q.audio, slow ? 0.6 : undefined);
    function finish() {
      if (timer) clearInterval(timer);
      // Unanswered questions (time ran out) count as wrong.
      for (let k = results.length; k < questions.length; k++) results.push({ q: questions[k], given: "", ok: false });
      const missed = results.filter(r => !r.ok);
      opts.onFinish && opts.onFinish(score, questions.length, results);
      if (exam) { box.innerHTML = opts.renderResults(results) + missedHtml(missed) + `<div class="row" style="justify-content:center;margin-top:10px"><button class="btn" id="again">New exam</button></div></div>`; }
      else {
        box.innerHTML = `<div class="panel empty-state" style="margin-top:14px"><div style="font-size:44px">${score / questions.length >= .8 ? "🎉" : score / questions.length >= .5 ? "👍" : "📚"}</div>
          <h2>${score} / ${questions.length} correct (${Math.round(100 * score / questions.length)}%)</h2>
          ${missedHtml(missed)} <button class="btn" id="again">Go again</button></div>`;
      }
      wireMissed(missed);
      document.getElementById("again").onclick = opts.again;
      box.scrollIntoView({ block: "start" });
    }
    function tick() {
      const el = document.getElementById("clock");
      if (!document.body.contains(box)) { clearInterval(timer); return; }
      const left = Math.max(0, endAt - Date.now());
      if (el) el.textContent = Math.floor(left / 60000) + ":" + String(Math.floor(left / 1000) % 60).padStart(2, "0");
      if (left <= 0) { toast("Time's up!"); finish(); }
    }
    function show() {
      if (i >= questions.length) return finish();
      answered = false;
      const q = questions[i];
      const head = exam
        ? `<div class="row progress-line" style="justify-content:space-between"><span><strong>${esc(q.section || "")}</strong> · Question ${i + 1} of ${questions.length}</span>${endAt ? `<span>⏱ <span id="clock"></span></span>` : ""}<button class="btn small" id="quit">Finish exam</button></div>`
        : `<div class="progress-line">Question ${i + 1} of ${questions.length} · Score ${score}</div>`;
      const promptHtml = q.audio
        ? `<div class="row" style="justify-content:center"><button class="btn primary" id="play" style="font-size:20px;padding:14px 22px">▶ Play</button><button class="btn" id="slow" title="Play slowly">🐢 Slow</button></div>
           <div class="prompt small" id="transcript" style="visibility:hidden;margin-top:12px">${esc(q.transcript || q.audio)}</div>`
        : `<div class="prompt ${q.small ? "small" : ""}">${q.html || esc(q.prompt)}</div>`;
      box.innerHTML = `<div class="panel" style="margin-top:14px">${head}
        <div class="quiz-q">${promptHtml}<div class="ask">${esc(q.ask)}</div></div>
        ${q.typed ? `<input type="text" class="answer-input" id="ans" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="romaji, then Enter">`
                  : `<div class="choices">${q.choices.map((c, k) => `<button class="choice ${q.jp ? "jp" : ""}" data-c="${esc(c)}">${k + 1}. ${esc(c)}</button>`).join("")}</div>`}
        <div class="feedback" id="fb"></div>
        <div class="row" style="justify-content:center;margin-top:8px"><button class="btn" id="next" style="visibility:hidden">Next ›</button></div>
        ${q.audio ? `<p class="hint" style="text-align:center;color:var(--muted);font-size:13px;margin:6px 0 0">Press <kbd>R</kbd> to replay</p>` : ""}</div>`;
      if (exam && endAt) tick();
      const quit = document.getElementById("quit");
      if (quit) quit.onclick = () => { if (confirm("Finish now? Unanswered questions count as wrong.")) finish(); };
      if (q.audio) {
        document.getElementById("play").onclick = () => playQ(q);
        document.getElementById("slow").onclick = () => playQ(q, true);
        setTimeout(() => { if (questions[i] === q) playQ(q); }, 250);
      }
      const fb = document.getElementById("fb"), next = document.getElementById("next");
      const mark = (ok, given) => {
        answered = true;
        results.push({ q, given, ok });
        if (ok) score++;
        if (exam) { i++; show(); return; }
        if (ok) { fb.className = "feedback ok"; fb.textContent = "Correct!"; }
        else { fb.className = "feedback bad"; fb.textContent = "Answer: " + q.answer; }
        const tr = document.getElementById("transcript"); if (tr) tr.style.visibility = "visible";
        if (q.say) speak(q.say);
        next.style.visibility = "visible"; if (!q.typed) next.focus();
      };
      if (q.typed) {
        const inp = document.getElementById("ans"); inp.focus();
        inp.onkeydown = e => { if (e.key === "Enter" && !answered && inp.value.trim()) { e.stopPropagation(); inp.disabled = true; mark(norm(inp.value) === norm(q.answer), inp.value.trim()); } };
      } else {
        box.querySelectorAll(".choice").forEach(b => b.onclick = () => {
          if (answered) return;
          const ok = b.dataset.c === q.answer;
          box.querySelectorAll(".choice").forEach(x => { x.disabled = true; if (!exam && x.dataset.c === q.answer) x.classList.add("right"); });
          if (!ok && !exam) b.classList.add("wrong");
          mark(ok, b.dataset.c);
        });
      }
      next.onclick = () => { i++; show(); };
    }
    function onKey(e) {
      if (!document.body.contains(box)) return;
      if (e.target.tagName === "INPUT") return;
      if ((e.key === "r" || e.key === "R") && questions[i] && questions[i].audio) { playQ(questions[i]); return; }
      // A focused button handles Enter/Space itself; only advance here when focus is elsewhere.
      if (answered && (e.key === "Enter" || e.key === " ") && e.target.tagName !== "BUTTON") { e.preventDefault(); i++; show(); return; }
      if (!answered && /^[1-4]$/.test(e.key)) {
        const b = box.querySelectorAll(".choice")[+e.key - 1]; if (b) b.click();
      }
    }
    if (cleanup) cleanup();
    document.addEventListener("keydown", onKey);
    cleanup = () => { document.removeEventListener("keydown", onKey); if (timer) clearInterval(timer); };
    if (endAt) timer = setInterval(tick, 1000);
    show();
  }

  // ---------- Listening ----------
  const LISTEN_MODES = [
    ["word-meaning", "Hear a word → choose the meaning"],
    ["word-written", "Hear a word → choose how it's written"],
    ["sentence", "Hear a sentence → choose the English"],
    ["kana", "Kana dictation → type the romaji"]
  ];
  function listeningQuestion(mode, it, pool) {
    const others = sample(pool.filter(x => x.id !== it.id), 12);
    const pick = (correct, fn) => {
      const seen = new Set([correct]), out = [];
      for (const o of others) { const v = fn(o); if (v && !seen.has(v)) { seen.add(v); out.push(v); } if (out.length === 3) break; }
      return shuffle([correct].concat(out));
    };
    const short = m => m.split(/;\s*/).slice(0, 2).join("; ");
    if (mode === "kana") return { id: it.id, audio: it.ch, transcript: it.ch, ask: "Type what you hear in romaji", answer: it.romaji, typed: true };
    if (mode === "sentence") return { id: it.id, audio: it.ex.replace(/\s+/g, ""), transcript: it.ex, ask: "What does the sentence mean?", answer: it.en, choices: pick(it.en, o => o.en) };
    if (mode === "word-written") return { id: it.id, audio: it.r || it.w, transcript: (it.r ? it.r + " — " : "") + short(it.m), ask: "Which word did you hear?", answer: it.w, choices: pick(it.w, o => o.w), jp: true };
    return { id: it.id, audio: it.r || it.w, transcript: it.w + (it.r ? "（" + it.r + "）" : ""), ask: "What does the word mean?", answer: short(it.m), choices: pick(short(it.m), o => short(o.m)) };
  }
  function voiceWarning() {
    if (!("speechSynthesis" in window)) return `<div class="panel warn-box">This browser can't play speech. Try Chrome or Edge.</div>`;
    return `<div class="panel warn-box" id="noVoice" style="display:none">No Japanese voice was found, so audio may sound wrong or be silent. Chrome and Edge include Japanese voices. On Windows you can also add one under Settings › Time &amp; language › Speech.</div>`;
  }
  function checkVoice() {
    setTimeout(() => { const el = document.getElementById("noVoice"); if (el && !jaVoice) el.style.display = ""; }, 800);
  }
  function viewListening() {
    const lv = state.level;
    $view.innerHTML = `<h1>Listening</h1><p class="sub">Train your ear for ${lv}. Audio uses your browser's Japanese voice. The answer's written form appears after you answer.</p>
      ${voiceWarning()}
      <div class="panel"><div class="row">
        <label>Exercise <select id="lm">${LISTEN_MODES.map(m => `<option value="${m[0]}">${m[1]}</option>`).join("")}</select></label>
        <label>Questions <select id="ln"><option>10</option><option selected>20</option><option>30</option></select></label>
        <label>From <select id="ls"><option value="all">Whole level</option><option value="studied">Items I've studied</option></select></label>
        <span class="spacer"></span><button class="btn primary" id="go">Start</button></div></div>
      <div id="quiz"></div>`;
    checkVoice();
    document.getElementById("go").onclick = function start() {
      const mode = document.getElementById("lm").value, n = +document.getElementById("ln").value;
      const deck = mode === "kana" ? "hiragana" : mode === "sentence" ? "grammar" : "vocab";
      const full = mode === "kana" ? items("hiragana", lv).concat(items("katakana", lv)) : items(deck, lv);
      let pool = full;
      if (document.getElementById("ls").value === "studied") pool = pool.filter(it => state.cards[it.id]);
      if (pool.length < 4) return toast("Not enough studied items yet. Choose Whole level instead.");
      const qs = sample(pool, Math.min(n, pool.length)).map(it => listeningQuestion(mode, it, full));
      runSession(document.getElementById("quiz"), qs, {
        onFinish: (score, total) => { state.quizzes.push({ date: Date.now(), deck: "listening", level: lv, mode, score, total }); if (state.quizzes.length > 100) state.quizzes.shift(); save(); },
        again: start
      });
    };
  }

  // ---------- Mock exam ----------
  // Official JLPT pass marks: overall score out of 180, and at least 19/60 (about 32%) in every section.
  const PASS = { N1: 100, N2: 90, N3: 95, N4: 90, N5: 80 };
  const EXAM_LEN = { short: { kr: 5, ko: 4, km: 6, gf: 8, gp: 2, lw: 4, ls: 6, min: 20 }, full: { kr: 10, ko: 8, km: 12, gf: 16, gp: 4, lw: 8, ls: 12, min: 45 } };
  const hasKanji = s => /[一-鿿]/.test(s);
  // The part of a grammar pattern you'd see in a sentence: "～てから" → "てから".
  const grammarCore = p => p.replace(/\s*\(.*?\)|（.*?）/g, "").replace(/^.*\+\s*/, "").split(/\s*\/\s*/)[0].replace(/～/g, "").replace(/\s/g, "").trim();
  // Patterns that can often replace each other, so one is never a wrong option for the other.
  const SIMILAR = [["から", "ので", "ために", "おかげで", "せいか", "ものですから", "ゆえ", "ゆえに"], ["たら", "ば", "と", "なら", "としたら"], ["ても", "のに", "ながらも", "とはいえ", "といえども", "ものの"],
    ["みたい", "らしい", "そうです", "ようだ"], ["しかない", "より仕方がない", "ないわけにはいかない"], ["さえ", "すら", "でさえ", "こそ"], ["ている", "てある"], ["なり", "や否や", "が早いか"]];
  const interchangeable = (a, b) => SIMILAR.some(g => g.some(x => a.startsWith(x)) && g.some(x => b.startsWith(x)));
  function buildExam(lv, size) {
    const L = EXAM_LEN[size];
    const vocab = items("vocab", lv), grammar = items("grammar", lv);
    const kanjiWords = vocab.filter(v => v.r && hasKanji(v.w));
    const short = m => m.split(/;\s*/).slice(0, 2).join("; ");
    const pick = (pool, it, correct, fn) => {
      const seen = new Set([correct]), out = [];
      for (const o of sample(pool.filter(x => x.id !== it.id), 30)) { const v = fn(o); if (v && !seen.has(v)) { seen.add(v); out.push(v); } if (out.length === 3) break; }
      return shuffle([correct].concat(out));
    };
    // Prefer distractors of similar length, like the real test.
    const near = (pool, it, key) => pool.filter(o => Math.abs(o[key].length - it[key].length) <= 1);
    const V = "Vocabulary 文字・語彙", G = "Grammar 文法", A = "Listening 聴解";
    const qs = [];
    for (const it of sample(kanjiWords, L.kr))
      qs.push({ id: it.id, section: V, prompt: it.w, ask: "Choose the reading of the word.", answer: it.r, choices: pick(near(kanjiWords, it, "r"), it, it.r, o => o.r), jp: true });
    for (const it of sample(kanjiWords, L.ko))
      qs.push({ id: it.id, section: V, prompt: it.r, ask: "Choose how the word is written.", answer: it.w, choices: pick(near(kanjiWords, it, "w"), it, it.w, o => o.w), jp: true });
    for (const it of sample(vocab, L.km))
      qs.push({ id: it.id, section: V, prompt: it.w, ask: "Choose the meaning.", answer: short(it.m), choices: pick(vocab, it, short(it.m), o => short(o.m)) });
    // Two-part patterns like まだ～ていません can't be shown as a single blank.
    const onePart = g => !/～/.test(g.p.replace(/^～/, ""));
    const fillable = grammar.filter(g => { const c = grammarCore(g.p); return onePart(g) && c.length >= 1 && g.ex.replace(/\s/g, "").includes(c); });
    const gf = sample(fillable, L.gf);
    for (const it of gf) {
      const c = grammarCore(it.p), sent = it.ex.replace(/\s/g, "");
      const k = sent.indexOf(c);
      const html = `${esc(sent.slice(0, k))}<span class="blank">（　　　）</span>${esc(sent.slice(k + c.length))}`;
      qs.push({ id: it.id, section: G, prompt: sent.slice(0, k) + "（　）" + sent.slice(k + c.length), html, small: true, ask: "Choose the best fit for the blank. (" + it.en + ")", answer: c,
        choices: pick(grammar.filter(o => onePart(o) && !sent.includes(grammarCore(o.p)) && !interchangeable(c, grammarCore(o.p))), it, c, o => grammarCore(o.p)), jp: true, transcript: sent });
    }
    for (const it of sample(grammar.filter(g => !gf.includes(g)), L.gp + (L.gf - gf.length)))
      qs.push({ id: it.id, section: G, prompt: it.ex, small: true, ask: "Which grammar point does this sentence use?", answer: it.p, choices: pick(grammar, it, it.p, o => o.p), jp: true });
    for (const it of sample(vocab, L.lw)) {
      const q = listeningQuestion("word-meaning", it, vocab); q.section = A; qs.push(q);
    }
    for (const it of sample(grammar, L.ls)) {
      const q = listeningQuestion("sentence", it, grammar); q.section = A; qs.push(q);
    }
    return { questions: qs, minutes: L.min };
  }
  function viewExam() {
    const lv = state.level;
    const past = (state.exams || []).filter(e => e.level === lv).slice(-5).reverse();
    $view.innerHTML = `<h1>Mock exam ${lv}</h1>
      <p class="sub">A timed practice test in the three JLPT sections: vocabulary, grammar and listening. Scores are scaled to 180 like the real test, using the official pass mark for ${lv} (${PASS[lv]}/180, and at least 19/60 per section). Treat the result as a rough guide.</p>
      ${voiceWarning()}
      <div class="panel" id="setup"><div class="row">
        <label>Length <select id="es"><option value="short">Short: 35 questions, 20 min</option><option value="full">Full: 70 questions, 45 min</option></select></label>
        <span class="spacer"></span><button class="btn primary" id="go">Start exam</button></div>
        <p class="sub" style="margin:10px 0 0">You won't see answers until the end. Listening questions play once automatically. Press <kbd>R</kbd> or ▶ to replay.</p></div>
      ${past.length ? `<h2>Past ${lv} exams</h2><table class="list"><thead><tr><th>Date</th><th>Score</th><th>Vocabulary</th><th>Grammar</th><th>Listening</th><th>Result</th></tr></thead><tbody>${past.map(e =>
        `<tr><td>${new Date(e.date).toLocaleDateString()}</td><td>${e.total}/180</td><td>${e.parts[0]}/60</td><td>${e.parts[1]}/60</td><td>${e.parts[2]}/60</td><td>${e.pass ? `<span class="pill learned">Pass</span>` : `<span class="pill due">Not yet</span>`}</td></tr>`).join("")}</tbody></table>` : ""}
      <div id="quiz"></div>`;
    checkVoice();
    document.getElementById("go").onclick = function start() {
      const size = document.getElementById("es").value;
      const { questions, minutes } = buildExam(lv, size);
      document.getElementById("setup").style.display = "none";
      runSession(document.getElementById("quiz"), questions, {
        exam: true, minutes,
        renderResults: results => {
          const secs = ["Vocabulary 文字・語彙", "Grammar 文法", "Listening 聴解"];
          const parts = secs.map(s => { const r = results.filter(x => x.q.section === s); return r.length ? Math.round(60 * r.filter(x => x.ok).length / r.length) : 0; });
          const total = parts.reduce((a, b) => a + b, 0);
          const pass = total >= PASS[lv] && parts.every(p => p >= 19);
          state.exams = (state.exams || []).concat([{ date: Date.now(), level: lv, size, total, parts, pass }]).slice(-50);
          save();
          return `<div class="panel" style="margin-top:14px;text-align:center"><div style="font-size:44px">${pass ? "🎉" : "📚"}</div>
            <h2 style="margin:4px 0">${total} / 180 · ${pass ? "Pass" : "Not a pass yet"}</h2>
            <p class="sub">Pass mark for ${lv}: ${PASS[lv]}/180 with at least 19/60 in each section.</p>
            <div class="grid cols-3" style="text-align:left">${secs.map((s, k) => `<div class="panel stat"><div class="num">${parts[k]}<span class="lbl">/60</span></div><div class="lbl">${s}${parts[k] < 19 ? " · below 19" : ""}</div><div class="bar"><span style="width:${100 * parts[k] / 60}%;${parts[k] < 19 ? "background:var(--accent)" : ""}"></span></div></div>`).join("")}</div>
            <h2>Questions you missed</h2>`;
        },
        again: () => route()
      });
    };
  }

  // ---------- Progress ----------
  function viewProgress() {
    const rows = [];
    for (const d of ["hiragana", "katakana"]) rows.push([DECKS[d].name, deckCounts(d, "N5")]);
    for (const l of LEVELS) for (const d of ["vocab", "kanji", "grammar"]) rows.push([DECKS[d].name + " " + l, deckCounts(d, l)]);
    const days = [];
    for (let k = 139; k >= 0; k--) {
      const key = dayKey(Date.now() - k * DAY), r = (state.log[key] || {}).reviews || 0;
      days.push(`<span class="${r === 0 ? "" : r < 20 ? "l1" : r < 60 ? "l2" : "l3"}" title="${key}: ${r} reviews"></span>`);
    }
    const totals = Object.values(state.log).reduce((a, x) => ({ reviews: a.reviews + x.reviews, correct: a.correct + x.correct }), { reviews: 0, correct: 0 });
    const quizzes = state.quizzes.slice(-10).reverse();
    $view.innerHTML = `<h1>Progress</h1><p class="sub">${totals.reviews} reviews in total${totals.reviews ? ", " + Math.round(100 * totals.correct / totals.reviews) + "% remembered" : ""} · ${streak()} day streak</p>
      <div class="panel"><h2 style="margin-top:0">Last 20 weeks</h2><div class="heat">${days.join("")}</div></div>
      <h2>Decks</h2>
      <table class="list"><thead><tr><th>Deck</th><th>Learned</th><th style="width:40%">Progress</th><th>Due</th></tr></thead><tbody>
      ${rows.map(([name, c]) => `<tr><td>${name}</td><td>${c.learned} / ${c.total}</td><td><div class="bar"><span style="width:${c.total ? 100 * c.learned / c.total : 0}%"></span></div></td><td>${c.due ? `<span class="pill due">${c.due}</span>` : "—"}</td></tr>`).join("")}
      </tbody></table>
      ${quizzes.length ? `<h2>Recent quizzes</h2><table class="list"><thead><tr><th>Date</th><th>Deck</th><th>Mode</th><th>Score</th></tr></thead><tbody>${quizzes.map(q => `<tr><td>${new Date(q.date).toLocaleDateString()}</td><td>${q.deck === "listening" ? "Listening" : DECKS[q.deck].name} ${q.level}</td><td>${esc(((q.deck === "listening" ? LISTEN_MODES : QUIZ_MODES[q.deck]) || []).concat([["", q.mode]]).find(m => m[0] === q.mode)[1])}</td><td>${q.score}/${q.total}</td></tr>`).join("")}</tbody></table>` : ""}
      <h2>Settings & backup</h2>
      <div class="panel"><div class="row">
        <label>New cards per deck per day <input type="number" id="npd" min="0" max="200" value="${state.newPerDay}" style="width:80px"></label></div>
        <div class="row" style="margin-top:12px">
        <label>Voice <select id="voice"><option value="">Automatic</option>${jaVoices().map(v => `<option ${v.name === state.audio.voice ? "selected" : ""}>${esc(v.name)}</option>`).join("")}</select></label>
        <label>Speed <select id="rate">${[[0.6, "Slow"], [0.8, "Relaxed"], [0.9, "Normal"], [1, "Natural"], [1.15, "Fast"]].map(r => `<option value="${r[0]}" ${+state.audio.rate === r[0] ? "selected" : ""}>${r[1]}</option>`).join("")}</select></label>
        <label class="row" style="gap:4px"><input type="checkbox" id="ap" ${state.audio.autoplay ? "checked" : ""}> Auto-play audio on flashcards</label>
        <button class="btn small" id="testVoice">🔊 Test</button></div>
        <div class="row" style="margin-top:12px">
        <span class="spacer"></span>
        <button class="btn" id="exp">Export progress</button>
        <label class="btn">Import progress<input type="file" id="imp" accept=".json,application/json" hidden></label>
        <button class="btn" id="reset" style="color:var(--accent)">Reset everything</button></div>
        <p class="sub" style="margin:10px 0 0">Progress lives in this browser only. Export a backup now and then, and import it to move to another computer or browser.</p></div>`;
    document.getElementById("voice").onchange = e => { state.audio.voice = e.target.value; save(); pickVoice(); speak("こんにちは"); };
    document.getElementById("rate").onchange = e => { state.audio.rate = +e.target.value; save(); speak("こんにちは、よろしく おねがいします"); };
    document.getElementById("ap").onchange = e => { state.audio.autoplay = e.target.checked; save(); };
    document.getElementById("testVoice").onclick = () => speak("こんにちは、よろしく おねがいします");
    document.getElementById("npd").onchange = e => { state.newPerDay = Math.max(0, Math.min(200, parseInt(e.target.value, 10) || 0)); save(); toast("Saved"); };
    document.getElementById("exp").onclick = () => {
      const blob = new Blob([JSON.stringify(state)], { type: "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "jlpt-progress-" + dayKey() + ".json"; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    document.getElementById("imp").onchange = e => {
      const f = e.target.files[0]; if (!f) return;
      f.text().then(t => {
        const data = JSON.parse(t);
        if (!data || typeof data.cards !== "object") throw new Error("bad file");
        state = Object.assign(defaultState(), data); save(); renderLevelPicker(); toast("Progress imported"); route();
      }).catch(() => toast("That file isn't a JLPT Study backup."));
    };
    document.getElementById("reset").onclick = () => {
      if (confirm("Erase all progress in this browser? Export a backup first if you might want it back.")) { state = defaultState(); save(); renderLevelPicker(); route(); }
    };
  }

  renderLevelPicker();
  route();
})();
