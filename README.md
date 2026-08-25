# Wild Eights
Crazy-eights family card game for 2-10 players. 108-card deck: numbers,
Skip, Reverse, +2, Wild, Wild +4. Match color or value; draw when stuck
(play-or-keep); reverse acts as skip at 2 players; LAST CARD announced;
discard reshuffles into the deck when it runs dry. Bots, chat, voice,
rejoin, rematch. Hands are private: the server sends each player their
own cards and only counts for everyone else (test/rules.js proves it).

Run: npm install && node server.js     (PORT, TURN_MS, BOT_MS, BASE_PATH)
Deployed at needasix.com/eights behind the arcade proxy (BASE_PATH=/eights).
