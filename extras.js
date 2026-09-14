"use strict";
// Shared by the server and portable editions. No paid services or remote TTS voices.
let backupPayload = null;
let preparedBackup = null;
function saveDownload(blob, name) {
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = () => reject(new Error("ファイルを読めません。"));
    reader.readAsDataURL(file);
  });
}
$("#backup-download").addEventListener("click", event => busy(event.currentTarget, async () => {
  const result = await api("backup");
  preparedBackup = new File([JSON.stringify(result)], "english-vocabulary-backup.json", {type: "application/json"});
  saveDownload(preparedBackup, preparedBackup.name);
  tell("完全バックアップを書き出しました。共有ボタンから他端末へ送ることもできます。");
}));
$("#backup-share").addEventListener("click", async () => {
  if (!preparedBackup) return tell("先にバックアップを書き出してください。", true);
  try {
    if (navigator.canShare?.({files: [preparedBackup]})) await navigator.share({files: [preparedBackup], title: "ことのはバックアップ"});
    else { saveDownload(preparedBackup, preparedBackup.name); tell("共有非対応のためダウンロードしました。ファイルアプリなどから送ってください。"); }
  } catch (error) { if (error.name !== "AbortError") tell("共有できませんでした。保存したファイルを手動で送ってください。", true); }
});
$("#backup-recovery").addEventListener("click", event => busy(event.currentTarget, async () => {
  saveDownload(new Blob([JSON.stringify(await api("backup/recovery"))], {type: "application/json"}), "english-vocabulary-before-restore.json");
}));
$("#backup-file").addEventListener("change", () => { backupPayload = null; $("#backup-restore").hidden = true; $("#backup-preview").textContent = ""; });
$("#backup-form").addEventListener("submit", event => {
  event.preventDefault();
  busy(event.target.querySelector("button"), async () => {
    backupPayload = null; $("#backup-restore").hidden = true;
    const file = $("#backup-file").files[0];
    if (!file || file.size > 64 * 1024 * 1024) throw new Error("64MB以下の完全バックアップを選んでください。");
    const payload = {file: await fileBase64(file)};
    const info = await api("backup/preview", payload);
    if ($("#backup-file").files[0] !== file) return;
    backupPayload = payload;
    $("#backup-preview").textContent = `${info.words}語・学習セット${info.sessions}件・回答履歴${info.history}件（${info.exportedAt}）。現在の学習データ全体を置き換えます。`;
    $("#backup-restore").hidden = false;
  });
});
$("#backup-restore").addEventListener("click", event => busy(event.currentTarget, async () => {
  if (!backupPayload || !confirm("現在の単語・学習履歴・設定をバックアップの内容で置き換えます。続けますか？")) return;
  await api("backup/restore", {...backupPayload, confirm: "REPLACE"});
  location.reload();
}));

function dictionaryHTML(word) {
  return `<section class="dictionary-panel" data-word="${escapeHTML(word)}"><h3>無料辞書の英語定義・類義語・反意語</h3><button class="button secondary dictionary-fetch">辞書情報を取得・表示</button><div class="dictionary-result"><p class="small muted">ボタンを押したときだけ無料辞書へ接続します。保存済み情報は再利用します。</p></div></section>`;
}
document.addEventListener("click", event => {
  const button = event.target.closest(".dictionary-fetch");
  if (!button) return;
  const container = button.closest(".dictionary-panel");
  busy(button, async () => {
    const result = await api("dictionary", {word: container.dataset.word, retry: button.dataset.retry === "true"});
    if (!container.isConnected) return;
    container.querySelector(".dictionary-result").innerHTML = `<p class="small muted">${escapeHTML(result.message)}</p><p>${(result.phonetics || []).map(escapeHTML).join(" / ")}</p>${(result.meanings || []).map(m => `<div class="synonym"><span class="pill">${escapeHTML(m.pos)}</span><p lang="en">${escapeHTML(m.definition)}</p>${m.example ? `<p class="example" lang="en">${escapeHTML(m.example)}</p>` : ""}</div>`).join("") || "<p>定義：データなし</p>"}<h3>類義語</h3><p>${(result.synonyms || []).map(escapeHTML).join(" / ") || "データなし"}</p><h3>反意語</h3><p>${(result.antonyms || []).map(escapeHTML).join(" / ") || "データなし"}</p><p class="small">${(result.sources || []).map(url => externalLink(url, "辞書の出典")).join(" · ")} ${(result.licenses || []).map(l => externalLink(l.url, l.name) || escapeHTML(l.name)).join(" · ")}</p>`;
    if (result.status !== "cached") { button.dataset.retry = "true"; setTimeout(() => { button.textContent = "無料辞書の取得を再試行"; }, 0); }
  });
});
function localVoice() { return window.speechSynthesis?.getVoices().find(v => v.localService === true && /^en(?:[-_]|$)/i.test(v.lang)); }
function speakLocal(word, output) {
  const voice = localVoice();
  if (!voice || !window.SpeechSynthesisUtterance) { output.textContent = "端末内の英語TTSが使えません。発音記号・辞書リンクをご利用ください。"; return; }
  const speech = new SpeechSynthesisUtterance(word); speech.voice = voice; speech.lang = voice.lang; speech.rate = 0.85;
  speech.onerror = () => { output.textContent = "TTSで再生できませんでした。発音記号をご確認ください。"; };
  window.speechSynthesis.cancel(); window.speechSynthesis.speak(speech);
}
window.speechSynthesis?.getVoices();
window.speechSynthesis?.addEventListener("voiceschanged", () => localVoice());
document.addEventListener("click", event => {
  const button = event.target.closest(".tts-play");
  if (button) speakLocal(button.dataset.word, button.nextElementSibling);
});
if (portableMode && "serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("./sw.js").then(async () => {
    await navigator.serviceWorker.ready;
    tell("端末版のオフライン画面を保存しました。学習データは定期的にバックアップしてください。");
  }).catch(() => tell("オフライン画面を保存できませんでした。HTTPS接続とブラウザの設定を確認してください。", true));
} else if (portableMode) {
  tell("この接続ではオフライン用の画面保存が使えません。HTTPSまたはlocalhostで開いてください。", true);
}
