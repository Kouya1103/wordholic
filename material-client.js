"use strict";
(() => {
  const fields=["word","level","pos","meaning","aliases","example","translation","synonyms","forms","collocations"];
  const levels={basic:"basic",standard:"standard",advanced:"advanced","初級":"basic","中級":"standard","上級":"advanced"};
  const positions={noun:"名詞",n:"名詞",verb:"動詞",v:"動詞",adjective:"形容詞",adj:"形容詞",adverb:"副詞",adv:"副詞",preposition:"前置詞",prep:"前置詞",conjunction:"接続詞",conj:"接続詞",pronoun:"代名詞",pron:"代名詞",interjection:"間投詞"};
  const headers={"英単語":"word","単語":"word","意味":"meaning","日本語":"meaning","品詞":"pos","難易度":"level","別解":"aliases","例文":"example","和訳":"translation","類義語":"synonyms","語形":"forms","コロケーション":"collocations"};
  const fail=message=>{throw Error(message);};
  async function hash(text,length=20){if(!globalThis.crypto?.subtle)fail("教材追加にはHTTPSまたはlocalhostの接続が必要です。");return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,"0")).join("").slice(0,length);}
  function parseCSV(text){const rows=[];let row=[],cell="",quoted=false,closed=false;
    for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;continue;}
      if(c==='"'){if(cell||closed)fail("CSVの引用符が不正です。");quoted=true;}
      else if(c===","||c==="\n"||c==="\r"){row.push(cell);cell="";closed=false;if(c!==","){if(c==="\r"&&text[i+1]==="\n")i++;rows.push(row);row=[];}}
      else {if(closed)fail("閉じ引用符の後に不正な文字があります。");cell+=c;}}
    if(quoted)fail("CSVの引用符が閉じられていません。");if(cell||row.length||closed){row.push(cell);rows.push(row);}return rows;}
  function register(t,w){for(const word of new Set([w.word,...w.synonyms.map(x=>x.word),...w.forms.map(x=>x.word)].map(s=>s.trim().toLowerCase()).filter(s=>/^[a-z][a-z '\-]{0,79}$/.test(s))))if(!t.pronunciations.some(r=>r.word===word))t.pronunciations.push({word,data:JSON.stringify({word,dictionary_url:`https://en.wiktionary.org/wiki/${encodeURIComponent(word)}#English`,status:"unfetched",phonetic:"",audio_source:"",source_page:"",license_name:"",license_url:"",checked_at:"",message:""}),audio:null,mime:null});}
  async function prepare(path,data){
    if(typeof data.file!=="string"||data.file.length>3*1024*1024)fail("2MB以下の教材ファイルを選んでください。");
    const bytes=Uint8Array.from(atob(data.file),c=>c.charCodeAt(0));if(!bytes.length||bytes.length>2*1024*1024)fail("空でない2MB以下のファイルを選んでください。");
    const csv=path.startsWith("csv/");let entries=[];
    if(csv){let text;try{text=new TextDecoder(data.encoding==="cp932"?"shift_jis":"utf-8",{fatal:true}).decode(bytes);}catch(e){if(data.encoding!=="auto")throw e;text=new TextDecoder("shift_jis",{fatal:true}).decode(bytes);}
      const rows=parseCSV(text.replace(/^\uFEFF/,"")),names=(rows.shift()||[]).map(h=>headers[h.trim().toLowerCase()]||h.trim().toLowerCase());
      if(!names.includes("word")||new Set(names).size!==names.length||names.some(n=>!fields.includes(n)))fail("CSVの見出しを確認してください。");
      for(let i=0;i<rows.length;i++){const cells=rows[i];if(!cells.some(s=>s.trim()))continue;if(cells.length!==names.length)fail(`${i+2}行目の列数が不正です。`);const v=Object.fromEntries(names.map((n,j)=>[n,cells[j].trim()])),word=v.word.toLowerCase(),rawPos=(v.pos||"").toLowerCase().replace(/\.$/,""),w={word,pos:positions[rawPos]||rawPos,meaning:v.meaning||"",example:v.example||"",translation:v.translation||""};
        for(const key of ["aliases","synonyms","forms","collocations"]){const value=v[key]||"";w[key]=value.startsWith("[")?JSON.parse(value):key==="aliases"?value.split("|").map(s=>s.trim()).filter(Boolean):[];if(value&&key!=="aliases"&&!value.startsWith("["))fail(`${key}はJSON配列で指定してください。`);}
        KotonohaLocal.validWord({...w,pos:w.pos||"名詞",meaning:w.meaning||"未設定"});const level=levels[v.level||data.level||"basic"];if(!level)fail("難易度が不正です。");entries.push({w,level,line:i+2});}
    }else{const p=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));if(p.format!=="kotonoha-materials-v1"||Object.keys(p).sort().join()!=="format,words"||!Array.isArray(p.words))fail("教材JSONの形式が不正です。");const seen=new Set();
      entries=p.words.map(w=>{if(!w||Object.keys(w).sort().join()!==fields.slice().sort().join())fail("教材の必須項目を確認してください。");KotonohaLocal.validWord(w);if(!levels[w.level]||!w.example.trim()||!w.translation.trim()||!w.collocations.length||w.aliases.length>20)fail("教材の難易度・例文・コロケーションを確認してください。");w={...w,word:w.word.trim().toLowerCase()};const key=w.word+":"+w.pos;if(seen.has(key))fail("ファイル内で単語・品詞が重複しています。");seen.add(key);return {w,level:w.level};});}
    if(!entries.length||entries.length>1000)fail("1回の取り込みは1〜1000件です。");
    for(const e of entries){e.id=await hash(e.w.word+":"+e.w.pos);e.draft=await hash(e.level+JSON.stringify(e.w),24);}
    return state=>{const t=state.backup.tables,engine=new KotonohaLocal.Engine(state.backup),s=engine.active(),preview=path.endsWith("preview"),result={valid:true,added:0,pending:0,updated:0,skipped:0,drafts_completed:0,total:entries.length,rows:[],entries:[],message:preview?"確認のみ。まだ保存していません。":"教材を保存しました。"};
      const work=preview?JSON.parse(JSON.stringify(t)):t;
      if(!csv&&data.update&&s&&s.cursor<s.queue.length&&entries.some(e=>s.queue.includes(e.id)))fail("学習中の単語は、学習を完了してから更新してください。");
      for(const e of entries){const old=work.words.find(r=>r.id===e.id),ready=Boolean(e.w.meaning&&e.w.pos),duplicate=old||(csv&&!e.w.pos&&work.words.some(r=>JSON.parse(r.data).word===e.w.word));let status;
        if(duplicate&&(csv||!data.update))status="skipped";else if(!ready){if(work.csv_pending.some(r=>r.id===e.draft))status="skipped";else{status="pending";work.csv_pending.push({id:e.draft,level:e.level,data:JSON.stringify(e.w)});register(work,e.w);}}
        else if(old){status="updated";Object.assign(old,{level:e.level,data:JSON.stringify(e.w),source:"教材JSON・未校閲"});}
        else{status="added";work.words.push({id:e.id,level:e.level,data:JSON.stringify(e.w),source:csv?"CSV取り込み":"教材JSON・未校閲",streak:0,interval:0,due:null,last_seen:null,lapses:0});}
        if(ready&&status!=="skipped"){register(work,e.w);if(!csv){const ids=work.csv_pending.filter(r=>{const w=JSON.parse(r.data);return w.word===e.w.word&&(!w.pos||w.pos===e.w.pos);}).map(r=>r.id);result.drafts_completed+=ids.length;work.csv_pending=work.csv_pending.filter(r=>!ids.includes(r.id));}}
        result[status]++;result.entries.push({word:e.w.word,pos:e.w.pos,meaning:e.w.meaning,action:{added:"追加",updated:"更新",skipped:"スキップ",pending:"補完待ち"}[status]});if(result.rows.length<20)result.rows.push({line:e.line,word:e.w.word,pos:e.w.pos,meaning:e.w.meaning,status});}
      return result;};
  }
  globalThis.KotonohaMaterials={prepare,parseCSV};
})();
