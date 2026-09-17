"use strict";
// The portable edition uses the same backup tables and visible UI as the Python edition.
// All learning operations are synchronous inside one IndexedDB read/write transaction.
(() => {
  const tables = ["settings", "words", "sessions", "grade_cache", "csv_pending", "pronunciations", "exposures", "preferences", "assessments", "dictionary_cache"];
  const levels = {basic: "初級", standard: "中級", advanced: "上級"};
  const pos = ["名詞", "動詞", "形容詞", "副詞", "前置詞", "接続詞", "代名詞", "間投詞"];
  const stages = ["未習得", "見れば分かる", "意味を理解している", "自分で英単語を思い出せる", "例文の中で使える", "習得済み"];
  const modes = {en_ja: "英語 → 日本語", ja_en: "日本語 → 英語", usage: "例文を作る"};
  const intervals = [1, 3, 7, 14, 30, 60, 120, 240, 365];
  const clone = value => JSON.parse(JSON.stringify(value));
  const date = () => new Intl.DateTimeFormat("sv-SE", {timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date());
  const norm = value => value.normalize("NFKC").toLowerCase().replace(/[\s、。,.！!？?・]+/g, "").trim();
  const english = value => value.normalize("NFKC").replace(/’/g, "'").toLowerCase().replace(/\s+/g, " ").replace(/^[ .!?]+|[ .!?]+$/g, "");
  const after = (day, days) => new Date(Date.parse(day + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
  const wordData = row => JSON.parse(row.data);
  const fail = message => { throw new Error(message); };
  function validWord(w, draft = false) {
    for (const key of ["nuance", "mnemonic"]) if (w && key in w && (typeof w[key] !== "string" || w[key].length > 2000)) fail("ニュアンス・覚え方は2000文字以下の文字列です。");
    if (!w || !/^[a-zA-Z][a-zA-Z '\-]{0,79}$/.test(w.word) || (!draft && !pos.includes(w.pos))) fail("単語・品詞の形式が不正です。");
    for (const key of ["meaning", "example", "translation"]) if (typeof w[key] !== "string" || w[key].length > 2000 || (!draft && key === "meaning" && !w[key].trim())) fail("意味・例文の形式が不正です。");
    if (!Array.isArray(w.aliases) || !w.aliases.every(a => typeof a === "string" && a.length > 0 && a.length < 200)) fail("別解の形式が不正です。");
    for (const [key, fields] of [["synonyms", ["word", "difference", "example", "translation"]], ["forms", ["word", "description"]], ["collocations", ["phrase", "meaning", "example", "translation"]]]) {
      if (!Array.isArray(w[key]) || w[key].length > 10 || !w[key].every(item => item && fields.every(f => typeof item[f] === "string" && item[f].trim() && item[f].length <= 2000))) fail("解説の形式が不正です。");
    }
  }
  function validate(b) {
    if (!b || b.format !== "kotonoha-backup" || b.schemaVersion !== 1 || typeof b.appVersion !== "string" || typeof b.exportedAt !== "string" || !b.tables || Object.keys(b.tables).sort().join() !== tables.slice().sort().join()) fail("対応する完全バックアップではありません（schemaVersion 1が必要です）。");
    const t = b.tables;
    for (const name of tables) if (!Array.isArray(t[name]) || t[name].length > 200000 || !t[name].every(r => r && typeof r === "object" && !Array.isArray(r))) fail("バックアップの表が不正です。");
    const ids = new Set();
    for (const row of t.words) {
      validWord(wordData(row));
      if (!/^[a-f0-9]{20}$/.test(row.id) || ids.has(row.id) || !Object.hasOwn(levels, row.level)) fail("単語ID・難易度が不正です。");
      ids.add(row.id);
      for (const k of ["streak", "interval", "lapses"]) if (!Number.isInteger(row[k]) || row[k] < 0) fail("学習回数が不正です。");
      for (const k of ["due", "last_seen"]) if (row[k] !== null && !/^\d{4}-\d\d-\d\d$/.test(row[k])) fail("復習日が不正です。");
    }
    for (const row of t.csv_pending) validWord(wordData(row), true);
    if (t.settings.length !== 1 || t.settings[0].id !== 1 || !Object.hasOwn(levels, t.settings[0].level)) fail("設定が不正です。");
    if (!t.preferences.some(r => r.key === "study_mode" && ["auto", ...Object.keys(modes)].includes(r.value))) fail("出題設定が不足しています。");
    for (const row of t.sessions) {
      const s = wordData(row);
      if (s.day !== row.day || s.level !== row.level || !Object.hasOwn(levels, s.level)) fail("学習セットの形式が不正です。");
      for (const key of ["base", "queue", "failed", "mastered"]) if (!Array.isArray(s[key]) || !s[key].every(id => ids.has(id))) fail("未完了問題の参照が不正です。");
      for (const key of ["cursor", "first_correct", "early_reviews"]) if (!Number.isInteger(s[key]) || s[key] < 0) fail("進捗が不正です。");
      if (s.cursor > s.queue.length || s.base.length > s.queue.length || new Set(s.base).size !== s.base.length) fail("問題数が不正です。");
      if (s.feedback) { if (typeof s.feedback.token !== "string") fail("回答情報が不正です。"); validWord(s.feedback.word); }
      if (s.typo_check && typeof s.typo_check.token !== "string") fail("入力ミス確認が不正です。");
      if (s.modes && (typeof s.modes !== "object" || Array.isArray(s.modes) || Object.values(s.modes).some(v => !Object.hasOwn(modes, v)))) fail("出題形式が不正です。");
    }
    for (const r of t.assessments) if (!ids.has(r.word_id) || !Object.hasOwn(modes, r.mode) || ![0, 1].includes(r.correct) || ![0, 1].includes(r.first_attempt)) fail("回答履歴が不正です。");
    for (const name of ["pronunciations", "dictionary_cache", "grade_cache"]) for (const row of t[name]) if (!wordData(row) || Array.isArray(wordData(row))) fail("キャッシュが不正です。");
    for (const row of t.pronunciations) if (row.audio && (typeof row.audio.base64 !== "string" || !["audio/mpeg", "audio/ogg", "audio/wav"].includes(row.mime))) fail("音声データが不正です。");
    return b;
  }
  function obvious(answer, accepted) {
    const a = norm(answer);
    if (a.length < 4 || /ない|なく|ません|ぬ|ず|不|非|未|無|\bnot\b/i.test(a)) return false;
    return accepted.some(value => {
      const b = norm(value);
      if (b.length < 3 || /ない|なく|ません|ぬ|ず|不|非|未|無/.test(b)) return false;
      if (a.length === b.length + 1) for (let i = 1; i < a.length; i++) if (a[i] === a[i-1] && /^[a-zぁ-ゖァ-ヺー]$/.test(a[i]) && a.slice(0, i) + a.slice(i+1) === b) return true;
      if (a.length === b.length) for (let i = 0; i < a.length-1; i++) if (a[i] !== a[i+1] && /^[a-zぁ-ゖァ-ヺー]{2}$/.test(a.slice(i,i+2)) && a.slice(0, i) + a[i+1] + a[i] + a.slice(i+2) === b) return true;
      return false;
    });
  }
  class Engine {
    constructor(backup, day = date()) { this.b = backup; this.t = backup.tables; this.day = day; }
    pref(key, fallback = "") { return this.t.preferences.find(r => r.key === key)?.value ?? fallback; }
    setPref(key, value) { const r = this.t.preferences.find(r => r.key === key); if (r) r.value = value; else this.t.preferences.push({key, value}); }
    active() { return this.t.sessions.slice().sort((a,b) => a.day.localeCompare(b.day)).map(wordData).find(s => s.cursor < s.queue.length || s.feedback || s.day === this.day); }
    save(s) { const r = this.t.sessions.find(r => r.day === s.day); if (r) r.data = JSON.stringify(s); else this.t.sessions.push({day: s.day, level: s.level, data: JSON.stringify(s)}); }
    token(s, cursor = s.cursor) { return `${s.day}:${cursor}` + (this.pref("restore_nonce") ? `:${this.pref("restore_nonce")}` : ""); }
    profile(id) {
      const rows = this.t.assessments.filter(r => r.word_id === id && r.first_attempt).sort((a,b) => a.id-b.id), evidence = {};
      for (const [mode,label] of Object.entries(modes)) {
        const seen = new Set(), good = new Set(); let streak = 0, latest = null;
        for (const r of rows) if (r.mode === mode && !seen.has(r.day)) { seen.add(r.day); latest = r; if (r.correct) { good.add(r.day); streak++; } else streak = 0; }
        evidence[mode] = {label, correct: latest ? Boolean(latest.correct) : null, last_day: latest?.day ?? null, success_days: good.size, streak, tested: seen.size};
      }
      const r=evidence.en_ja, j=evidence.ja_en, u=evidence.usage; let stage=0;
      if (r.correct) { stage=r.success_days>=2 ? 2 : 1; if (j.correct) { stage=u.correct ? 4 : 3; if (u.correct && Date.parse(rows.at(-1).day)-Date.parse(rows[0].day)>=7*86400000 && Object.values(evidence).every(e=>e.streak>=2 && e.success_days>=2)) stage=5; } }
      const receptive_only = r.correct === true && j.correct === false;
      return {stage,label:stages[stage],receptive_only,message:receptive_only ? "理解語彙だが、まだ使用語彙ではない" : "",evidence,unassessed:!rows.length};
    }
    choose(id) { const e=this.profile(id).evidence; if (!e.en_ja.correct) return "en_ja"; if (!e.ja_en.correct) return "ja_en"; return (e.en_ja.last_day || "") <= (e.ja_en.last_day || "") ? "en_ja" : "ja_en"; }
    expose(w,s) {
      for (const name of new Set([...w.synonyms,...w.forms].map(r=>r.word.toLowerCase().trim()).filter(n=>/^[a-z][a-z '\-]{0,79}$/.test(n) && n!==w.word))) {
        const r=this.t.exposures.find(r=>r.word===name); if(r) r.seen_day=this.day; else this.t.exposures.push({word:name,seen_day:this.day});
        if(s) { s.related_until ??= {}; s.related_until[name]=Math.max(s.related_until[name]||0,s.cursor+10); }
      }
    }
    space(s) {
      const names=Object.fromEntries(this.t.words.map(r=>[r.id,wordData(r).word]));
      const reorder=(list,start)=>{const out=[];while(list.length){let i=list.findIndex(id=>(s.related_until?.[names[id]]||0)<=start+out.length);if(i<0)i=list.reduce((best,id,n)=>(s.related_until?.[names[id]]||0)<(s.related_until?.[names[list[best]]]||0)?n:best,0);out.push(list.splice(i,1)[0]);}return out;};
      const boundary=Math.max(s.cursor,s.base.length);
      s.queue=[...s.queue.slice(0,s.cursor),...reorder(s.queue.slice(s.cursor,boundary),s.cursor),...reorder(s.queue.slice(boundary),boundary)];
    }
    state() {
      const level=this.t.settings[0].level, counts=Object.fromEntries(Object.keys(levels).map(l=>[l,this.t.words.filter(r=>r.level===l).length]));
      const s=this.active();let view=null;
      if(s){view={day:s.day,level:s.level,first_correct:s.first_correct,feedback:s.feedback,early_reviews:s.early_reviews,typo_check:s.typo_check||null,total:s.base.length,base_done:Math.min(s.cursor,s.base.length),attempts:s.cursor,retry_remaining:s.failed.filter(id=>!s.mastered.includes(id)).length,mastered:s.mastered.length,done:s.cursor>=s.queue.length,retry:s.cursor>=s.base.length,question:null};
        if(!view.done&&!s.feedback){const row=this.t.words.find(r=>r.id===s.queue[s.cursor]),w=wordData(row),mode=s.modes?.[row.id]||"en_ja";view.question={word:mode!=="ja_en"?w.word:"",example:mode==="en_ja"?w.example:"",meaning:mode!=="en_ja"?w.meaning:"",mode,id:row.id,pos:mode!=="en_ja"?w.pos:"",letter_count:w.word.length,token:this.token(s)};}}
      return {today:this.day,level,levels,pos,counts,due:this.t.words.filter(r=>r.level===level&&r.due&&r.due<=this.day).length,studied:this.t.words.filter(r=>r.last_seen).length,total_words:this.t.words.length,pending_words:this.t.csv_pending.length,stages,modes,study_mode:this.pref("study_mode","auto"),ai_enabled:false,model:"",job:{running:false,message:"",added:0,error:""},session:view};
    }
    start() {
      if(this.active())return {message:"学習を再開します。"};
      const level=this.t.settings[0].level,seen=new Set(this.t.exposures.filter(r=>r.seen_day===this.day).map(r=>r.word));
      const rank=r=>r.due&&r.due<=this.day?0:!r.due?1:2;
      const rows=this.t.words.filter(r=>r.level===level).sort((a,b)=>Number(seen.has(wordData(a).word))-Number(seen.has(wordData(b).word))||rank(a)-rank(b)||(a.due||"").localeCompare(b.due||"")||a.id.localeCompare(b.id)).slice(0,100);
      if(!rows.length)fail("この難易度の教材がありません。教材またはバックアップを取り込んでください。");
      const base=rows.map(r=>r.id),mode=this.pref("study_mode","auto");
      this.save({day:this.day,level,base,queue:base.slice(),cursor:0,failed:[],mastered:[],first_correct:0,feedback:null,early_reviews:rows.filter(r=>r.due>this.day).length,related_until:Object.fromEntries([...seen].map(w=>[w,10])),modes:Object.fromEntries(base.map(id=>[id,mode==="auto"?this.choose(id):mode]))});return {message:"学習を開始しました。"};
    }
    answer(data) {
      const s=this.active();if(!s)fail("先に学習を開始してください。");
      if(s.feedback){if(s.feedback.token===data.token)return s.feedback;fail("解説を確認して次へ進んでください。");}
      if(data.token!==this.token(s)||s.cursor>=s.queue.length)fail("問題が更新されています。画面を再読み込みしてください。");
      const row=this.t.words.find(r=>r.id===s.queue[s.cursor]),w=wordData(row),mode=s.modes?.[row.id]||"en_ja",pending=s.typo_check,action=data.typo_action;
      data={...data,pos:data.pos ?? pending?.pos ?? w.pos};
      if(action&&!['correct','wrong'].includes(action))fail("確認方法が不正です。");
      if(pending&&!action)return pending;if(action&&!pending)fail("入力ミスの確認はありません。");if(pending&&data.pos!==pending.pos)fail("訂正では品詞を変更できません。");
      let answer=String(data.answer||"").trim();if(action==="wrong")answer=pending.answer;
      if(!data.skip&&(!answer||answer.length>300||!pos.includes(data.pos)))fail("品詞と300文字以内の回答を入力してください。");
      const accepted=mode==="ja_en"?[w.word]:[w.meaning,...w.aliases];
      let correct=!data.skip&&data.pos===w.pos&&accepted.some(a=>(mode==="ja_en"?english(a)===english(answer):norm(a)===norm(answer)));
      if(mode==="usage")fail("自由な例文の自動採点は利用できません。");
      if(action==="wrong")correct=false;
      if(!correct&&!data.skip&&data.pos===w.pos&&!pending&&obvious(answer,accepted)){s.typo_check={needs_confirmation:true,token:data.token,answer,pos:data.pos,message:"これはスペルミス・変換ミスなどの入力ミスですか？一度だけ訂正できます。"};this.save(s);return s.typo_check;}
      s.typo_check=null;
      s.answer_undo={day:this.day,cursor:s.cursor,queue:s.queue.slice(),failed:s.failed.slice(),mastered:s.mastered.slice(),first_correct:s.first_correct,
        progress:Object.fromEntries(["streak","interval","due","last_seen","lapses"].map(k=>[k,row[k]]))};
      const next_due=this.applyOutcome(s,row,correct,this.day,s.cursor);
      const first=s.cursor<s.base.length&&!this.t.assessments.some(r=>r.word_id===row.id&&r.mode===mode&&r.day===this.day&&r.first_attempt);
      this.t.assessments.push({id:this.t.assessments.reduce((n,r)=>Math.max(n,r.id),0)+1,word_id:row.id,mode,day:this.day,correct:Number(correct),first_attempt:Number(first),answer,session_day:s.day,cursor:s.cursor});
      s.answer_undo.assessment_id=this.t.assessments.at(-1).id;
      s.cursor++;this.expose(w,s);
      s.feedback={correct,reason:correct?"登録済みの回答と一致しました。":data.pos!==w.pos?"品詞が違います。":"登録済みの意味・別解とは一致しませんでした。",method:"端末内採点",next_due,token:data.token,word:w,word_id:row.id,mode,proficiency:this.profile(row.id),answer,selected_pos:data.pos||"",source:row.source,can_override:true,revision:0};
      if(pending)s.feedback.original_answer=pending.answer;this.save(s);return s.feedback;
    }
    applyOutcome(s,row,correct,day,cursor) {
      if(correct){if(!s.mastered.includes(row.id))s.mastered.push(row.id);if(cursor<s.base.length)s.first_correct++;row.streak=s.failed.includes(row.id)?1:Math.min(row.streak+1,intervals.length);row.interval=intervals[row.streak-1];row.due=after(day,row.interval);row.last_seen=day;return row.due;}
      s.queue.push(row.id);if(!s.failed.includes(row.id)){s.failed.push(row.id);row.streak=0;row.interval=1;row.due=after(day,1);row.last_seen=day;row.lapses++;}
      return "この学習の後半で再出題・翌日にも復習";
    }
    override(data) {
      const s=this.active(),f=s?.feedback,u=s?.answer_undo;
      if(data.confirm!==true||typeof data.correct!=="boolean")fail("判定変更の確認が必要です。");
      if(!f||f.token!==data.token||data.revision!==f.revision)fail("回答が更新されています。画面を確認してください。");
      if(!u||!f.can_override)fail("旧版で採点した回答は変更できません。次の回答から利用できます。");
      const row=this.t.words.find(r=>r.id===f.word_id),a=this.t.assessments.find(r=>r.id===u.assessment_id);
      const ids=new Set(this.t.words.map(r=>r.id));
      if(!row||!a||a.word_id!==row.id||a.session_day!==s.day||a.cursor!==s.cursor-1||u.cursor!==s.cursor-1||u.day!==a.day||!/^\d{4}-\d\d-\d\d$/.test(u.day))fail("変更元の回答記録を確認できません。");
      if(!["queue","failed","mastered"].every(k=>Array.isArray(u[k])&&u[k].every(id=>ids.has(id)))||u.queue[u.cursor]!==row.id||!Number.isInteger(u.first_correct)||u.first_correct<0||u.first_correct>s.base.length)fail("変更元の進捗が不正です。");
      const p=u.progress;if(!p||!["streak","interval","lapses"].every(k=>Number.isInteger(p[k])&&p[k]>=0)||!["due","last_seen"].every(k=>p[k]===null||/^\d{4}-\d\d-\d\d$/.test(p[k])))fail("変更元の復習情報が不正です。");
      if(f.correct===data.correct)return f;
      for(const k of ["streak","interval","due","last_seen","lapses"])row[k]=p[k];
      for(const k of ["queue","failed","mastered"])s[k]=u[k].slice();s.first_correct=u.first_correct;
      f.next_due=this.applyOutcome(s,row,data.correct,u.day,u.cursor);a.correct=Number(data.correct);
      f.original_correct ??= f.correct;f.correct=data.correct;f.revision++;f.method="手動で判定を変更";f.reason="確認のうえ判定を変更しました。学習履歴・復習予定にも反映しています。";f.proficiency=this.profile(row.id);
      this.save(s);return f;
    }
    manage(path,data) {
      const all=path==="data/clear",reset=path==="data/reset-history";
      if(data.confirm!==(all?"DELETE ALL":reset?"RESET HISTORY":"DELETE WORD"))fail("削除・リセットの確認が必要です。");
      if(all){for(const k of tables)this.t[k]=[];this.t.settings=[{id:1,level:"basic"}];this.t.preferences=[{key:"study_mode",value:"auto"}];}
      else if(reset){for(const k of ["sessions","assessments","exposures","grade_cache"])this.t[k]=[];for(const r of this.t.words)Object.assign(r,{streak:0,interval:0,due:null,last_seen:null,lapses:0});}
      else {
        const target=[...this.t.words,...this.t.csv_pending].find(r=>r.id===data.id);if(!target)fail("削除対象の単語がありません。");
        const active=this.active();if(data.token&&data.token!==(active?.feedback?.token|| (active?this.token(active):null)))fail("問題が更新されています。再確認してください。");
        const name=wordData(target).word;
        this.t.words=this.t.words.filter(r=>r.id!==data.id);this.t.csv_pending=this.t.csv_pending.filter(r=>r.id!==data.id);this.t.assessments=this.t.assessments.filter(r=>r.word_id!==data.id);this.t.grade_cache=[];
        this.t.sessions=this.t.sessions.filter(r=>{
          const s=wordData(r),old=s.queue.slice(),shift=n=>old.slice(0,n).filter(id=>id!==data.id).length;
          for(const a of this.t.assessments)if(a.session_day===s.day)a.cursor=shift(a.cursor);
          s.cursor=shift(s.cursor);for(const k of ["base","queue","failed","mastered"])s[k]=s[k].filter(id=>id!==data.id);
          s.first_correct=this.t.assessments.filter(a=>a.session_day===s.day&&a.cursor<s.base.length&&a.correct).length;
          if(s.feedback?.word_id===data.id)s.feedback=null;else if(s.feedback)s.feedback.can_override=false;
          if(old[JSON.parse(r.data).cursor]===data.id)s.typo_check=null;
          delete s.answer_undo;if(s.modes)delete s.modes[data.id];r.data=JSON.stringify(s);return s.base.length>0;
        });
        const referenced=[...this.t.words,...this.t.csv_pending].some(r=>{const w=wordData(r);return [w.word,...w.synonyms.map(x=>x.word),...w.forms.map(x=>x.word)].includes(name);});
        if(!referenced)for(const k of ["pronunciations","dictionary_cache","exposures"])this.t[k]=this.t[k].filter(r=>r.word!==name);
      }
      this.setPref("restore_nonce",Date.now().toString(36)+Math.random().toString(36).slice(2));
      for(const r of this.t.sessions){const s=wordData(r);if(s.feedback)s.feedback.token=this.token(s,s.cursor-1);if(s.typo_check)s.typo_check.token=this.token(s);this.save(s);}
      return {message:all?"単語・履歴・保存音声などをすべて削除しました。":reset?"教材・辞書情報は残し、学習履歴と復習予定をリセットしました。":"単語とその学習履歴を削除しました。"};
    }
    route(path,data={}) {
      if(path==="data/clear"||path==="data/reset-history"||path==="word/delete")return this.manage(path,data);
      if(path==="state")return this.state();
      if(path==="start")return this.start();
      if(path==="answer")return this.answer(data);
      if(path==="answer/override")return this.override(data);
      if(path==="next"){const s=this.active();if(s?.feedback?.token===data.token){s.feedback=null;delete s.answer_undo;this.space(s);this.save(s);}return {ok:true};}
      if(path==="words")return [...this.t.words.map(r=>({...r,data:wordData(r),retention:r.last_seen?Math.round(100*Math.exp(Math.log(.9)*Math.max(0,(Date.parse(this.day)-Date.parse(r.last_seen))/86400000)/Math.max(1,r.interval))):null,proficiency:this.profile(r.id)})),...this.t.csv_pending.map(r=>({...r,data:wordData(r),pending:true,source:"CSV・補完待ち",due:null,retention:null}))];
      if(path==="level"){if(!Object.hasOwn(levels,data.level))fail("難易度が不正です。");this.t.settings[0].level=data.level;return {message:"保存済み教材から難易度を選びました。"};}
      if(path==="study-mode"){if(!["auto","en_ja","ja_en"].includes(data.mode))fail("この出題形式は利用できません。");this.setPref("study_mode",data.mode);return {message:"次の学習から出題形式を変更します。"};}
      if(path==="exposure"){const r=[...this.t.words,...this.t.csv_pending].find(r=>r.id===data.id);if(!r)fail("単語がありません。");const s=this.active();this.expose(wordData(r),s);if(s)this.save(s);return {ok:true};}
      if(path==="pronunciation"){const r=this.t.pronunciations.find(r=>r.word===data.word);if(!r)fail("登録された単語ではありません。");return {...wordData(r),word:r.word,audio_data:r.audio?`data:${r.mime};base64,${r.audio.base64}`:null,message:r.audio?"保存済みの音声です。":"音声なし。端末内TTSまたは発音記号をご利用ください。"};}
      if(path==="dictionary"){const r=this.t.dictionary_cache.find(r=>r.word===data.word);return r?wordData(r):{word:data.word,status:"unavailable",message:"保存済み辞書情報はありません。オンラインで無料辞書の取得を試してください。",meanings:[],synonyms:[],antonyms:[],phonetics:[],sources:[],licenses:[]};}
      if(path==="backup"||path==="export"){this.b.exportedAt=new Date().toISOString();return clone(this.b);}
      fail("この端末版では未対応の操作です。PC版で教材を取り込み、完全バックアップで移行してください。");
    }
  }
  function empty() { if (globalThis.KotonohaSeed) { const b=clone(globalThis.KotonohaSeed); b.tables.preferences.push({key:"library_id",value:crypto.randomUUID()}); return b; } return {format:"kotonoha-backup",schemaVersion:1,appVersion:"2.0.0",exportedAt:new Date().toISOString(),tables:{...Object.fromEntries(tables.map(t=>[t,[]])),settings:[{id:1,level:"basic"}],preferences:[{key:"study_mode",value:"auto"}]}}; }
  let database;
  function open() { return database??=(new Promise((resolve,reject)=>{if(!globalThis.indexedDB)return reject(new Error("このブラウザで端末保存を利用できません。"));const r=indexedDB.open("kotonoha-portable:"+new URL("./",location.href).pathname,1);r.onupgradeneeded=()=>r.result.createObjectStore("state");r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);})); }
  async function transaction(action) {
    const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction("state","readwrite"),store=tx.objectStore("state"),r=store.get("current");let output;
      r.onsuccess=()=>{try{const state=r.result||{backup:empty(),recovery:null};output=action(state);store.put(state,"current");}catch(e){reject(e);tx.abort();}};
      tx.oncomplete=()=>resolve(output);tx.onerror=()=>reject(new Error("端末に保存できません。空き容量やブラウザの保存設定を確認してください。"));tx.onabort=()=>reject(new Error("変更は保存されませんでした。"));});
  }
  async function api(path,data={}) {
    if(path==="dictionary")return KotonohaDictionary.lookup(data);
    if(["csv/preview","csv/import","materials/preview","materials/import"].includes(path))return transaction(await KotonohaMaterials.prepare(path,data));
    if(path==="auth/me")return {user:{name:"この端末の単語帳",id:"local"},setup_required:false};
    if(path==="auth/logout")fail("端末版にはアカウントログインはありません。共有端末ではブラウザを閉じ、端末のロックを使用してください。");
    let parsed;
    if(path.startsWith("backup/")&&path!=="backup/recovery"){
      if(typeof data.file!=="string"||data.file.length>90*1024*1024)fail("64MB以下のバックアップを選んでください。");
      parsed=validate(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Uint8Array.from(atob(data.file),c=>c.charCodeAt(0)))));
    }
    return transaction(state=>{
      if(path==="backup/recovery"){if(!state.recovery)fail("復元前バックアップはありません。");return clone(state.recovery);}
      if(parsed){const result={words:parsed.tables.words.length,sessions:parsed.tables.sessions.length,history:parsed.tables.assessments.length,exportedAt:parsed.exportedAt};if(path==="backup/preview")return result;
        if(path!=="backup/restore"||data.confirm!=="REPLACE")fail("置き換えの確認が必要です。");state.recovery=state.backup;state.backup=parsed;
        const e=new Engine(parsed);e.setPref("restore_nonce",Date.now().toString(36)+Math.random().toString(36).slice(2));if(e.pref("study_mode")==="usage")e.setPref("study_mode","auto");
        for(const row of e.t.sessions){const s=wordData(row);if(s.cursor<s.queue.length)s.modes=Object.fromEntries(Object.entries(s.modes||{}).map(([k,v])=>[k,v==="usage"?"ja_en":v]));if(s.typo_check)s.typo_check.token=e.token(s);if(s.feedback)s.feedback.token=e.token(s,s.cursor-1);e.save(s);}return result;}
      const result=new Engine(state.backup).route(path,data);
      if(["data/clear","data/reset-history","word/delete"].includes(path))state.recovery=null;
      return result;
    });
  }
  globalThis.KotonohaLocal={api,Engine,validate,validWord,empty,transaction};
})();
