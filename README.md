# Chess multiplayer + rating server

This is the backend that turns your board UI into a real multiplayer site
with accounts and Elo ratings, like chess.com. It doesn't include a board UI —
it plugs into the one you already have.

## What's here

- `server.js` — Express + Socket.io server: accounts, matchmaking queue, live
  move validation (using the same `chess.js` rules engine you already have),
  and Elo rating updates when a game ends.
- `db.js` — SQLite database (`chess.db`) for users, ratings, and game history.
- `elo.js` — standard Elo rating math (K=32), same style chess sites use.
- `client-example.js` — example of how to call this server from your webpage.

## Running it locally

```bash
npm install
node server.js
```

Server starts on `http://localhost:3000`.

## Wiring up your existing board UI

1. Add the Socket.io client to your HTML:
   ```html
   <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
   ```
2. Look at `client-example.js` — it shows the exact sequence:
   register/login → connect socket with the token → `find_match` →
   `match_found` (tells you your color + opponent) → `move` /
   `move_made` events as the game is played → `game_over` with the new
   ratings.
3. Wherever your board UI currently has an "on piece dropped" handler, call
   `sendMove(from, to, promotion)`. Wherever it needs to update the board
   from the server, use the `fen` string sent in `match_found` and
   `move_made` — your board UI can call `chess.load(fen)` (you already have
   chess.js) to get the position and re-render.

The server is authoritative: it validates every move server-side with
chess.js, so a player can't cheat by manipulating their own browser.

## Deploying so anyone can play

You need somewhere that keeps a Node.js process running continuously and
supports WebSockets (this rules out plain static hosts like GitHub Pages for
the backend, though your frontend HTML/CSS/JS can still live there).

### Option A — Render.com (recommended, easiest)

1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com), click **New → Web Service**, connect
   the repo.
3. Build command: `npm install`. Start command: `node server.js`.
4. Add an environment variable `JWT_SECRET` set to some long random string
   (this signs login tokens — keep it secret).
5. Under **Disks**, add a small persistent disk (e.g. 1 GB) mounted at
   `/opt/render/project/src` if you want `chess.db` to survive redeploys —
   otherwise ratings reset every time you push new code. (Alternatively,
   swap SQLite for Render's free Postgres later — ask me if you want that
   version.)
6. Deploy. Render gives you a URL like `https://your-app.onrender.com` —
   that's the `SERVER_URL` your frontend connects to.
7. Free tier sleeps after inactivity (first request after a while takes
   ~30s to wake up). Fine for a hobby project; upgrade to a paid instance
   ($7/mo) to keep it always-on if that matters to you.

### Option B — Railway.app

Similar flow: connect GitHub repo, Railway auto-detects Node, add
`JWT_SECRET` env var, it gives you a persistent volume for the SQLite file
automatically. Usage-based free credits, no sleep.

### Option C — Fly.io

More control, still has a free allowance, but needs a `fly.toml` config and
the Fly CLI — more setup than A/B. Good option if you outgrow Render/Railway.

### Your frontend (the board UI itself)

Since it's static HTML/CSS/JS, you can host it separately and for free on
**GitHub Pages**, **Netlify**, or **Vercel** — just point `SERVER_URL` in
your JS at whichever backend URL you deployed above. Or, simplest of all:
serve it directly from this same Express app by dropping your HTML/CSS/JS
into a `public/` folder here and adding `app.use(express.static('public'))`
to `server.js` — then one deployment covers both frontend and backend.

## Notes / next steps you may want later

- **Timed games (blitz/rapid clocks)** — not included yet; happy to add.
- **Reconnect on refresh** — currently if a player's browser refreshes
  mid-game they lose by abandonment after disconnect; can add a grace-period
  reconnect if you want people to survive a dropped connection.
- **Spectators / game review** — not included; games are stored with full
  PGN in the database though, so a "view past games" page is very doable.
