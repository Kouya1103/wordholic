"use strict";

const $ = (selector) => document.querySelector(selector);
const token = $('meta[name="app-token"]').content;
const portableMode = true;
let state = null;
let page = "learn";
let words = [];
let sessionSnapshot = "";
let noticeTimer;
let refreshing = false;
let adding = false;
let csvPayload = null;
let signedIn = false;
let authEpoch = 0;
let setupRequired = false;
let materialPayload = null;

function resetMaterial() { materialPayload = null; $("#material-save").hidden = true; $("#material-preview").textContent = ""; }
$("#material-file").addEventListener("change", resetMaterial);
$("#material-update").addEventListener("change", resetMaterial);
$("#material-form").addEventListener("submit", event => {
  event.preventDefault();
  busy(event.target.querySelector("button"), async () => {
    resetMaterial();
    const file = $("#material-file").files[0];
    if (!file || file.size > 64 * 1024 * 1024) throw new Error("64MB以下の教材JSONを選んでください。");
    const selected = file;
    const update = $("#material-update").checked;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const payload = {file: btoa(binary), update};
    const result = await api("materials/preview", payload);
    if ($("#material-file").files[0] !== selected || $("#material-update").checked !== update) return;
    materialPayload = payload;
    $("#material-preview").innerHTML = `<p>追加 ${result.added} / 更新 ${result.updated} / スキップ ${result.skipped}</p><ul>${result.entries.map(w => `<li>${escapeHTML(w.action)}：${escapeHTML(w.word)}（${escapeHTML(w.pos)}）${escapeHTML(w.meaning)}</li>`).join("")}</ul>`;
    $("#material-save").hidden = false;
  });
});
$("#material-save").addEventListener("click", event => busy(event.currentTarget, async () => {
  if (!materialPayload) throw new Error("もう一度教材を確認してください。");
  const result = await api("materials/import", materialPayload);
  resetMaterial();
  tell(`${result.message} 追加${result.added}・更新${result.updated}・スキップ${result.skipped}`);
  await refresh();
  await loadLibrary();
}));
const levelNames = {basic: "初級", standard: "中級", advanced: "上級"};
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

async function api(path, data) { return KotonohaLocal.api(path, data); }

function tell(message, error = false) {
  const element = $(error ? "#error" : "#notice");
  element.textContent = message;
  element.hidden = false;
  if (!error) {
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { element.hidden = true; }, 10000);
  }
}

async function busy(button, action, label = "処理中…") {
  if (button.disabled) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  $("#error").hidden = true;
  try { await action(); }
  catch (error) { tell(error.message, true); }
  finally { button.disabled = false; button.textContent = original; }
}

function notesHTML(word, identifier = null) {
  return `<div class="notes">
    <h3>発音を確認する</h3>${pronunciationHTML(word.word)}
    <h3>例文で覚える</h3><p class="example" lang="en">${escapeHTML(word.example || "例文は未登録です。")}</p><p class="translation">${escapeHTML(word.translation)}</p>
    <h3>コロケーション · よく一緒に使う語句</h3>${(word.collocations || []).map(c => `<div class="synonym"><strong lang="en">${escapeHTML(c.phrase)}</strong><p>${escapeHTML(c.meaning)}</p><p class="example" lang="en">${escapeHTML(c.example)}</p><p class="translation">${escapeHTML(c.translation)}</p></div>`).join("") || `<p class="small muted">コロケーションは未登録です。</p>${false ? `<button class="button secondary collocations-complete" data-id="${escapeHTML(identifier)}">AIでコロケーションを追加</button>` : ""}`} ${word.collocations_source ? `<p class="small muted">${escapeHTML(word.collocations_source)}</p>` : ""}
    <h3>似ていることば、どう使い分ける？</h3>
    ${word.synonyms.map(s => `<div class="synonym"><strong lang="en">${escapeHTML(s.word)}</strong>${pronunciationHTML(s.word)}<p>${escapeHTML(s.difference)}</p><p class="example" lang="en">${escapeHTML(s.example)}</p><p class="translation">${escapeHTML(s.translation)}</p></div>`).join("") || '<p class="small muted">使い分けの解説は未登録です。</p>'}
    <h3>語形・関連語</h3><div class="forms">${word.forms.map(f => `<div class="form-item"><strong lang="en">${escapeHTML(f.word)}</strong><span>${escapeHTML(f.description)}</span></div>`).join("") || '<p class="small muted">語形は未登録です。</p>'}</div>
    <h3>認められる言い換えの例</h3><p class="small muted">${[word.meaning, ...word.aliases].map(escapeHTML).join(" ／ ")}</p>
    <h3>ニュアンス・覚え方</h3><p>${escapeHTML(word.nuance || "ニュアンス：データなし")}</p><p>${escapeHTML(word.mnemonic || "覚え方：データなし")}</p>
    ${dictionaryHTML(word.word)}
  </div>`;
}

function proficiencyHTML(p) {
  if (!p) return "";
  return `<div class="proficiency-card"><p class="small muted">初回回答に基づく習得段階</p><h3>${escapeHTML(p.label)}</h3>${p.receptive_only ? `<p class="receptive-notice">${escapeHTML(p.message)}</p>` : ""}${p.unassessed ? '<p class="small muted">この機能での判定はまだありません。</p>' : ""}<div class="csv-table"><table><thead><tr><th>確認方法</th><th>直近の初回結果</th><th>正解した日数</th></tr></thead><tbody>${Object.values(p.evidence).map(e => `<tr><td>${escapeHTML(e.label)}</td><td>${e.correct === null ? "未確認" : e.correct ? "○ 正解" : "× 不正解"}${e.last_day ? `<small> · ${escapeHTML(e.last_day)}</small>` : ""}</td><td>${e.success_days}日</td></tr>`).join("")}</tbody></table></div><p class="small muted">その場の再テストで正解しても、後日の初回回答までは段階を上げません。</p></div>`;
}

document.addEventListener("click", event => {
  const button = event.target.closest(".collocations-complete");
  if (!button) return;
  busy(button, async () => {
    const result = await api("collocations", {id: button.dataset.id});
    tell(result.message);
    await refresh();
    if (page === "library") await loadLibrary();
  }, "語句と例文を生成中…");
});

function pronunciationHTML(word) {
  const name = String(word).trim().toLowerCase();
  if (!/^[a-z][a-z '\-]{0,79}$/.test(name)) return "";
  return `<div class="pronunciation" data-word="${escapeHTML(name)}"><button class="button secondary pronunciation-play" type="button" aria-label="${escapeHTML(name)}の発音を聴く">▶ 発音</button><a href="https://en.wiktionary.org/wiki/${escapeHTML(encodeURIComponent(name))}#English" target="_blank" rel="noopener noreferrer">辞書で発音を確認 ↗</a><span class="pronunciation-result"></span></div>`;
}

function externalLink(url, title) {
  try {
    if (new URL(url).protocol !== "https:") return "";
    return `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(title)}</a>`;
  } catch { return ""; }
}

document.addEventListener("click", event => {
  const button = event.target.closest(".pronunciation-play");
  if (!button) return;
  const container = button.closest(".pronunciation");
  busy(button, async () => {
    let result = await api("pronunciation", {word: container.dataset.word});
    if (!result.audio_data) {
      await api("dictionary", {word: container.dataset.word}).catch(() => null);
      result = await api("pronunciation", {word: container.dataset.word});
    }
    if (!container.isConnected) return;
    const output = container.querySelector(".pronunciation-result");
    output.innerHTML = `${result.phonetic ? `<span class="phonetic">${escapeHTML(result.phonetic)}</span>` : ""}${result.audio_data ? `<audio controls preload="none" src="${escapeHTML(result.audio_data)}" aria-label="${escapeHTML(result.word)}の保存済み発音"></audio>` : ""}<span class="small muted">${escapeHTML(result.message)}</span><span class="small muted">${externalLink(result.source_page || result.audio_source, "音声の出典")}${result.license_name ? ` · ${externalLink(result.license_url, result.license_name) || escapeHTML(result.license_name)}` : ""}</span>`;
    if (result.audio_data) {
      button.hidden = true;
      const audio = output.querySelector("audio");
      document.querySelectorAll("audio").forEach(other => { if (other !== audio) other.pause(); });
      audio.addEventListener("error", () => tell("この音声を再生できません。辞書リンクから確認してください。"));
      await audio.play().catch(() => { /* Browser may require another press on its play control. */ });
    } else {
      output.insertAdjacentHTML("beforeend", `<button class="button secondary tts-play" data-word="${escapeHTML(result.word)}">端末の英語音声で読む</button><span class="small muted"></span>`);
      // A second explicit tap keeps synthesis inside the mobile browser's activation window.
      button.hidden = true;
    }
  }, "音声を確認中…");
});

document.addEventListener("play", event => {
  if (event.target.tagName === "AUDIO") document.querySelectorAll("audio").forEach(audio => { if (audio !== event.target) audio.pause(); });
}, true);

function renderStudy() {
  const s = state.session;
  const snapshot = JSON.stringify([s, s ? null : [state.level, state.counts[state.level], state.ai_enabled, state.job.running]]);
  if (snapshot === sessionSnapshot) return;
  sessionSnapshot = snapshot;
  const card = $("#study-card");
  card.querySelectorAll("audio").forEach(audio => audio.pause());
  if (!s) {
    const count = Math.min(100, state.counts[state.level]);
    card.innerHTML = `<div class="welcome"><div class="welcome-mark">❧</div><h2>今日の学びを、はじめよう。</h2><p>復習することばと、新しく出会うことば。<br>ひとつずつ、自分のペースで覚えましょう。</p><p><span class="pill">${levelNames[state.level]} · 基本 ${count} 問</span></p>${count < 100 ? `<p>現在は${count}語です。${state.ai_enabled ? "100問で始めるには自動補充の完了をお待ちください。" : "AI接続で100語まで自動補充できます。"}</p>` : ""}<button id="start" class="button primary">${count < 100 ? `${count}問で学習をはじめる` : "今日の100問をはじめる"} <span aria-hidden="true">　→</span></button></div>`;
    $("#start").addEventListener("click", event => busy(event.currentTarget, async () => { await api("start", {}); await refresh(); }));
    return;
  }
  if (s.typo_check) {
    const check = s.typo_check;
    card.innerHTML = `<div class="feedback-head"><span class="result-icon">?</span><div><h2>これは入力ミスですか？</h2><small>採点はまだ確定していません</small></div></div><p class="feedback-word">${escapeHTML(s.question.word || s.question.meaning)}</p><p class="small muted">${escapeHTML(check.message)}</p><p class="small">あなたの回答：${escapeHTML(check.pos)} · ${escapeHTML(check.answer)}</p><form id="typo-form"><label for="typo-answer">入力ミスなら、回答を訂正してください</label><input id="typo-answer" value="${escapeHTML(check.answer)}" maxlength="300" required autocomplete="off"><div class="answer-actions"><button id="typo-wrong" class="text-button" type="button">いいえ・不正解にする</button><button id="typo-correct" class="button primary" type="submit">訂正して採点する →</button></div></form><p class="small muted">確認はこの出題につき1回です。訂正後も意味や品詞が合わなければ、不正解として後半で復習します。</p>`;
    const resolve = async action => {
      const button = $(action === "correct" ? "#typo-correct" : "#typo-wrong");
      const other = $(action === "correct" ? "#typo-wrong" : "#typo-correct");
      const input = $("#typo-answer");
      const answer = action === "correct" ? input.value : check.answer;
      await busy(button, async () => {
        other.disabled = true;
        input.disabled = true;
        try {
          await api("answer", {token: check.token, pos: check.pos, answer, typo_action: action});
          await refresh();
        } finally { other.disabled = false; input.disabled = false; }
      }, "採点中…");
    };
    $("#typo-form").addEventListener("submit", event => { event.preventDefault(); resolve("correct"); });
    $("#typo-wrong").addEventListener("click", () => resolve("wrong"));
    $("#typo-answer").focus({preventScroll: true});
    return;
  }
  if (s.feedback) {
    const f = s.feedback;
    card.innerHTML = `<div class="feedback-actions"><button id="next" class="button primary">${s.done ? "学習結果を見る" : "次の問題へ"} →</button><div class="grade-actions"><button id="mark-correct" class="button secondary" ${!f.can_override || f.correct ? "disabled" : ""}>正解にする</button><button id="mark-wrong" class="button secondary" ${!f.can_override || !f.correct ? "disabled" : ""}>不正解にする</button><button class="button secondary delete-study-word" data-id="${escapeHTML(f.word_id)}" data-token="${escapeHTML(f.token)}" data-word="${escapeHTML(f.word.word)}">単語を削除</button></div></div>
      <div class="feedback-head"><span class="result-icon ${f.correct ? "" : "wrong"}">${f.correct ? "✓" : "↻"}</span><div><h2>${f.correct ? "正解です。" : "あとで、もう一度。"}</h2><small>${escapeHTML(f.method)}</small></div></div>
      <p class="feedback-word" lang="en">${escapeHTML(f.word.word)}</p><p class="meaning"><span class="pill">${escapeHTML(f.word.pos)}</span>${escapeHTML(f.word.meaning)}</p>
      <p class="small muted">あなたの回答：${escapeHTML(f.answer || "わからない")}</p>${f.original_answer ? `<p class="small muted">確認前の回答：${escapeHTML(f.original_answer)}</p>` : ""}<p class="feedback-reason">${escapeHTML(f.reason)}</p><p class="small muted">次の復習：${escapeHTML(f.next_due)}</p>
      ${!f.can_override ? '<p class="small muted">旧版で採点したこの回答は変更できません。次の回答から判定変更を利用できます。</p>' : ""}
      ${notesHTML(f.word, f.word_id)}<p class="small muted">解説：${escapeHTML(f.source)}</p><p class="small muted">ここで見た類義語・関連語は、原則10問ほど間隔を空けます。候補が少ない場合は可能な範囲で後ろへ回します。</p>
      <div class="next-row"><button id="next-bottom" class="button primary">${s.done ? "学習結果を見る" : "次の問題へ"} →</button></div>`;
    for (const [id, correct] of [["#mark-correct", true], ["#mark-wrong", false]]) {
      $(id).addEventListener("click", async event => {
        if (!window.confirm(`この回答を${correct ? "正解" : "不正解"}に変更しますか？学習履歴・習得段階・復習予定と再出題にも反映します。`)) return;
        const buttons = Array.from(card.querySelectorAll(".feedback-actions button, #next-bottom"));
        await busy(event.currentTarget, async () => {
          buttons.forEach(b => { b.disabled = true; });
          try { await api("answer/override", {token:f.token, revision:f.revision, correct, confirm:true}); }
          finally { sessionSnapshot = null; await refresh(); }
        }, "変更中…");
      });
    }
    let advancing = false;
    for (const id of ["#next", "#next-bottom"]) $(id).addEventListener("click", async event => {
      if (advancing) return;
      advancing = true;
      const buttons = Array.from(card.querySelectorAll(".feedback-actions button, #next-bottom"));
      const disabled = buttons.map(button => button.disabled);
      try {
        await busy(event.currentTarget, async () => {
          buttons.forEach(button => { button.disabled = true; });
          await api("next", {token: f.token});
          await refresh();
          if (window.innerWidth < 650) $("#study-card").scrollIntoView({behavior: "smooth", block: "start"});
        });
      } finally { buttons.forEach((button, i) => { button.disabled = disabled[i]; }); advancing = false; }
    });
    $("#next").focus({preventScroll: true});
    return;
  }
  if (s.done) {
    card.innerHTML = `<div class="welcome"><div class="welcome-mark">✓</div><h2>今日も、ひとつ積み重ねました。</h2><div class="completion-count">${s.mastered}<small> 語</small></div><p>すべての問題に正解できました。<br>基本問題 ${s.total} 問 ＋ 追加復習 ${s.attempts - s.total} 問<br>初回正答率 ${Math.round(s.first_correct / s.total * 100)}%</p>${s.total < 100 ? `<p>本日は登録済みの${s.total}語で学習しました。<br>単語を補充すると、明日から最大100問で学べます。</p>` : ""}<p>次の復習日も、自動で記録しています。</p><button class="button secondary" id="see-words">単語帳で振り返る →</button></div>`;
    $("#see-words").addEventListener("click", () => showPage("library"));
    return;
  }
  const q = s.question;
  const mode = q.mode || "en_ja";
  const answerLabel = mode === "en_ja" ? "日本語の意味" : mode === "ja_en" ? "英単語（原形）" : "自分で作った英文";
  const help = mode === "ja_en" ? `単語帳に登録した英単語を思い出してください（${q.letter_count}文字・${q.pos}）。`
    : mode === "usage" ? `「${q.meaning}」の意味・${q.pos}として、この単語を使った英文を1つ作ってください。`
    : q.example ? "この例文での日本語の意味を答えてください。" : "登録した日本語の意味を答えてください。";
  card.innerHTML = `<div class="question-top"><span class="pill">${escapeHTML(state.modes?.[mode] || "英語 → 日本語")}${s.retry ? " · 再テスト" : ""}</span><span>${s.retry ? `追加復習 ${s.attempts - s.total + 1} 問目` : `${s.base_done + 1} / ${s.total}`}</span></div>
    <div class="word-prompt"><h2 lang="${mode === "ja_en" ? "ja" : "en"}">${escapeHTML(mode === "ja_en" ? q.meaning : q.word)}</h2>${mode === "en_ja" ? `<p lang="en">${escapeHTML(q.example)}</p>${pronunciationHTML(q.word)}` : ""}</div>
    <p class="prompt-help">${escapeHTML(help)}</p>
    <form id="answer-form"><label for="answer-text">${answerLabel}</label><input id="answer-text" placeholder="${mode === "en_ja" ? "意味を入力してください" : mode === "ja_en" ? "英単語を入力してください" : "例文を英語で入力してください"}" maxlength="300" autocomplete="off" spellcheck="false" required><div class="answer-actions"><button id="skip" class="text-button" type="button">わからない・解説を見る</button><button id="answer-submit" class="button primary" type="submit">答え合わせ →</button></div></form><button class="text-button delete-study-word" data-id="${escapeHTML(q.id)}" data-token="${escapeHTML(q.token)}" data-word="${escapeHTML(q.word || q.meaning)}">この単語を削除</button>`;
  const submitAnswer = async (skip) => {
    const button = $(skip ? "#skip" : "#answer-submit");
    const other = $(skip ? "#answer-submit" : "#skip");
    const payload = {token: q.token, answer: $("#answer-text").value, skip};
    await busy(button, async () => {
      other.disabled = true;
      $("#answer-text").disabled = true;
      try {
        await api("answer", payload);
        await refresh();
      } finally {
        other.disabled = false;
        if ($("#answer-text")) $("#answer-text").disabled = false;
      }
    }, "採点中…");
  };
  $("#answer-form").addEventListener("submit", event => { event.preventDefault(); submitAnswer(false); });
  $("#skip").addEventListener("click", () => submitAnswer(true));
  $("#answer-text").focus({preventScroll: true});
}

function render() {
  const s = state.session;
  $("#date-label").textContent = new Intl.DateTimeFormat("ja-JP", {year: "numeric", month: "long", day: "numeric", weekday: "short", timeZone: "Asia/Tokyo"}).format(new Date(`${state.today}T12:00:00+09:00`));
  $("#stat-progress").textContent = s ? s.base_done : 0;
  $("#stat-total").textContent = `/ ${s ? s.total : 100} 問`;
  $("#stat-bar").style.width = `${s ? s.base_done / s.total * 100 : 0}%`;
  $("#stat-due").textContent = state.due;
  $("#stat-retry").textContent = s ? s.retry_remaining : 0;
  $("#session-label").textContent = s ? `${levelNames[s.level]} · ${s.day}${s.early_reviews ? ` · 先取り復習 ${s.early_reviews}語` : ""}` : "英単語 → 日本語";
  $("#level").value = state.level;
  $("#study-mode").value = state.study_mode || "auto";
  $("#level-count").textContent = `登録済み ${state.counts[state.level]} 語${!state.ai_enabled ? " · ローカル採点" : ""}`;
  $("#fill").disabled = state.job.running;
  $("#fill").textContent = state.job.running ? "単語を準備しています…" : state.counts[state.level] < 100 ? "＋ 100語まで自動補充" : "＋ 新しい20語を補充";
  $("#ai-label").textContent = state.ai_enabled ? "AI設定あり" : "外部APIなし · 保存教材で学習";
  $("#ai-dot").classList.toggle("offline", !state.ai_enabled);
  $("#job").hidden = !state.job.message && !state.job.error;
  $("#job").textContent = state.job.error || state.job.message;
  renderStudy();
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const previousCount = `${state?.total_words}:${state?.pending_words}`;
    state = await api("state");
    render();
    if (page === "library" && previousCount !== `${state.total_words}:${state.pending_words}`) await loadLibrary();
  } finally { refreshing = false; }
}

async function loadLibrary() {
  words = await api("words");
  renderLibrary();
}

function renderLibrary() {
  const query = $("#search").value.trim().toLowerCase();
  const level = $("#library-level").value;
  const stage = $("#proficiency-filter").value;
  const filtered = words.filter(w => (level === "all" || w.level === level) && `${w.data.word} ${w.data.meaning} ${w.data.aliases.join(" ")}`.toLowerCase().includes(query)
    && (stage === "all" || (stage === "receptive" ? w.proficiency?.receptive_only : w.proficiency?.stage === Number(stage))));
  $("#library-count").textContent = `${filtered.length}語を表示 / 全${words.length}語（補完待ち ${words.filter(w => w.pending).length}語） · 記憶の目安は推定です`;
  $("#word-list").innerHTML = filtered.length ? filtered.map(w => `<details class="word-entry" data-id="${escapeHTML(w.id)}"><summary><strong lang="en">${escapeHTML(w.data.word)}</strong><span class="pill">${escapeHTML(w.data.pos || "品詞未設定")}</span><span class="gloss">${escapeHTML(w.data.meaning || "意味未設定")}</span>${w.proficiency ? `<span class="pill ${w.proficiency.receptive_only ? "receptive-notice" : ""}">${escapeHTML(w.proficiency.label)}${w.proficiency.receptive_only ? " · 想起が苦手" : ""}</span>` : ""}</summary><p class="word-meta">${levelNames[w.level]} · ${escapeHTML(w.source)} · ${w.pending ? "補完するまで出題されません" : `次回復習：${escapeHTML(w.due || "未学習")}`}${w.retention !== null ? ` · 記憶の目安 ${w.retention}%` : ""}</p>${proficiencyHTML(w.proficiency)}${notesHTML(w.data, w.id)}${false && (w.pending || !w.data.example || !w.data.translation || !w.data.synonyms.length || !w.data.forms.length) ? `<button class="button secondary csv-complete" data-id="${escapeHTML(w.id)}">AIで意味・解説を補完</button><p class="small muted">APIキーが必要です。CSVにある内容を保持して不足分を生成します。</p>` : ""}</details>`).join("") : '<div class="empty">一致する単語はありません。</div>';
}

$("#proficiency-filter").addEventListener("change", renderLibrary);
$("#study-mode").addEventListener("change", async event => {
  try {
    const result = await api("study-mode", {mode: event.target.value});
    tell(result.message);
    await refresh();
  } catch (error) { tell(error.message, true); if (state) $("#study-mode").value = state.study_mode; }
});

$("#word-list").addEventListener("toggle", event => {
  if (event.target.matches(".word-entry[open]")) {
    api("exposure", {id: event.target.dataset.id}).catch(error => tell(error.message, true));
  }
}, true);

$("#word-list").addEventListener("click", event => {
  const button = event.target.closest(".csv-complete");
  if (!button) return;
  busy(button, async () => {
    const result = await api("csv/complete", {id: button.dataset.id});
    tell(result.message);
    await refresh();
    await loadLibrary();
  }, "解説を補完中…");
});

function clearCSVPreview() {
  csvPayload = null;
  $("#csv-import").disabled = true;
  $("#csv-import").hidden = true;
  $("#csv-preview").hidden = true;
  $("#csv-result").textContent = "";
}
$("#csv-form").addEventListener("change", clearCSVPreview);
$("#csv-form").addEventListener("submit", event => {
  event.preventDefault();
  busy(event.target.querySelector("button"), async () => {
    clearCSVPreview();
    const file = $("#csv-file").files[0];
    if (!file || !file.size || file.size > 64 * 1024 * 1024) throw new Error("空でない64MB以下のCSVファイルを選んでください。");
    const level = $("#csv-level").value;
    const encoding = $("#csv-encoding").value;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    const payload = {file: btoa(binary), level, encoding};
    const result = await api("csv/preview", payload);
    // File/controls may have changed while the request was in flight.
    if ($("#csv-file").files[0] !== file || $("#csv-level").value !== level || $("#csv-encoding").value !== encoding) return;
    $("#csv-preview").hidden = false;
    if (!result.valid) {
      $("#csv-preview").innerHTML = `<p class="small">${escapeHTML(result.message)}（${result.error_count}件）</p><ul>${result.errors.map(e => `<li>${e.line}行目：${escapeHTML(e.error)}</li>`).join("")}</ul>`;
      return;
    }
    const status = {added: "学習用として保存", pending: "補完待ちとして保存", skipped: "重複・スキップ"};
    $("#csv-preview").innerHTML = `<p class="small">${escapeHTML(result.message)}</p><div class="csv-table"><table><thead><tr><th>行</th><th>英単語</th><th>意味</th><th>品詞</th><th>処理</th></tr></thead><tbody>${result.rows.map(r => `<tr><td>${r.line}</td><td>${escapeHTML(r.word)}</td><td>${escapeHTML(r.meaning || "未設定")}</td><td>${escapeHTML(r.pos || "未設定")}</td><td>${status[r.status]}</td></tr>`).join("")}</tbody></table></div><p class="small muted">全${result.total}行のうち先頭20行までを表示。保存後、次に開始する学習に反映されます。AI処理は自動では実行しません。</p>`;
    csvPayload = payload;
    $("#csv-import").hidden = false;
    $("#csv-import").disabled = false;
  }, "確認中…");
});
$("#csv-import").addEventListener("click", event => busy(event.currentTarget, async () => {
  if (!csvPayload) throw new Error("先に取り込み内容を確認してください。");
  const payload = csvPayload;
  const result = await api("csv/import", payload);
  clearCSVPreview();
  $("#csv-result").textContent = result.message;
  await refresh();
  await loadLibrary();
}, "保存中…"));

async function showPage(name) {
  if (!["learn", "library", "settings"].includes(name)) return;
  page = name;
  document.querySelectorAll(".page").forEach(el => { el.hidden = el.id !== `page-${name}`; });
  document.querySelectorAll(".nav").forEach(el => { el.classList.toggle("active", el.dataset.page === name); });
  if (name === "library") {
    try { await loadLibrary(); }
    catch (error) { tell(error.message, true); }
  }
}

document.querySelectorAll("[data-page]").forEach(button => button.addEventListener("click", () => showPage(button.dataset.page)));
$("#search").addEventListener("input", renderLibrary);
$("#library-level").addEventListener("change", renderLibrary);
$("#level").addEventListener("change", async event => {
  const level = event.target.value;
  try {
    const result = await api("level", {level});
    tell(result.message);
    await refresh();
  } catch (error) { tell(error.message, true); }
});
$("#fill").addEventListener("click", event => busy(event.currentTarget, async () => {
  if (!state.ai_enabled) { await showPage("settings"); tell("単語の自動補充にはAPIキーを設定してください。"); return; }
  const result = await api("level", {level: state.level, fill: state.counts[state.level] >= 100});
  tell(result.message);
  await refresh();
}));
$("#add-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (adding) return;
  adding = true;
  const button = event.target.querySelector("button");
  await busy(button, async () => {
    $("#add-result").textContent = "単語と解説を準備しています。少しお待ちください。";
    try {
      const result = await api("add", {word: $("#new-word").value, level: state.level});
      $("#add-result").textContent = result.message;
      $("#new-word").value = "";
      await refresh();
    } catch (error) { $("#add-result").textContent = ""; throw error; }
  }, "…");
  adding = false;
});
$("#export").addEventListener("click", event => busy(event.currentTarget, async () => {
  const data = await api("export");
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: "application/json"}));
  const a = document.createElement("a");
  a.href = url;
  a.download = `kotonoha-${state.today}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}));

async function bootstrap() {
  signedIn = true;
  $("#auth-screen").hidden = true;
  $(".shell").hidden = false;
  $("#account-name").textContent = "ログイン不要・端末内保存";
  await refresh();
}
document.addEventListener("DOMContentLoaded", () => bootstrap().catch(error => {
  $("#auth-screen").hidden = false;
  $("#auth-message").textContent = error.message;
}));
setInterval(() => { if (signedIn && !document.hidden) refresh().catch(error => tell(error.message, true)); }, 5000);
