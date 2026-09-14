"use strict";
(() => {
  const clean = value => typeof value === "string" ? value.trim().slice(0,2000) : "";
  const list = value => Array.isArray(value) ? value : [];
  const unique = values => [...new Map(values.map(clean).filter(Boolean).map(v=>[v.toLowerCase(),v])).values()].slice(0,100);
  async function fetchSafe(url, limit) {
    const p=new URL(url),paths={"api.dictionaryapi.dev":["/api/v2/entries/en/","/media/pronunciations/en/"],"ssl.gstatic.com":["/dictionary/static/sounds/"],"upload.wikimedia.org":["/wikipedia/commons/"]};
    if(p.protocol!=="https:"||p.username||p.password||p.port||!paths[p.hostname]?.some(path=>p.pathname.startsWith(path)))throw Error("許可されていない配信元です。");
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
    try{const response=await fetch(p.href,{signal:controller.signal,redirect:"error",credentials:"omit",referrerPolicy:"no-referrer"});if(!response.ok)throw Error("辞書データなし");
      const reader=response.body.getReader(),parts=[];let size=0;
      while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw Error("辞書データが大きすぎます。");}parts.push(value);}
      const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}return {bytes,mime:(response.headers.get("content-type")||"").split(";")[0]};
    }finally{clearTimeout(timer);}
  }
  async function lookup(data) {
    const word=String(data.word||"").toLowerCase().trim();
    const initial=await KotonohaLocal.transaction(state=>{if(!state.backup.tables.pronunciations.some(r=>r.word===word))throw Error("登録済みの単語を指定してください。");return {cache:state.backup.tables.dictionary_cache.find(r=>r.word===word),nonce:state.backup.tables.preferences.find(r=>r.key==="restore_nonce")?.value,audio:state.backup.tables.pronunciations.find(r=>r.word===word)?.audio};});
    const saved=initial.cache?JSON.parse(initial.cache.data):null;if(saved&&!data.retry)return saved;
    let result=saved||{word,meanings:[],phonetics:[],synonyms:[],antonyms:[],sources:[],licenses:[]},audio=null,mime=null,audioMeta={};
    try{
      const response=await fetchSafe("https://api.dictionaryapi.dev/api/v2/entries/en/"+encodeURIComponent(word),512*1024);
      const entries=JSON.parse(new TextDecoder().decode(response.bytes)),fresh={word,meanings:[],phonetics:[],synonyms:[],antonyms:[],sources:[],licenses:[]},candidates=[],seen=new Set();
      for(const e of list(entries).slice(0,20)){if(clean(e?.word).toLowerCase()!==word)continue;fresh.phonetics.push(clean(e.phonetic));fresh.sources.push(...list(e.sourceUrls));if(e.license)fresh.licenses.push({name:clean(e.license.name),url:clean(e.license.url)});
        for(const p of list(e.phonetics).slice(0,30)){if(!p)continue;fresh.phonetics.push(clean(p.text));if(p.audio)candidates.push(p);}
        for(const m of list(e.meanings).slice(0,30)){if(!m)continue;fresh.synonyms.push(...list(m.synonyms));fresh.antonyms.push(...list(m.antonyms));for(const d of list(m.definitions).slice(0,50)){if(!d)continue;fresh.synonyms.push(...list(d.synonyms));fresh.antonyms.push(...list(d.antonyms));const definition=clean(d.definition),pos=clean(m.partOfSpeech),key=pos+":"+definition.toLowerCase();if(definition&&!seen.has(key)){seen.add(key);fresh.meanings.push({pos,definition,example:clean(d.example)});}}}}
      for(const key of ["phonetics","synonyms","antonyms","sources"])fresh[key]=unique(fresh[key]);fresh.licenses=[...new Map(fresh.licenses.map(l=>[JSON.stringify(l),l])).values()];
      if(!fresh.meanings.length)throw Error("データなし");result={...fresh,status:"cached",message:"保存済みの無料辞書情報です。",checkedAt:new Date().toISOString()};
      if(!initial.audio)for(const p of candidates.slice(0,3)){try{const url=String(p.audio).startsWith("//")?"https:"+p.audio:p.audio,r=await fetchSafe(url,1024*1024),head=new TextDecoder().decode(r.bytes.slice(0,12)),kind={"audio/mp3":"audio/mpeg","application/ogg":"audio/ogg","audio/x-wav":"audio/wav"}[r.mime]||r.mime;
        if(!((kind==="audio/mpeg"&&(head.startsWith("ID3")||r.bytes[0]===255))||(kind==="audio/ogg"&&head.startsWith("OggS"))||(kind==="audio/wav"&&head.startsWith("RIFF")&&head.slice(8,12)==="WAVE")))continue;
        let binary="";for(let i=0;i<r.bytes.length;i+=8192)binary+=String.fromCharCode(...r.bytes.subarray(i,i+8192));audio={base64:btoa(binary)};mime=kind;audioMeta={audio_source:url,source_page:clean(p.sourceUrl),license_name:clean(p.license?.name),license_url:clean(p.license?.url)};break;
      }catch{ /* Audio hosts may not permit browser cross-origin access. TTS remains available. */ }}
    }catch{result={...result,status:saved?.meanings?.length?"stale":"unavailable",message:"無料辞書を取得できませんでした。保存済み情報を表示します。学習は続けられます。",checkedAt:new Date().toISOString()};}
    return KotonohaLocal.transaction(state=>{const t=state.backup.tables;if(t.preferences.find(r=>r.key==="restore_nonce")?.value!==initial.nonce)throw Error("復元が行われたため、辞書取得を再度お試しください。");
      const row=t.dictionary_cache.find(r=>r.word===word);if(row)row.data=JSON.stringify(result);else t.dictionary_cache.push({word,data:JSON.stringify(result)});
      const pronunciation=t.pronunciations.find(r=>r.word===word);if(pronunciation){const meta=JSON.parse(pronunciation.data);pronunciation.data=JSON.stringify({...meta,...audioMeta,phonetic:result.phonetics?.[0]||meta.phonetic});if(audio){pronunciation.audio=audio;pronunciation.mime=mime;}}return result;});
  }
  globalThis.KotonohaDictionary={lookup};
})();
