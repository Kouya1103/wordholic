"use strict";
const BASE = new URL("./",self.location.href);
const PREFIX = "kotonoha:"+BASE.pathname+":";
const CACHE = PREFIX+"2631d90129db";
const ASSETS = ["./", "./app.js", "./extras.js", "./local-engine.js", "./dictionary-client.js", "./material-client.js", "./style.css", "./manifest.json", "./icon.svg", "./material-prompt.txt", "./material-example.json", "./template.csv", "./word-tools.js", "./ejdict.json", "./ejdict-license.txt", "./seed-data.js"].map(path=>new URL(path,BASE).href);
self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS))));
self.addEventListener("activate",event=>event.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith(PREFIX)&&k!==CACHE).map(k=>caches.delete(k)))),self.clients.claim()])));
self.addEventListener("fetch",event=>{
  const url=new URL(event.request.url);url.search="";
  if(url.pathname===BASE.pathname+"index.html")url.pathname=BASE.pathname;
  if(event.request.method!=="GET"||!ASSETS.includes(url.href))return;
  event.respondWith(caches.open(CACHE).then(async cache=>(await cache.match(url.href))||fetch(event.request)));
});
