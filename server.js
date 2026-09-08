const http = require("http");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const BASE = (process.env.BASE_PATH || "").replace(/\/$/, "");
if (BASE) app.use((req, res, next) => { if (req.path === BASE) return res.redirect(301, BASE + "/"); next(); });
app.use(BASE || "/", express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
const io = new Server(server, { path: BASE + "/socket.io", cors: { origin: true } });

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;
const TURN_MS = Number(process.env.TURN_MS || 30000);
const AFK_MS = Math.max(200, Number(process.env.AFK_MS || 5000));   // T1: turn clock while the current player is disconnected
const TIMEOUTS_TO_BOT = 3;                                              // consecutive timeouts before a bot takes the seat
const BOT_MS = Math.max(1, Number(process.env.BOT_MS || 900));

const rooms = new Map();
const roomSockets = new Map();
const timers = new Map();
const botTimers = new Map();

const newId = () => crypto.randomBytes(8).toString("hex");
const newCode = () => {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = "";
  for (let i = 0; i < 6; i++) c += A[crypto.randomInt(A.length)];
  return rooms.has(c) ? newCode() : c;
};
const BOT_NAMES = ["Robo", "Chip", "Bolt", "Dicey", "Turbo", "Pixel", "Gizmo", "Widget", "Servo", "Nutmeg"];
const clean = (s, n) => String(s || "").replace(/[<>]/g, "").trim().slice(0, n);
const COLORS = ["r", "g", "y", "b"];

function freshDeck() {
  const d = [];
  for (const c of COLORS) {
    d.push({ c, v: "0" });
    for (let n = 1; n <= 9; n++) { d.push({ c, v: String(n) }); d.push({ c, v: String(n) }); }
    for (const v of ["S", "R", "+2"]) { d.push({ c, v }); d.push({ c, v }); }
  }
  for (let i = 0; i < 4; i++) { d.push({ c: "w", v: "W" }); d.push({ c: "w", v: "+4" }); }
  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function clearT(map, code) { const t = map.get(code); if (t) { clearTimeout(t); map.delete(code); } }
function deleteRoom(code) { clearT(timers, code); clearT(botTimers, code); rooms.delete(code); roomSockets.delete(code); }
function seated(room) { return room.players.filter((p) => !p.left); }
function shuffleArr(a) { for (let k = a.length - 1; k > 0; k--) { const j = crypto.randomInt(k + 1); [a[k], a[j]] = [a[j], a[k]]; } return a; }
/* T6: nobody can draw and the current player has no legal card → the round ends now, lowest hand wins. */
function endRoundStuck(room) {
  const act = activeSeats(room);
  const best = act.slice().sort((a, b) => room.hands[a].length - room.hands[b].length || a - b)[0];
  room.winner = best;
  room.status = "over"; room.phase = "over";
  room.standings = room.players.map((q, i) => ({ seat: i, cards: room.hands[i].length, left: q.left })).sort((a, b) => a.cards - b.cards);
  room.log = `No cards left to draw and nothing to play — round over. ${room.players[best].name} has the fewest cards and wins!`;
  clearT(timers, room.code); clearT(botTimers, room.code);
}

function setupGame(room) {
  room.deck = freshDeck();
  room.discard = [];
  room.hands = room.players.map(() => []);
  room.players.forEach((p) => { p.left = p.left || false; });
  for (let k = 0; k < 7; k++) for (let i = 0; i < room.players.length; i++) if (!room.players[i].left) room.hands[i].push(room.deck.pop());
  let top = room.deck.pop();
  while (top.c === "w" || ["S", "R", "+2"].includes(top.v)) { room.deck.unshift(top); top = room.deck.pop(); }
  room.discard.push(top);
  room.color = top.c;
  room.dir = 1;
  const seats = room.players.map((p, i) => (!p.left ? i : -1)).filter((i) => i >= 0);
  room.turn = seats[crypto.randomInt(seats.length)];
  room.phase = "turn";
  room.drawn = null;      // card index in hand pending play/keep
  room.lastPlay = null;   // { seat, card|null, drew, effect }
  room.winner = null;
  room.standings = null;
  room.status = "playing";
  room.log = `${room.players[room.turn].name} goes first. Match the color or the number.`;
  armTimer(room.code);
}

function nextSeat(room, from, steps) {
  const n = room.players.length;
  let s = from;
  let moved = 0;
  while (moved < steps) {
    s = (s + room.dir + n) % n;
    const p = room.players[s];
    if (p && !p.left && room.hands[s].length >= 0 && !p.done) moved++;
    if (s === from && moved === 0) break;
  }
  return s;
}
function activeSeats(room) {
  return room.players.map((p, i) => (!p.left && !p.done ? i : -1)).filter((i) => i >= 0);
}

function drawCards(room, seat, n) {
  const got = [];
  for (let i = 0; i < n; i++) {
    if (room.deck.length === 0) {
      if (room.discard.length > 1) {
        const top = room.discard.pop();
        room.deck = room.discard;
        room.discard = [top];
        for (let k = room.deck.length - 1; k > 0; k--) {
          const j = crypto.randomInt(k + 1);
          [room.deck[k], room.deck[j]] = [room.deck[j], room.deck[k]];
        }
      } else break;
    }
    const card = room.deck.pop();
    if (card) { room.hands[seat].push(card); got.push(card); }
  }
  return got.length;
}

function legalIdx(room, seat) {
  const top = room.discard[room.discard.length - 1];
  return room.hands[seat].map((card, i) => {
    if (card.c === "w") return i;
    if (card.c === room.color) return i;
    if (card.v === top.v) return i;
    return -1;
  }).filter((i) => i >= 0);
}

function endTurnAdvance(room, skipNext, drawNextN) {
  let target = nextSeat(room, room.turn, 1);
  if (drawNextN) {
    const got = drawCards(room, target, drawNextN);
    room.lastPlay = { ...(room.lastPlay || {}), victim: target, victimDrew: got };
  }
  if (skipNext) target = nextSeat(room, target, 1);
  room.turn = target;
  room.phase = "turn";
  room.drawn = null;
}

function playCard(room, seat, idx, colorPick) {
  const hand = room.hands[seat];
  const card = hand[idx];
  if (!card) return false;
  const top = room.discard[room.discard.length - 1];
  const legal = card.c === "w" || card.c === room.color || card.v === top.v;
  if (!legal) return false;
  if (card.c === "w" && !COLORS.includes(colorPick)) return false;
  hand.splice(idx, 1);
  room.discard.push(card);
  room.color = card.c === "w" ? colorPick : card.c;
  const pl = room.players[seat];
  room.lastPlay = { seat, card, drew: 0 };
  let skip = false, drawN = 0, msg = `${pl.name} played ${cardName(card)}.`;
  if (card.v === "S") { skip = true; msg = `${pl.name} played Skip.`; }
  if (card.v === "R") {
    if (activeSeats(room).length > 2) { room.dir *= -1; msg = `${pl.name} reversed the direction!`; }
    else { skip = true; msg = `${pl.name} played Reverse — acts as Skip.`; }
  }
  if (card.v === "+2") { skip = true; drawN = 2; msg = `${pl.name} played +2.`; }
  if (card.v === "+4") { skip = true; drawN = 4; msg = `${pl.name} played WILD +4 and picked ${colorName(colorPick)}.`; }
  if (card.v === "W") { msg = `${pl.name} played WILD and picked ${colorName(colorPick)}.`; }

  if (hand.length === 1) msg += ` LAST CARD!`;
  if (hand.length === 0) {
    pl.done = true;
    room.winner = seat;
    room.status = "over";
    room.phase = "over";
    room.standings = room.players.map((q, i) => ({ seat: i, cards: room.hands[i].length, left: q.left }))
      .sort((a, b) => a.cards - b.cards);
    room.log = `${pl.name} is out of cards — ${pl.name.toUpperCase()} WINS! 🎉`;
    clearT(timers, room.code); clearT(botTimers, room.code);
    return true;
  }
  room.log = msg;
  endTurnAdvance(room, skip, drawN);
  return true;
}

function cardName(card) {
  const names = { S: "Skip", R: "Reverse", "+2": "+2", W: "Wild", "+4": "Wild +4" };
  const base = names[card.v] || card.v;
  return card.c === "w" ? base : `${colorName(card.c)} ${base}`;
}
function colorName(c) { return { r: "Red", g: "Green", y: "Yellow", b: "Blue" }[c] || c; }

function doDraw(room, seat) {
  const got = drawCards(room, seat, 1);
  if (!got) { // no cards anywhere: the round cannot continue (T6)
    endRoundStuck(room);
    return;
  }
  room.lastPlay = { seat, card: null, drew: 1 };
  const hand = room.hands[seat];
  const idx = hand.length - 1;
  const card = hand[idx];
  const top = room.discard[room.discard.length - 1];
  const playable = card.c === "w" || card.c === room.color || card.v === top.v;
  if (playable) {
    room.phase = "drawn";
    room.drawn = idx;
    room.log = `${room.players[seat].name} drew a card… and it's playable!`;
  } else {
    room.log = `${room.players[seat].name} drew a card.`;
    endTurnAdvance(room, false, 0);
  }
}

/* ---------- per-player filtered state: hands stay private ---------- */
function stateFor(room, seat) {
  const over = room.status === "over";
  return {
    code: room.code, status: room.status, phase: room.phase,
    turn: room.turn, dir: room.dir, color: room.color,
    top: room.discard ? room.discard[room.discard.length - 1] : null,
    deckCount: room.deck ? room.deck.length : 0,
    log: room.log, winner: room.winner, standings: room.standings,
    hostSeat: room.players.findIndex((p) => p.id === room.host),
    lastPlay: room.lastPlay, phaseEndsAt: room.phaseEndsAt || null,
    maxPlayers: MAX_PLAYERS,
    players: room.players.map((p, i) => ({
      name: p.name, avatar: p.avatar, bot: !!p.bot, botControlled: !!p.botControlled, left: p.left, connected: p.connected,
      count: room.hands ? room.hands[i].length : 0,
    })),
    yourHand: room.hands && seat >= 0 ? room.hands[seat] : [],
    yourLegal: room.status === "playing" && seat === room.turn && room.phase === "turn" ? legalIdx(room, seat) : [],
    drawnIdx: seat === room.turn && room.phase === "drawn" ? room.drawn : null,
    voice: room.voice ? Array.from(room.voice) : [],
    chat: (room.chat || []).slice(-60),
  };
}
function bump(room) { room.v = (room.v || 0) + 1; room.touched = Date.now(); sendState(room.code); }

/* ---------- GameNest push (optional; no-op without PUSH_URL) ----------
   The app registers a device token per socket and reports presence; players who are away or disconnected
   get a push when it becomes their turn / a new phase starts, and when someone writes in chat. */
const PUSH_URL = process.env.PUSH_URL || "";
const PUSH_TITLE = 'Plus Four';
function pushTo(p, body, data, collapse) {
  if (!PUSH_URL || !p || !p.pushToken || p.bot || p.left) return;
  if (!(p.away || !p.connected)) return;
  const now = Date.now(); if (p._lastPush && now - p._lastPush < 4000) return; p._lastPush = now;
  fetch(PUSH_URL + "/notify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: p.pushToken, title: PUSH_TITLE, body, data: data || {}, collapse: collapse || undefined }) }).catch(() => {});
}
function pushTurn(room) {   // called after every state broadcast; only fires when the situation changes
  const key = room.status + "|" + room.turn;
  if (room._pushKey === key) return; room._pushKey = key;
  if (room.status !== "playing") return;
  const p = room.players[room.turn]; if (!p) return;
  pushTo(p, "Your turn in " + PUSH_TITLE + " — room " + room.code, { code: room.code, game: PUSH_TITLE }, room.code + "-turn");
}

function sendState(code) {
  const room = rooms.get(code);
  const socks = roomSockets.get(code);
  if (!room || !socks) return;
  for (const s of socks) {
    const seat = room.players.findIndex((p) => p.id === s.data.playerId);
    s.emit("state", { room: stateFor(room, seat), mySeat: seat, v: room.v });
    try { pushTurn(room); } catch (_) {}
  }
}

function armTimer(code) {
  const room = rooms.get(code);
  clearT(timers, code);
  scheduleBot(code);
  if (!room || room.status !== "playing") return;
  const cur = room.players[room.turn];
  const ms = cur && !cur.bot && !cur.botControlled && !cur.connected ? AFK_MS : TURN_MS;
  room.phaseEndsAt = Date.now() + ms;
  timers.set(code, setTimeout(() => onTurnTimeout(code), ms));
}

/* T1 AFK policy: a timed-out turn is auto-played with the bot heuristic instead of skipped;
   three consecutive timeouts hand the seat to the bot until the human acts or reconnects. */
function onTurnTimeout(code) {
  const r = rooms.get(code);
  if (!r || r.status !== "playing") return;
  const pl = r.players[r.turn];
  if (!pl) return;
  let note = "";
  if (!pl.bot && !pl.botControlled) {
    pl.timeouts = (pl.timeouts || 0) + 1;
    if (pl.timeouts >= TIMEOUTS_TO_BOT) { pl.botControlled = true; note = `A bot is playing for ${pl.name} (timed out ${TIMEOUTS_TO_BOT} times).`; }
    else note = `${pl.name} ran out of time; the turn was played for them.`;
  }
  botAct(r);
  if (note) r.log = `${note} ${r.log || ""}`.trim();
  bump(r);
  if (r.status === "playing") armTimer(code);
}

/* The human acts (or reconnects): take the seat back from the bot and reset the timeout streak. */
function humanIsBack(room, p, reason) {
  const wasBot = !!p.botControlled;
  p.timeouts = 0;
  if (!wasBot) return false;
  p.botControlled = false;
  room.log = `${p.name} is back at the table${reason ? " (" + reason + ")" : ""}.`;
  if (room.status === "playing" && room.players[room.turn] === p) { clearT(botTimers, room.code); armTimer(room.code); }
  return true;
}

/* ---------- bots ---------- */
function addBotTo(room) {
  if (room.players.length >= MAX_PLAYERS) return null;
  const used = room.players.map((q) => q.name);
  const name = BOT_NAMES.find((n) => !used.includes(n)) || "Bot" + (room.players.length + 1);
  const p = { id: "bot_" + newId(), name, avatar: "\u{1F916}", bot: true, left: false, connected: true };
  room.players.push(p);
  return p;
}
function scheduleBot(code) {
  clearT(botTimers, code);
  const room = rooms.get(code);
  if (!room || room.status !== "playing") return;
  const p = room.players[room.turn];
  if (!p || !(p.bot || p.botControlled)) return;
  botTimers.set(code, setTimeout(() => {
    const r = rooms.get(code);
    if (!r || r.status !== "playing") return;
    const cur = r.players[r.turn];
    if (!cur || !(cur.bot || cur.botControlled)) return;
    botAct(r);
    bump(r);
    if (r.status === "playing") armTimer(code);
  }, BOT_MS + crypto.randomInt(BOT_MS)));
}
function botColorPick(room, seat) {
  const tally = { r: 0, g: 0, y: 0, b: 0 };
  for (const card of room.hands[seat]) if (card.c !== "w") tally[card.c]++;
  return COLORS.reduce((a, b) => (tally[a] >= tally[b] ? a : b));
}
/* T9: bot priorities, first match wins.
   1. the next player is on 1–2 cards → punish: +4, +2, Skip, Reverse (first that is legal)
   2. a number card in the colour the bot holds most of
   3. an action card in that colour
   4. a wild, naming the dominant colour
   5. draw.
   "Last card" is announced by the server for everyone (playCard), so bots never forget to call it. */
function botChoose(room, seat) {
  const hand = room.hands[seat];
  const legal = legalIdx(room, seat);
  if (!legal.length) return null;
  const tally = { r: 0, g: 0, y: 0, b: 0 };
  for (const card of hand) if (card.c !== "w") tally[card.c]++;
  const dom = botColorPick(room, seat);
  const isNum = (i) => /^[0-9]$/.test(hand[i].v);
  const byColour = (idxs) => idxs.slice().sort((a, b) => tally[hand[b].c] - tally[hand[a].c] || a - b);
  const next = nextSeat(room, seat, 1);
  if (next !== seat && room.hands[next] && room.hands[next].length <= 2) {
    for (const v of ["+4", "+2", "S", "R"]) {
      const i = legal.find((k) => hand[k].v === v);
      if (i != null) return { idx: i, color: hand[i].c === "w" ? dom : null };
    }
  }
  const nums = byColour(legal.filter((i) => hand[i].c !== "w" && isNum(i)));
  if (nums.length) return { idx: nums[0], color: null };
  const acts = byColour(legal.filter((i) => hand[i].c !== "w" && !isNum(i)));
  if (acts.length) return { idx: acts[0], color: null };
  const wild = legal.find((i) => hand[i].v === "W") ?? legal.find((i) => hand[i].c === "w");
  if (wild != null) return { idx: wild, color: dom };
  return null;
}
function botAct(room) {
  const seat = room.turn;
  if (room.phase === "drawn") {
    const idx = room.drawn;
    const card = room.hands[seat][idx];
    const pick = card.c === "w" ? botColorPick(room, seat) : null;
    playCard(room, seat, idx, pick);
    return;
  }
  const choice = botChoose(room, seat);
  if (!choice) { doDraw(room, seat); if (room.phase === "drawn") botAct(room); return; }
  playCard(room, seat, choice.idx, choice.color);
}

/* ---------- sockets ---------- */

/* T3: the host seat follows the humans — first connected human, else first human still seated, else unchanged. */
function ensureHost(room) {
  const cur = room.players.find((p) => p.id === room.host);
  if (cur && !cur.bot && !cur.left && cur.connected) return false;
  const next = room.players.find((p) => !p.bot && !p.left && p.connected) || room.players.find((p) => !p.bot && !p.left);
  if (!next || next.id === room.host) return false;
  room.host = next.id;
  room.log = `${next.name} is now the host.`;
  return true;
}

io.on("connection", (socket) => {
  socket.data.playerId = null;
  socket.data.code = null;
  const currentRoom = () => rooms.get(socket.data.code);
  const attach = (code) => {
    socket.data.code = code;
    if (!roomSockets.has(code)) roomSockets.set(code, new Set());
    roomSockets.get(code).add(socket);
  };
  const detach = () => {
    const set = roomSockets.get(socket.data.code);
    if (set) set.delete(socket);
    socket.data.code = null;
  };

  socket.on("create", ({ name, playerId, avatar } = {}) => {
    name = clean(name, 18); if (!name) return socket.emit("err", "Pick a name first.");
    const code = newCode();
    const room = { code, status: "lobby", host: playerId, players: [], chat: [], log: "", v: 1,
      touched: Date.now(), voice: new Set(), phase: "lobby" };
    room.players.push({ id: playerId, name, avatar: clean(avatar, 4) || "\u{1F0CF}", bot: false, left: false, connected: true });
    rooms.set(code, room);
    socket.data.playerId = playerId;
    attach(code);
    socket.emit("joined", { code });
    bump(room);
  });

  socket.on("join", ({ code, name, playerId, avatar } = {}) => {
    code = clean(code, 6).toUpperCase();
    const room = rooms.get(code);
    if (!room) return socket.emit("err", "No room with that code.");
    socket.data.playerId = playerId;
    const existing = room.players.find((p) => p.id === playerId);
    if (existing) { existing.connected = true; existing.left = false; humanIsBack(room, existing, "reconnected"); attach(code); socket.emit("joined", { code }); bump(room); if (room.status === "playing" && room.players[room.turn] === existing) armTimer(code); return; }
    if (room.status !== "lobby") return socket.emit("err", "That game already started.");
    if (room.players.length >= MAX_PLAYERS) return socket.emit("err", "Room is full (10).");
    name = clean(name, 18); if (!name) return socket.emit("err", "Pick a name first.");
    room.players.push({ id: playerId, name, avatar: clean(avatar, 4) || "\u{1F0CF}", bot: false, left: false, connected: true });
    attach(code);
    socket.emit("joined", { code });
    room.log = `${name} joined.`;
    bump(room);
  });

  socket.on("addBot", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
    const b = addBotTo(room);
    if (b) { room.log = `${b.name} (bot) joined.`; bump(room); }
  });
  socket.on("removeBot", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
    for (let i = room.players.length - 1; i >= 0; i--) if (room.players[i].bot) { room.players.splice(i, 1); break; }
    bump(room);
  });

  socket.on("start", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
    if (room.players.filter((p) => !p.left).length < 2) return socket.emit("err", "Need at least 2 players — add a bot.");
    room.players.forEach((p) => { p.done = false; });
    setupGame(room);
    bump(room);
  });

  if (process.env.TEST_HOOKS === "1") socket.on("__test", ({ emptyDeck, discardTopOnly, hands } = {}) => {   // test-only: craft a stuck position
    const room = currentRoom(); if (!room || room.status !== "playing") return;
    if (emptyDeck) room.deck = [];
    if (discardTopOnly) room.discard = room.discard.slice(-1);
    if (hands && typeof hands === "object") for (const [seat, cards] of Object.entries(hands)) if (room.hands[Number(seat)] && Array.isArray(cards)) room.hands[Number(seat)] = cards.map((c) => ({ c: String(c.c), v: String(c.v) }));
    bump(room);
  });

  socket.on("play", ({ i, color } = {}) => {
    const room = currentRoom();
    if (!room || room.status !== "playing") return;
    const self = room.players.find((q) => q.id === socket.data.playerId);
    if (self && humanIsBack(room, self, "took the seat back")) bump(room);   // any action reclaims a bot-controlled seat
    const seat = room.players.findIndex((p) => p.id === socket.data.playerId);
    if (seat !== room.turn) return;
    if (room.phase === "drawn" && i !== room.drawn) return;
    if (!Number.isInteger(i)) return;
    if (playCard(room, seat, i, color)) { bump(room); if (room.status === "playing") armTimer(room.code); }
  });

  socket.on("draw", () => {
    const room = currentRoom();
    if (!room || room.status !== "playing") return;
    const self = room.players.find((q) => q.id === socket.data.playerId);
    if (self && humanIsBack(room, self, "took the seat back")) bump(room);   // any action reclaims a bot-controlled seat
    if (room.phase !== "turn") return;
    const seat = room.players.findIndex((p) => p.id === socket.data.playerId);
    if (seat !== room.turn) return;
    doDraw(room, seat);
    bump(room);
    if (room.status === "playing") armTimer(room.code);
  });

  socket.on("keep", () => {
    const room = currentRoom();
    if (!room || room.status !== "playing") return;
    const self = room.players.find((q) => q.id === socket.data.playerId);
    if (self && humanIsBack(room, self, "took the seat back")) bump(room);   // any action reclaims a bot-controlled seat
    if (room.phase !== "drawn") return;
    const seat = room.players.findIndex((p) => p.id === socket.data.playerId);
    if (seat !== room.turn) return;
    room.log = `${room.players[seat].name} kept the card.`;
    endTurnAdvance(room, false, 0);
    bump(room);
    armTimer(room.code);
  });
  socket.on("takeSeat", () => {
    const room = currentRoom(); if (!room) return;
    const self = room.players.find((q) => q.id === socket.data.playerId);
    if (self && humanIsBack(room, self, "took the seat back")) bump(room);
  });
  socket.on("pushToken", ({ token } = {}) => { const room = currentRoom(); if (!room) return; const p = room.players.find((q) => q.id === socket.data.playerId); if (p && typeof token === "string" && /^[0-9a-f]{32,200}$/i.test(token)) p.pushToken = token; });
  socket.on("presence", ({ away } = {}) => { const room = currentRoom(); if (!room) return; const p = room.players.find((q) => q.id === socket.data.playerId); if (p) p.away = !!away; });


  socket.on("chat", ({ t } = {}) => {
    const room = currentRoom();
    if (!room) return;
    const seat = room.players.findIndex((p) => p.id === socket.data.playerId);
    const me = room.players[seat];
    if (!me || me.left) return;
    const now = Date.now();
    if (me._lastChat && now - me._lastChat < 700) return;
    me._lastChat = now;
    t = clean(t, 140); if (!t) return;
    room.chat.push({ n: me.name, a: me.avatar, t }); for (const q of room.players) if (q !== me) pushTo(q, me.name + ": " + t, { code: room.code, game: PUSH_TITLE }, room.code + "-chat");
    if (room.chat.length > 200) room.chat.splice(0, room.chat.length - 200);
    bump(room);
  });

  socket.on("voice", ({ kind, to, data } = {}) => {
    const room = currentRoom();
    if (!room) return;
    const seat = room.players.findIndex((p) => p.id === socket.data.playerId);
    if (seat < 0) return;
    if (kind === "join" || kind === "leave") {
      if (!room.voice) room.voice = new Set();
      if (kind === "join") room.voice.add(seat); else room.voice.delete(seat);
      bump(room);
      return;
    }
    if (kind === "signal" && Number.isInteger(to) && data) {
      let size = 0; try { size = JSON.stringify(data).length; } catch (e) { return; }
      if (size > 20000) return;
      const socks = roomSockets.get(room.code);
      if (!socks) return;
      for (const s of socks) {
        const sSeat = room.players.findIndex((p) => p.id === s.data.playerId);
        if (sSeat === to) s.emit("voice", { kind: "signal", from: seat, data });
      }
    }
  });

  socket.on("rematch", () => {
    const room = currentRoom();
    if (!room || room.status !== "over" || room.host !== socket.data.playerId) return;
    room.players = room.players.filter((p) => !p.left);
    room.players.forEach((p) => { p.done = false; });
    if (room.players.filter((p) => !p.bot).length === 0) { deleteRoom(room.code); return; }
    if (room.players.length < 2) { room.status = "lobby"; room.phase = "lobby"; room.log = "Back to the lobby."; bump(room); return; }
    setupGame(room);
    bump(room);
  });

  function handleLeave() {
    const room = currentRoom();
    if (!room) return detach();
    const p = room.players.find((q) => q.id === socket.data.playerId);
    if (!p) return detach();
    if (room.voice) room.voice.delete(room.players.indexOf(p));
    if (room.status === "lobby") {
      room.players = room.players.filter((q) => q.id !== p.id);
      if (room.players.length === 0 || room.players.every((q) => q.bot)) { detach(); deleteRoom(room.code); return; }
      if (room.host === p.id) room.host = (room.players.find((q) => !q.bot) || room.players[0]).id;
      room.log = `${p.name} left.`;
    } else {
      const seat = room.players.indexOf(p);
      p.left = true; p.connected = false;
      if (room.status === "playing" && room.hands && room.hands[seat].length) {   // T6: their cards go back under the draw pile, shuffled
        const back = shuffleArr(room.hands[seat].splice(0));
        room.deck.unshift(...back);
      }
      if (room.players.every((q) => q.bot || q.left)) { detach(); deleteRoom(room.code); return; }
      if (room.host === p.id) room.host = (room.players.find((q) => !q.bot && !q.left) || room.players[0]).id;
      room.log = `${p.name} left the game.`;
      if (room.status === "playing") {
        const act = activeSeats(room);
        if (act.length === 1) {
          room.winner = act[0];
          room.status = "over"; room.phase = "over";
          room.standings = room.players.map((q, i) => ({ seat: i, cards: room.hands[i].length, left: q.left })).sort((a, b) => a.cards - b.cards);
          room.log = `${room.players[act[0]].name} is the last one standing — they win!`;
          clearT(timers, room.code); clearT(botTimers, room.code);
        } else if (room.turn === seat) {
          endTurnAdvance(room, false, 0);
          armTimer(room.code);
        }
      }
    }
    detach();
    bump(room);
  }
  socket.on("leave", () => handleLeave());
  socket.on("disconnect", () => {
    const room = currentRoom();
    if (!room) return;
    const p = room.players.find((q) => q.id === socket.data.playerId);
    if (p) { p.connected = false; if (room.voice) room.voice.delete(room.players.indexOf(p)); ensureHost(room); room.v++; }
    detach();
    if (rooms.has(room.code)) sendState(room.code);
    if (p && rooms.has(room.code) && room.status === "playing" && room.players[room.turn] === p) armTimer(room.code);   // 5 s clock while they are away
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) if (now - room.touched > 2 * 60 * 60 * 1000) deleteRoom(code);
}, 10 * 60 * 1000);

if (require.main === module) server.listen(PORT, () => console.log("Wild Eights running on port " + PORT));
module.exports = { legalIdx, botChoose, botColorPick, nextSeat };
