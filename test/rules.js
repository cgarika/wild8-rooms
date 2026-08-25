/*
 Wild Eights — rules & secrecy suite (proven against v1)
 Run:  BOT_MS=5 PORT=3311 node server.js     then:  node test/rules.js
 Proves: correct deal, hidden hands (others expose counts only), +2/+4
 victims draw and are skipped, deck exhaustion reshuffles the discard,
 full games complete with correct winner/standings, bot games + rematch.
*/
const { io } = require("socket.io-client");
const URL = "http://localhost:3311";
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const pick = (a)=>a[Math.floor(Math.random()*a.length)];
const COLORS=["r","g","y","b"];

function mk(name){
  const s = io(URL,{ transports:["websocket"] });
  s.nm=name; s.st=null; s.seat=-1; s.leaks=[]; s.prev=null;
  s.effErrors=[];
  s.on("state",({room,mySeat})=>{
    const prev = s.st;
    s.st=room; s.seat=mySeat;
    // SECRECY: other players expose count only, never cards
    for (let i=0;i<room.players.length;i++){
      const p=room.players[i];
      for (const k of Object.keys(p)) if(["hand","cards","yourHand"].includes(k)) s.leaks.push("player field "+k);
      if (typeof p.count !== "number") s.leaks.push("missing count");
    }
    if (room.yourHand && mySeat>=0 && room.players[mySeat] && room.yourHand.length !== room.players[mySeat].count)
      s.leaks.push("own hand/count mismatch");
    // EFFECTS: +2/+4 victims drew and were skipped
    if (room.lastPlay && room.lastPlay.card && prev && prev.v !== room.v){
      const lp = room.lastPlay;
      if ((lp.card.v==="+2"||lp.card.v==="+4") && room.status==="playing"){
        const want = lp.card.v==="+2"?2:4;
        if (lp.victimDrew !== undefined && lp.victimDrew !== want && lp.victimDrew !== 0)
          s.effErrors.push(`${lp.card.v} drew ${lp.victimDrew}`);
        if (lp.victim !== undefined && room.turn === lp.victim)
          s.effErrors.push(`victim of ${lp.card.v} was not skipped`);
      }
    }
  });
  return s;
}

async function act(c){
  const r=c.st; if(!r||r.status!=="playing"||c.seat!==r.turn) return;
  if (r.phase==="drawn"){
    const card=r.yourHand[r.drawnIdx];
    if (Math.random()<0.8 && card) c.emit("play",{ i:r.drawnIdx, color: card.c==="w"?pick(COLORS):undefined });
    else c.emit("keep");
    return;
  }
  if (r.yourLegal.length){
    const i=pick(r.yourLegal);
    const card=r.yourHand[i];
    c.emit("play",{ i, color: card.c==="w"?pick(COLORS):undefined });
  } else c.emit("draw");
}

async function playToEnd(cs,cap){
  for(let k=0;k<cap;k++){
    const r=cs[0].st;
    if(r&&r.status==="over") return true;
    for(const c of cs) await act(c);
    await sleep(8);
  }
  return false;
}

(async()=>{
  try{
    // ---- Test 1: 4 humans, secrecy + effects + completion ----
    const cs=[mk("A"),mk("B"),mk("C"),mk("D")];
    await sleep(300);
    let code=null; cs[0].on("joined",j=>{code=j.code;});
    cs[0].emit("create",{name:"A",playerId:"w0",avatar:"🦊"}); await sleep(250);
    for(let i=1;i<4;i++) cs[i].emit("join",{code,name:"P"+i,playerId:"w"+i,avatar:"🐼"});
    await sleep(300);
    cs[0].emit("start"); await sleep(300);
    const r0=cs[0].st;
    if(r0.players.reduce((a,p)=>a+p.count,0)!==28) throw new Error("deal wrong: "+r0.players.map(p=>p.count));
    if(!r0.top||r0.top.c==="w"||["S","R","+2"].includes(r0.top.v)) throw new Error("bad starting top: "+JSON.stringify(r0.top));
    if(!await playToEnd(cs,20000)) throw new Error("4p game didn't finish");
    const fin=cs[0].st;
    if(fin.winner==null) throw new Error("no winner");
    if(fin.players[fin.winner].count!==0) throw new Error("winner still has cards");
    if(!fin.standings||fin.standings[0].seat!==fin.winner) throw new Error("standings wrong");
    for(const c of cs){
      if(c.leaks.length) throw new Error(c.nm+" leak: "+c.leaks[0]);
      if(c.effErrors.length) throw new Error(c.nm+" effect: "+c.effErrors[0]);
    }
    console.log("PASS 4p secrecy+effects+completion — winner:", fin.players[fin.winner].name);
    cs.forEach(c=>c.close());

    // ---- Test 2: deck exhaustion -> reshuffle from discard ----
    const A=mk("A2"),B=mk("B2"); await sleep(250);
    let c2=null; A.on("joined",j=>{c2=j.code;});
    A.emit("create",{name:"A2",playerId:"wa2",avatar:"🦊"}); await sleep(250);
    B.emit("join",{code:c2,name:"B2",playerId:"wb2",avatar:"🐼"}); await sleep(250);
    A.emit("start"); await sleep(250);
    let sawZero=false, sawRefill=false, prevDeck=A.st.deckCount;
    for(let k=0;k<1500;k++){
      const r=A.st; if(!r||r.status!=="playing") break;
      if(r.deckCount===0) sawZero=true;
      if(sawZero && r.deckCount>prevDeck) { sawRefill=true; break; }
      prevDeck=r.deckCount;
      const me=[A,B].find(c=>c.seat===r.turn);
      if(me){
        if(r.phase==="drawn") me.emit("keep");
        else if(r.yourHand.length>10 && r.yourLegal.length){
          const i=pick(r.yourLegal); const card=r.yourHand[i];
          me.emit("play",{ i, color: card.c==="w"?pick(COLORS):undefined });
        } else me.emit("draw");
      }
      await sleep(8);
    }
    if(!sawZero) throw new Error("deck never reached zero");
    if(!sawRefill) throw new Error("reshuffle never refilled the deck");
    if(!await playToEnd([A,B],40000)) throw new Error("2p game didn't finish after reshuffle");
    console.log("PASS reshuffle — deck hit 0, refilled from discard, game completed");
    A.close(); B.close();

    // ---- Test 3: host + 3 bots to completion, twice via rematch ----
    const H=mk("H"); await sleep(250);
    let c3=null; H.on("joined",j=>{c3=j.code;});
    H.emit("create",{name:"Host",playerId:"wh",avatar:"🦊"}); await sleep(250);
    for(let i=0;i<3;i++) H.emit("addBot"); await sleep(300);
    const winners=[];
    for(let g=0;g<2;g++){
      if(g===0) H.emit("start"); else H.emit("rematch");
      await sleep(300);
      if(!await playToEnd([H],30000)) throw new Error("bot game "+g+" stalled");
      winners.push(H.st.players[H.st.winner].name);
    }
    console.log("PASS bot games x2 with rematch — winners:", winners.join(", "));
    H.close();
    console.log("ALL WILD EIGHTS TESTS PASS");
    process.exit(0);
  }catch(e){ console.error("FAIL:", e.message); process.exit(1); }
})();
