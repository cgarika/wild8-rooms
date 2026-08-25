/* Browser-level UI suite (Playwright) against the LIVE deployment.
   Run from test/:  node ui-test.js        (BASE=https://needasix.com/eights by default)
   Screenshots land in $SHOTS or test/shots.

   Covers:
   1. Lobby UI: create room, Add/Remove bot buttons, Deal enables at 2+ players
   2. Real game vs 2 bots through clicks: lifted-card play, draw-pile when stuck,
      wild -> color picker appears and picked color sticks, winner screen + standings
      (rematches up to 2x if no wild came up, exercising Deal again too)
   3. Voice: two contexts with fake mics join voice, WebRTC reaches "connected",
      mute toggles track.enabled, leave tears down cleanly
   4. Mobile pass (iPhone 13 portrait): overflow audit, cards tappable, picker fits
*/
const { chromium, devices } = require("playwright");
const fs = require("fs");
const BASE = process.env.BASE || "https://needasix.com/eights";
const SHOTS = process.env.SHOTS || __dirname + "/shots";
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
let cur = null;
const ok = (m) => console.log("  ✓", m);
const bad = (m) => { console.log("  ✗", m); cur.errors.push(m); process.exitCode = 1; };
const flag = (m) => { console.log("  ⚑", m); cur.flags.push(m); };

async function test(title, fn) {
  cur = { title, errors: [], flags: [] };
  console.log("\n▶ " + title);
  const t0 = Date.now();
  try { await fn(); } catch (e) { bad("EXCEPTION: " + e.message.split("\n")[0]); }
  cur.secs = ((Date.now() - t0) / 1000).toFixed(1);
  results.push(cur);
}

(async () => {
  const browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });

  const mkPage = async (name, ctxOpts = {}, { mic = false } = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, reducedMotion: "reduce", ...ctxOpts });
    if (mic) await ctx.grantPermissions(["microphone"], { origin: new URL(BASE).origin });
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => bad(`${name} JS error: ${e.message}`));
    pg.on("dialog", (d) => d.accept());
    pg._name = name;
    return pg;
  };
  const createRoom = async (pg, name) => {
    await pg.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
    await pg.fill("#nameIn", name);
    await pg.click("#createBtn");
    await pg.waitForSelector("#lobby:not(.hidden)", { timeout: 10000 });
    return (await pg.textContent("#lobbyCode")).replace(/[^A-Z0-9]/g, "");
  };
  const joinRoom = async (pg, name, code) => {
    await pg.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
    await pg.fill("#nameIn", name);
    await pg.fill("#codeIn", code);
    await pg.click("#joinBtn");
    await pg.waitForSelector("#lobby:not(.hidden)", { timeout: 10000 });
  };
  const players = async (pg) => pg.evaluate(() => S.room.players.length);
  const snap = (pg) => pg.evaluate(() => ({
    status: S.room.status, phase: S.room.phase, turn: S.room.turn, mySeat: S.mySeat,
    legal: S.room.yourLegal || [], hand: (S.room.yourHand || []).map((c) => c.c),
    drawnIdx: S.room.drawnIdx, color: S.room.color, nPlayers: S.room.players.length,
  }));

  /* ---- 1 + 2 share one room: host page A ---- */
  const A = await mkPage("Alice");

  await test("1. Lobby: create room, bot buttons, Deal enables at 2+", async () => {
    const code = await createRoom(A, "Alice");
    /^[A-Z0-9]{4,8}$/.test(code) ? ok(`room ${code} created`) : bad("bad room code: " + code);

    (await A.getAttribute("#startBtn", "disabled")) !== null
      ? ok("Deal disabled with 1 player") : bad("Deal enabled with only 1 player");

    await A.click("#addBotBtn");
    await A.waitForFunction(() => S.room.players.length === 2, null, { timeout: 5000 });
    const row = await A.textContent("#plist");
    row.includes("(bot)") ? ok('bot row shows "(bot)" suffix') : bad('bot row missing "(bot)": ' + row.trim());
    row.includes("\u{1F916}") ? ok("bot row shows 🤖 avatar") : bad("bot row missing 🤖 avatar");
    (await A.getAttribute("#startBtn", "disabled")) === null
      ? ok("Deal enables at 2 players") : bad("Deal still disabled at 2 players");

    await A.waitForSelector("#delBotBtn", { timeout: 3000 });
    await A.click("#delBotBtn");
    await A.waitForFunction(() => S.room.players.length === 1, null, { timeout: 5000 });
    ok("Remove bot removes the bot (back to 1 player)");
    (await A.$("#delBotBtn")) ? bad("Remove bot button still shown with no bots") : ok("Remove bot button hides when no bots remain");
    (await A.getAttribute("#startBtn", "disabled")) !== null
      ? ok("Deal disabled again at 1 player") : bad("Deal stayed enabled after bot removed");
  });

  await test("2. Game vs 2 bots: lifted play, draw when stuck, wild picker, winner + standings", async () => {
    for (let i = 0; i < 2; i++) { await A.click("#addBotBtn"); await A.waitForTimeout(250); }
    await A.waitForFunction(() => S.room.players.length === 3, null, { timeout: 5000 });
    await A.click("#startBtn");
    await A.waitForSelector("#game:not(.hidden)", { timeout: 10000 });
    await A.waitForSelector("#hand .hcard", { timeout: 10000 });
    ok("dealt: game screen + hand rendered (vs 2 bots)");
    const handN = (await A.$$("#hand .hcard")).length;
    const pillN = (await A.$$("#strip .pill")).length;
    pillN === 3 ? ok("3 player pills on the strip") : bad(`expected 3 pills, got ${pillN}`);
    ok(`opening hand: ${handN} cards`);

    let playedLifted = false, drewStuck = false, wildPlayed = false, pickerOk = false,
        drawnChoice = false, games = 1, shot = false;
    const deadline = Date.now() + 420000;

    const playWildViaPicker = async (clickFn) => {
      await clickFn();
      const appeared = await A.waitForSelector("#picker:not(.hidden)", { timeout: 4000 }).then(() => true, () => false);
      if (!appeared) { bad("wild clicked but color picker never appeared"); return false; }
      const want = "g";
      await A.click(`#picker .swatch[data-c="${want}"]`);
      await A.waitForFunction(() => document.getElementById("picker").classList.contains("hidden"), null, { timeout: 4000 });
      const stuck = await A.waitForFunction((w) => S.room.color === w, want, { timeout: 6000 }).then(() => true, () => false);
      if (!stuck) { bad("picker choice did not set the room color"); return false; }
      if (!pickerOk) ok("wild play: picker appeared, chosen color (green) became the active color");
      return true;
    };

    while (Date.now() < deadline) {
      const st = await snap(A);
      if (st.status === "over") {
        if (!wildPlayed && games < 3 && Date.now() < deadline - 150000) {
          games++;
          await A.click("#rematchBtn");
          await A.waitForFunction(() => S.room.status === "playing", null, { timeout: 10000 });
          flag(`no wild was playable in game ${games - 1} — dealt again (game ${games})`);
          continue;
        }
        break;
      }
      if (st.status !== "playing") break;
      if (st.turn !== st.mySeat) { await A.waitForTimeout(350); continue; }

      if (st.phase === "drawn") {
        // play-or-keep on a freshly drawn playable card
        drawnChoice = true;
        if (st.hand[st.drawnIdx] === "w") {
          if (await playWildViaPicker(() => A.click("#playDrawnBtn"))) { wildPlayed = true; pickerOk = true; }
        } else if (Math.random() < 0.8) await A.click("#playDrawnBtn");
        else await A.click("#keepBtn");
        await A.waitForTimeout(500);
        continue;
      }
      if (st.legal.length) {
        const wildIdx = st.legal.find((i) => st.hand[i] === "w");
        if (wildIdx !== undefined) {
          if (await playWildViaPicker(() => A.click(`#hand .hcard[data-i="${wildIdx}"]`))) { wildPlayed = true; pickerOk = true; }
        } else {
          await A.click(`#hand .hcard[data-i="${st.legal[0]}"]`);
          if (!playedLifted) ok("played a lifted (legal) card by clicking it");
          playedLifted = true;
        }
        if (!shot) { await A.screenshot({ path: SHOTS + "/midgame.png" }); shot = true; }
      } else {
        await A.click("#drawpile");
        if (!drewStuck) ok("no legal card — tapped the draw pile and a card arrived");
        drewStuck = true;
      }
      await A.waitForTimeout(500);
    }

    playedLifted || bad("never played a lifted card");
    drewStuck || bad("never got to tap the draw pile (no stuck turn seen)");
    drawnChoice ? ok("drew a playable card and chose via Play it / Keep it") : flag("play-or-keep row never came up");
    wildPlayed && pickerOk ? ok(`wild + color picker verified (game ${games})`)
      : bad(`no playable wild across ${games} game(s) — picker unverified`);

    const st = await snap(A);
    st.status === "over" ? ok("game reached a finished state") : bad(`game never finished (status ${st.status})`);
    const overVisible = await A.isVisible("#overbox");
    overVisible ? ok("winner screen (overbox) is visible") : bad("overbox hidden at game over");
    const winname = ((await A.textContent("#winname")) || "").trim();
    /wins!$/.test(winname) ? ok(`winner announced: "${winname}"`) : bad(`winner label wrong: "${winname}"`);
    const standings = (await A.$$("#overbox .standing")).length;
    standings === st.nPlayers ? ok(`standings list all ${st.nPlayers} players`) : bad(`standings rows ${standings} != players ${st.nPlayers}`);
    await A.screenshot({ path: SHOTS + "/winner.png" });
    await A.click("#leaveGameBtn");
    await A.waitForSelector("#home:not(.hidden)", { timeout: 5000 });
    ok("left the game back to home");
    await A.context().close();
  });

  await test("3. Voice: 2 players connect, mute toggles track, leave tears down", async () => {
    const V1 = await mkPage("Vera", {}, { mic: true });
    const V2 = await mkPage("Wade", {}, { mic: true });
    const code = await createRoom(V1, "Vera");
    await joinRoom(V2, "Wade", code);
    await V1.waitForFunction(() => S.room.players.length === 2, null, { timeout: 8000 });
    await V1.click("#startBtn");
    await V1.waitForSelector("#voicebar:not(.hidden)", { timeout: 10000 });
    await V2.waitForSelector("#voicebar:not(.hidden)", { timeout: 10000 });
    ok("voice bar visible on both players once the cards are dealt");

    await V1.click("#voiceBtn");
    await V1.waitForFunction(() => VOICE.on === true, null, { timeout: 8000 });
    await V2.click("#voiceBtn");
    for (const P of [V1, V2]) {
      await P.waitForFunction(() => document.getElementById("voicewho").textContent.includes("2 in voice"), null, { timeout: 15000 });
      ok(`${P._name}: bar shows "2 in voice"`);
    }
    for (const P of [V1, V2]) {
      await P.waitForFunction(
        () => VOICE.pcs.size >= 1 && [...VOICE.pcs.values()].every((pc) => pc.connectionState === "connected"),
        null, { timeout: 30000 }
      ).then(
        () => ok(`${P._name}: RTCPeerConnection reached connectionState "connected"`),
        async () => bad(`${P._name}: WebRTC never connected — states: ` +
          await P.evaluate(() => JSON.stringify([...VOICE.pcs.values()].map((pc) => pc.connectionState))))
      );
    }
    await V1.screenshot({ path: SHOTS + "/voice-connected.png" });

    // mute
    await V1.click("#voiceBtn"); // now toggles mute
    await V1.waitForFunction(() => VOICE.muted === true, null, { timeout: 5000 });
    (await V1.evaluate(() => VOICE.stream.getAudioTracks().every((t) => t.enabled === false)))
      ? ok("Mute disables the local audio track (track.enabled=false)") : bad("mute did not disable the track");
    (await V1.textContent("#voiceBtn")).includes("Unmute") ? ok('button relabels to "Unmute"') : bad("mute button label wrong");
    await V1.click("#voiceBtn");
    await V1.waitForFunction(() => VOICE.muted === false, null, { timeout: 5000 });
    (await V1.evaluate(() => VOICE.stream.getAudioTracks().every((t) => t.enabled === true)))
      ? ok("Unmute re-enables the track") : bad("unmute did not re-enable the track");

    // leave
    await V1.click("#voiceLeave");
    await V1.waitForFunction(() => !VOICE.on && VOICE.pcs.size === 0 && VOICE.stream === null, null, { timeout: 5000 });
    ok("leave voice: local peer map cleared, mic stream stopped");
    (await V1.textContent("#voiceBtn")).includes("Join voice") ? ok('button back to "Join voice"') : bad("leave label wrong");
    await V2.waitForFunction(() => document.getElementById("voicewho").textContent.includes("1 in voice"), null, { timeout: 8000 });
    await V2.waitForFunction(() => VOICE.pcs.size === 0, null, { timeout: 8000 });
    ok('other player sees "1 in voice" and drops the dead peer connection');

    await V2.click("#voiceLeave").catch(() => {});
    for (const P of [V1, V2]) await P.click("#leaveGameBtn").catch(() => {});
    await V1.context().close(); await V2.context().close();
  });

  await test("4. Mobile pass: iPhone 13 portrait, overflow audit, cards tappable, picker fits", async () => {
    const iphone = devices["iPhone 13"];
    const ctx = await browser.newContext({ ...iphone, reducedMotion: "reduce" });
    const M = await ctx.newPage();
    M.on("pageerror", (e) => bad(`mobile JS error: ${e.message}`));
    M.on("dialog", (d) => d.accept());

    const audit = async (stage) => {
      const issues = await M.evaluate(() => {
        const out = [];
        const W = window.innerWidth, de = document.documentElement;
        if (de.scrollWidth > W + 1) out.push(`page overflows horizontally: ${de.scrollWidth}px > ${W}px viewport`);
        const sels = "button, input, .hcard, .avchip, .swatch, #drawpile, .chattoggle, .sendbtn, #voiceLeave";
        for (const el of document.querySelectorAll(sels)) {
          if (el.classList.contains("hidden") || el.closest(".hidden") || el.offsetParent === null) continue;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          const name = `<${el.tagName.toLowerCase()}${el.id ? "#" + el.id : "." + ((el.getAttribute("class") || "").split(" ")[0] || "")}>`;
          if (r.width < 24 || r.height < 24) out.push(`tap target under 24px: ${name} ${Math.round(r.width)}x${Math.round(r.height)}`);
          if (r.left < -1 || r.right > W + 1) {
            let scrollable = false;
            for (let a = el.parentElement; a; a = a.parentElement) {
              const cs = getComputedStyle(a);
              if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && a.scrollWidth > a.clientWidth + 1) { scrollable = true; break; }
            }
            if (!scrollable) out.push(`control clipped horizontally: ${name} ${Math.round(r.left)}..${Math.round(r.right)} (viewport ${W})`);
          }
        }
        return out;
      });
      issues.length ? issues.forEach((i) => flag(`[${stage}] ${i}`)) : ok(`[${stage}] no overflow, tap targets ≥24px`);
    };
    const auditPicker = async (mode) => {
      const geo = await M.evaluate(() => {
        const box = document.querySelector("#picker .pickbox").getBoundingClientRect();
        const sw = [...document.querySelectorAll("#picker .swatch")].map((s) => s.getBoundingClientRect());
        return { W: innerWidth, H: innerHeight, box: { l: box.left, r: box.right, t: box.top, b: box.bottom }, minSw: Math.min(...sw.map((s) => Math.min(s.width, s.height))), n: sw.length };
      });
      const fits = geo.box.l >= 0 && geo.box.t >= 0 && geo.box.r <= geo.W + 1 && geo.box.b <= geo.H + 1;
      fits ? ok(`picker fits on screen (${mode}): box within ${geo.W}x${geo.H}, 4 swatches ≥${Math.round(geo.minSw)}px`)
           : bad(`picker overflows viewport (${mode}): ${JSON.stringify(geo.box)} in ${geo.W}x${geo.H}`);
      geo.n === 4 || bad(`picker has ${geo.n} swatches, expected 4`);
      geo.minSw >= 44 || flag(`picker swatch under 44px: ${Math.round(geo.minSw)}px`);
      await M.screenshot({ path: SHOTS + "/mobile-picker.png" });
    };

    await M.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
    await audit("home");
    await M.fill("#nameIn", "Mia");
    await M.tap("#createBtn");
    await M.waitForSelector("#lobby:not(.hidden)", { timeout: 10000 });
    for (let i = 0; i < 2; i++) { await M.tap("#addBotBtn"); await M.waitForTimeout(300); }
    await M.waitForFunction(() => S.room.players.length === 3, null, { timeout: 5000 });
    ok("create + 2 bots by touch");
    await audit("lobby");
    await M.tap("#startBtn");
    await M.waitForSelector("#game:not(.hidden)", { timeout: 10000 });
    await M.waitForSelector("#hand .hcard", { timeout: 10000 });
    ok("Deal by touch → game + hand rendered");

    let plays = 0, draws = 0, pickerLive = false;
    const stop = Date.now() + 60000;
    while (Date.now() < stop && (plays + draws) < 8) {
      const st = await snap(M);
      if (st.status !== "playing") break;
      if (st.turn !== st.mySeat) { await M.waitForTimeout(350); continue; }
      if (st.phase === "drawn") { await M.tap("#playDrawnBtn"); plays++; }
      else if (st.legal.length) {
        const wildIdx = st.legal.find((i) => st.hand[i] === "w");
        const i = wildIdx !== undefined ? wildIdx : st.legal[0];
        await M.tap(`#hand .hcard[data-i="${i}"]`);
        if (wildIdx !== undefined) {
          await M.waitForSelector("#picker:not(.hidden)", { timeout: 4000 });
          await auditPicker("live"); pickerLive = true;
          await M.tap('#picker .swatch[data-c="b"]');
          await M.waitForFunction(() => document.getElementById("picker").classList.contains("hidden"), null, { timeout: 4000 });
        }
        plays++;
      } else { await M.tap("#drawpile"); draws++; }
      await M.waitForTimeout(600);
    }
    (plays + draws) >= 2 ? ok(`cards tappable by touch (${plays} plays, ${draws} draws)`) : bad("touch taps not registering on cards/draw pile");
    await audit("mid-game");
    await M.screenshot({ path: SHOTS + "/mobile-midgame.png" });
    if (!pickerLive) {
      // no wild came up in the short window — unhide the overlay for a layout-only measurement, then restore
      await M.evaluate(() => document.getElementById("picker").classList.remove("hidden"));
      await auditPicker("layout-only; no wild came up in the play window");
      await M.evaluate(() => document.getElementById("picker").classList.add("hidden"));
    }
    await M.tap("#leaveGameBtn").catch(() => {});
    await ctx.close();
  });

  await browser.close();
  console.log("\n════════ UI SUITE SUMMARY ════════");
  for (const r of results)
    console.log(` ${r.errors.length ? "FAIL" : "PASS"}${r.flags.length ? "⚑" : ""}  ${r.title}  (${r.secs}s)` +
      (r.errors.length ? "\n        " + r.errors.join("\n        ") : "") +
      (r.flags.length ? "\n        flags: " + r.flags.join("; ") : ""));
  const failed = results.filter((r) => r.errors.length).length;
  console.log(failed ? `\n=== RESULT: FAIL (${failed} of ${results.length}) ===` : "\n=== RESULT: PASS ===");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
