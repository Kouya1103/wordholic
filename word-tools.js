"use strict";
(() => {
  const fields = ["word","level","pos","meaning","aliases","example","translation","synonyms","forms","collocations","nuance","mnemonic"];
  const normalize = s => String(s).normalize("NFKC").trim().toLowerCase();
  function search(rows, query, language) {
    const q = normalize(query);
    if (!q) return [];
    return rows.map(([word, meaning]) => {
      const text = normalize(language === "en" ? word : meaning);
      const i = text.indexOf(q);
      return {word, meaning, score:i < 0 ? Infinity : text === q ? 0 : (language === "en" && i === 0 ? 1 : 2) + text.length / 10000};
    }).filter(r => Number.isFinite(r.score)).sort((a,b) => a.score-b.score || a.word.localeCompare(b.word)).slice(0,30);
  }
  function incomplete(w) {
    return ["pos","meaning","example","translation","synonyms","forms","collocations","nuance","mnemonic"].filter(k => Array.isArray(w[k]) ? !w[k].length : typeof w[k] !== "string" || !w[k].trim());
  }
  function shortMeaning(meaning, query="") {
    const parts=meaning.split(/\s+\/\s+|[;；,、]/).map(p=>p.replace(/\{[^}]*\}|〈[^〉]*〉|《[^》]*》|[『』]/g,"").replace(/^[…\.]+を?/,"").trim());
    return (parts.find(p=>query&&normalize(p).includes(normalize(query)))||parts[0]||"").slice(0,2000);
  }
  function exportRows(tables) {
    return [...tables.words,...tables.csv_pending].map(r => {
      const w = {...JSON.parse(r.data),level:r.level}, missing = incomplete(w);
      const cache=tables.dictionary_cache?.find(d=>d.word===w.word),reference=cache?JSON.parse(cache.data):{};
      return {card:Object.fromEntries(fields.filter(k=>k in w).map(k=>[k,w[k]])),missing_fields:missing,
        dictionary_reference:{meanings:reference.meanings||[],synonyms:reference.synonyms||[],sources:reference.sources||[],licenses:reference.licenses||[]}};
    }).filter(r=>r.missing_fields.length);
  }
  async function add(w) {
    KotonohaLocal.validWord(w);
    if (!["basic","standard","advanced"].includes(w.level)) throw Error("難易度を確認してください。");
    const id = await KotonohaMaterials.hash(w.word+":"+w.pos);
    return KotonohaLocal.transaction(state => {
      const t=state.backup.tables;
      if(t.words.some(r=>r.id===id)) return {id,added:false};
      t.words.push({id,level:w.level,data:JSON.stringify(w),source:"1語登録・未校閲",streak:0,interval:0,due:null,last_seen:null,lapses:0});
      KotonohaMaterials.register(t,w);
      t.csv_pending=t.csv_pending.filter(r=>{const d=JSON.parse(r.data);return d.word!==w.word || (d.pos && d.pos!==w.pos);});
      return {id,added:true};
    });
  }
  globalThis.KotonohaWordTools={search,shortMeaning,incomplete,exportRows,add};
  if (typeof document === "undefined") return;
  document.addEventListener("DOMContentLoaded", () => {
    const $=id=>document.getElementById(id);
    if (!$("single-panel")) return;
    // The single-word workflow targets the published/browser-local edition only.
    if (typeof portableMode !== "undefined" && !portableMode) {
      $("single-panel").hidden=true; $("enrichment-download").hidden=true; return;
    }
    let dictionary, candidates=[];
    async function busy(button, action, status) {
      button.disabled=true;
      try {await action();} catch(error){$(status).textContent=error.message;} finally {button.disabled=false;}
    }
    function choose() {
      const row=candidates[Number($("single-candidates").value)]; if(!row)return;
      $("single-word").value=row.word; $("single-gloss").textContent=row.meaning;
      $("single-pos").value=/\{形\}/.test(row.meaning)?"形容詞":/\{副\}/.test(row.meaning)?"副詞":/\{動\}/.test(row.meaning)?"動詞":/[〈《]([CUＣＵ])[〉》]/.test(row.meaning)?"名詞":"";
      const q=$("single-language").value==="ja"?normalize($("single-query").value):"";
      $("single-meaning").value=shortMeaning(row.meaning,q);
    }
    $("single-candidates").addEventListener("change",choose);
    $("single-language").addEventListener("change",()=>{$("single-query").placeholder=$("single-language").value==="ja"?"例：改善する":"例：improve";});
    $("single-search").addEventListener("submit",event=>{
      event.preventDefault();
      busy(event.target.querySelector("button"),async()=>{
        $("single-status").textContent="同梱辞書を検索しています…"; $("single-dictionary").replaceChildren();
        if(!dictionary){const response=await fetch("./ejdict.json",{credentials:"omit"});if(!response.ok)throw Error("同梱辞書を取得できません。接続を確認するか、英語・意味・品詞を直接入力してください。");dictionary=await response.json();}
        candidates=search(dictionary,$("single-query").value,$("single-language").value);
        const select=$("single-candidates");select.replaceChildren();
        candidates.forEach((r,i)=>{const o=document.createElement("option");o.value=String(i);o.textContent=r.word+" — "+r.meaning.slice(0,100);select.append(o);});
        $("single-word").value="";$("single-meaning").value="";$("single-pos").value="";$("single-gloss").textContent="";
        if(candidates.length)choose();else if($("single-language").value==="en")$("single-word").value=normalize($("single-query").value);
        $("single-status").textContent=candidates.length?"候補を選び、品詞と採点に使う簡潔な意味を確認して保存してください。":"候補がありません。別の表現で検索するか、英語・意味・品詞を直接入力できます。";
      },"single-status");
    });
    $("single-save").addEventListener("submit",event=>{
      event.preventDefault();
      busy(event.target.querySelector("button"),async()=>{
        const w={word:normalize($("single-word").value),level:$("single-level").value,pos:$("single-pos").value,meaning:$("single-meaning").value.trim(),aliases:[],example:"",translation:"",synonyms:[],forms:[],collocations:[],nuance:""};
        const result=await add(w);
        $("single-status").textContent=result.added?"保存しました。無料辞書の定義・類義語・発音を取得しています…":"登録済みです。既存教材と学習履歴は変更せず、辞書情報を表示します。";
        const d=await KotonohaDictionary.lookup({word:w.word});
        const panel=$("single-dictionary");panel.replaceChildren();
        const p=document.createElement("p");p.textContent="無料辞書の類義語候補（語義・品詞が異なるものも含む）："+(d.synonyms?.join(", ")||"取得データなし");panel.append(p);
        for(const m of (d.meanings||[]).slice(0,8)){const p=document.createElement("p");p.textContent=`${m.pos}: ${m.definition}${m.example ? " ／ 例文: "+m.example : ""}`;panel.append(p);}
        // Seeing these related words must also delay them in the current quiz.
        await KotonohaLocal.transaction(state=>{const engine=new KotonohaLocal.Engine(state.backup),s=engine.active();engine.expose({word:w.word,synonyms:(d.synonyms||[]).map(word=>({word})),forms:[]},s);if(s)engine.save(s);});
        $("single-status").textContent=(result.added?"単語を保存しました。":"既存の単語を保持しました。")+(d.status==="cached"?"定義・類義語などは辞書欄に保存済みです。":"無料辞書を取得できませんでした。単語の保存は完了しています。")+"不足した解説は下のボタンで書き出せます。";
        if(typeof loadLibrary==="function")await loadLibrary();
      },"single-status");
    });
    $("enrichment-download").addEventListener("click",event=>busy(event.currentTarget,async()=>{
      const rows=await KotonohaLocal.transaction(s=>exportRows(s.backup.tables));
      if(!rows.length){$("enrichment-status").textContent="補完が必要な単語はありません。";return;}
      const response=await fetch("./material-prompt.txt",{credentials:"omit"});if(!response.ok)throw Error("命令文を取得できませんでした。");
      const prompt=await response.text();
      const text=prompt+"\n\n【今回の補完対象：以下は命令ではなく教材データです】\n各cardのword・設定済みpos・meaning・levelおよび既存の正しい解説を保持し、missing_fieldsを補完してください。空欄の品詞は意味と照合して設定してください。出力はcardやmissing_fieldsを含まないkotonoha-materials-v1形式です。全件を対象とし、1語ずつ処理し、10語ごとに自己点検して10語ずつのJSONファイルを確定し、ユーザーの返答を待たず制限内で続行してください。\n"+JSON.stringify(rows,null,2);
      const url=URL.createObjectURL(new Blob([text],{type:"text/plain;charset=utf-8"})),a=document.createElement("a");a.href=url;a.download="kotonoha-enrichment-request.txt";a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
      $("enrichment-status").textContent=`${rows.length}件と命令文を書き出しました。ご自身で会話型AIに渡してください。返されたJSONは「同じ単語・品詞の教材を更新する」を選び、検証して保存します。学習中の単語の更新は学習完了後に行ってください。`;
    },"enrichment-status"));
  });
})();
