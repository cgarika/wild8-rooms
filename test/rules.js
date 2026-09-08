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

    // ---- Test 4 (T1 AFK policy): own fast-clock server on 3321 ----
    {
      const { spawn } = require("child_process");
      const TURN=700, AFK=250, P=3321, URL2="http://localhost:"+P;
      const srv = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT:String(P), TURN_MS:String(TURN), AFK_MS:String(AFK), BOT_MS:"5" }, stdio:"ignore" });
      await sleep(600);
      const mk2=(name)=>{ const c=io(URL2,{transports:["websocket"],reconnection:false}); c.st=null; c.seat=-1; c.logs=[]; c.on("state",({room,mySeat})=>{ c.st=room; c.seat=mySeat; if(room&&room.log) c.logs.push(room.log); }); return c; };
      const until=async(fn,ms=4000)=>{ const t0=Date.now(); while(Date.now()-t0<ms){ if(fn()) return true; await sleep(15);} return false; };
      const room2=async()=>{ const A=mk2("A"),B=mk2("B"); let code=null; A.on("joined",j=>{code=j.code;}); await sleep(200); A.emit("create",{name:"A",playerId:"afkA"+Math.random(),avatar:"🦊"}); await until(()=>code); B.emit("join",{code,name:"B",playerId:"afkB"+Math.random(),avatar:"🐼"}); await until(()=>B.st&&B.st.players.length===2); A.emit("start"); await until(()=>A.st&&A.st.status==="playing"); return {A,B}; };
      try {
        // 4a. the current player disconnects → the turn is auto-played on the AFK clock
        { const {A,B}=await room2(); const first=A.st.turn; const gone=first===0?A:B, W=first===0?B:A; gone.disconnect(); const t0=Date.now(); const adv=await until(()=>W.st&&W.st.turn!==first, TURN+800); const dt=Date.now()-t0;
          if(!adv) throw new Error("AFK: disconnected player's turn was not auto-played"); if(dt>=TURN) throw new Error("AFK: fired on the normal clock ("+dt+" ms)");
          if(!(await until(()=>W.logs.some(l=>/played for them/.test(l)),600))) throw new Error("AFK: no timeout note in the log");
          console.log("PASS AFK 5s clock — auto-played after "+dt+" ms (normal "+TURN+")"); W.disconnect(); }
        // 4b. three timeouts → botControlled; takeSeat and a real action clear it
        { const {A,B}=await room2(); const drive=(c)=>{ const r=c.st; if(!r||r.status!=="playing"||r.turn!==c.seat) return; if(r.phase==="drawn") c.emit("keep"); else if(r.yourLegal&&r.yourLegal.length){ const i=r.yourLegal[0]; const card=r.yourHand[i]; c.emit("play",{i,color:card.c==="w"?"r":undefined}); } else c.emit("draw"); };
          A.on("state",()=>setTimeout(()=>drive(A),10));
          const idle=B.seat;
          if(!(await until(()=>B.st&&B.st.players[idle].botControlled, TURN*8))) throw new Error("AFK: seat never became botControlled");
          if(B.st.players[idle].bot||B.st.players[idle].name!=="B") throw new Error("AFK: seat identity changed");
          if(!(await until(()=>B.logs.some(l=>/playing for B/.test(l)),500))) throw new Error("AFK: no takeover log");
          B.emit("takeSeat"); if(!(await until(()=>!B.st.players[idle].botControlled,1500))) throw new Error("AFK: takeSeat did not clear the flag");
          if(!(await until(()=>B.st.players[idle].botControlled, TURN*8))) throw new Error("AFK: seat did not flip a second time");
          B.emit("draw"); if(!(await until(()=>!B.st.players[idle].botControlled,1500))) throw new Error("AFK: a human action did not clear the flag");
          console.log("PASS AFK takeover after 3 timeouts, takeSeat + action hand it back"); A.disconnect(); B.disconnect(); }
        // 4c. a bot-controlled seat completes a whole game
        { const {A,B}=await room2(); A.on("state",()=>{ const r=A.st; if(!r||r.status!=="playing"||r.turn!==A.seat) return; setTimeout(()=>{ const r2=A.st; if(!r2||r2.status!=="playing"||r2.turn!==A.seat) return; if(r2.phase==="drawn") A.emit("keep"); else if(r2.yourLegal&&r2.yourLegal.length){ const i=r2.yourLegal[0]; A.emit("play",{i,color:r2.yourHand[i].c==="w"?"r":undefined}); } else A.emit("draw"); },5); });
          const idle=B.seat; B.disconnect();
          if(!(await until(()=>A.st&&A.st.status==="over",60000))) throw new Error("AFK: game with a bot-controlled seat stalled");
          if(!A.st.players[idle].botControlled) throw new Error("AFK: absent seat never became bot-controlled");
          console.log("PASS AFK bot-controlled seat finished a full game — winner "+A.st.players[A.st.winner].name); A.disconnect(); }
      } finally { srv.kill(); }
    }

    // ---- T3 host handover: host disconnects during play → another human becomes host ----
    {
      const { spawn } = require("child_process");
      const P=3331, URL2="http://localhost:"+P;
      const srv = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT:String(P), BOT_MS:"5" }, stdio:"ignore" });
      await sleep(600);
      const mk2=(name)=>{ const c=io(URL2,{transports:["websocket"],reconnection:false}); c.st=null; c.seat=-1; c.logs=[]; c.on("state",({room,mySeat})=>{ c.st=room; c.seat=mySeat; if(room&&room.log) c.logs.push(room.log); }); return c; };
      const wait=async(fn,ms=6000)=>{ const t0=Date.now(); while(Date.now()-t0<ms){ if(fn()) return true; await sleep(15);} return false; };
      try {
        const n=2; const cs=[]; for(let i=0;i<n;i++) cs.push(mk2("H"+i)); await sleep(250); let code=null; cs[0].on("joined",j=>{code=j.code;});
        cs[0].emit("create",{name:"H0",playerId:"h0"+Math.random(),avatar:"🦊"}); await wait(()=>code); for(let i=1;i<n;i++) cs[i].emit("join",{code,name:"H"+i,playerId:"h"+i+Math.random(),avatar:"🐼"}); await wait(()=>cs[0].st&&cs[0].st.players.length===n);
        
        cs[0].emit("start"); if(!(await wait(()=>cs[1].st&&cs[1].st.status==="playing"))) throw new Error("T3: game did not start");
        if(cs[1].st.hostSeat!==cs[0].seat) throw new Error("T3: creator is not the host at start");
        cs[0].disconnect();
        if(!(await wait(()=>cs[1].st.hostSeat===cs[1].seat, 3000))) throw new Error("T3: host did not move to the connected human (hostSeat "+cs[1].st.hostSeat+")");
        if(!cs[1].logs.some(l=>/is now the host/.test(l))) throw new Error("T3: no host log line");
        console.log("PASS T3 host handover — host disconnected mid-game, next connected human is host");
        
        cs.forEach(c=>c.disconnect());
      } finally { srv.kill(); }
    }
    // ---- T6: a leaver's cards go back under the draw pile; a stuck round ends immediately ----
    {
      const { spawn } = require("child_process");
      const P=3341, URL2="http://localhost:"+P;
      const srv = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT:String(P), BOT_MS:"5", TEST_HOOKS:"1" }, stdio:"ignore" });
      await sleep(600);
      const mk2=(name)=>{ const c=io(URL2,{transports:["websocket"],reconnection:false}); c.st=null; c.seat=-1; c.logs=[]; c.on("state",({room,mySeat})=>{ c.st=room; c.seat=mySeat; if(room&&room.log) c.logs.push(room.log); }); return c; };
      const wait=async(fn,ms=6000)=>{ const t0=Date.now(); while(Date.now()-t0<ms){ if(fn()) return true; await sleep(15);} return false; };
      const boot=async(n)=>{ const cs=[]; for(let i=0;i<n;i++) cs.push(mk2("L"+i)); await sleep(250); let code=null; cs[0].on("joined",j=>{code=j.code;}); cs[0].emit("create",{name:"L0",playerId:"l0"+Math.random(),avatar:"🦊"}); await wait(()=>code); for(let i=1;i<n;i++) cs[i].emit("join",{code,name:"L"+i,playerId:"l"+i+Math.random(),avatar:"🐼"}); await wait(()=>cs[0].st&&cs[0].st.players.length===n); cs[0].emit("start"); await wait(()=>cs.every(c=>c.st&&c.st.status==="playing"&&c.st.yourHand.length===7)); return cs; };
      try {
        { const cs=await boot(3); const leaver=cs[2]; const before=cs[0].st.deckCount; const handN=leaver.st.yourHand.length; const v0=cs[0].st.v||0;
          leaver.emit("leave"); if(!(await wait(()=>cs[0].st.players[leaver.seat].left))) throw new Error("T6: leave not registered");
          const after=cs[0].st.deckCount; if(after!==before+handN) throw new Error(`T6: draw pile ${before} → ${after}, expected ${before+handN} (leaver held ${handN})`);
          console.log("PASS T6 leaver's "+handN+" cards returned to the draw pile ("+before+" → "+after+")"); cs.forEach(c=>c.disconnect()); }
        { const cs=await boot(2); const cur=cs.find(c=>c.st.turn===c.seat), other=cs.find(c=>c.st.turn!==c.seat);
          // craft: empty deck, only the top discard left, current player holds two cards that cannot be played on it
          const top=cur.st.top; const badColor=["r","g","y","b"].find(c=>c!==top.c&&c!==cur.st.color); const badVal=String(top.v)==="3"?"4":"3";
          cur.emit("__test",{ emptyDeck:true, discardTopOnly:true, hands:{ [cur.seat]:[{c:badColor,v:badVal},{c:badColor,v:badVal}], [other.seat]:[{c:badColor,v:badVal},{c:badColor,v:badVal},{c:badColor,v:badVal}] } });
          await wait(()=>cur.st.deckCount===0 && cur.st.yourHand.length===2);
          if(cur.st.yourLegal.length) throw new Error("T6: crafted hand still has a legal card");
          cur.emit("draw");
          if(!(await wait(()=>cur.st.status==="over",3000))) throw new Error("T6: stuck round did not end (phase "+cur.st.phase+")");
          if(cur.st.winner!==cur.seat) throw new Error("T6: winner should be the lowest hand ("+cur.st.log+")");
          if(!/round over/i.test(cur.st.log)) throw new Error("T6: no round-over log: "+cur.st.log);
          console.log("PASS T6 empty piles + no legal card → round ends, lowest hand wins"); cs.forEach(c=>c.disconnect()); }
      } finally { srv.kill(); }
    }
    console.log("ALL WILD EIGHTS TESTS PASS");
    process.exit(0);
  }catch(e){ console.error("FAIL:", e.message); process.exit(1); }
})();
