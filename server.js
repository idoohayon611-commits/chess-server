/* =========================================================================
 * CHESS MULTIPLAYER SERVER — all-in-one file
 * (database setup, Elo rating math, and the Express/Socket.io server)
 * ========================================================================= */

require('dotenv').config();
const path = require('path');
const express = require('express');
const http = require('http');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const Database = require('better-sqlite3');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-production';
const PORT = process.env.PORT || 3000;

/* =========================================================================
 * SECTION 1: DATABASE
 * SQLite file lives next to this script. On most hosts (Render, Fly.io)
 * you'll want this on a persistent disk/volume so ratings survive restarts —
 * see README.md for exact setup.
 * ========================================================================= */

const db = new Database(path.join(__dirname, 'chess.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    rating INTEGER NOT NULL DEFAULT 1200,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    white_id INTEGER NOT NULL,
    black_id INTEGER NOT NULL,
    result TEXT NOT NULL,          -- '1-0', '0-1', '1/2-1/2'
    white_rating_before INTEGER NOT NULL,
    black_rating_before INTEGER NOT NULL,
    white_rating_after INTEGER NOT NULL,
    black_rating_after INTEGER NOT NULL,
    pgn TEXT,
    finished_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (white_id) REFERENCES users(id),
    FOREIGN KEY (black_id) REFERENCES users(id)
  );
`);

/* =========================================================================
 * SECTION 2: ELO RATING MATH
 * Standard Elo update, K=32 (a common default for online club-level play).
 * ========================================================================= */

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

function updateRatings(whiteRating, blackRating, result, K = 32) {
  // result is from white's perspective: 1 = win, 0.5 = draw, 0 = loss
  const expectedWhite = expectedScore(whiteRating, blackRating);
  const expectedBlack = 1 - expectedWhite;

  const newWhite = Math.round(whiteRating + K * (result - expectedWhite));
  const newBlack = Math.round(blackRating + K * ((1 - result) - expectedBlack));

  return { newWhite, newBlack };
}

/* =========================================================================
 * SECTION 3: SERVER — REST auth routes + Socket.io matchmaking/gameplay
 * ========================================================================= */

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

/* ---- Auth: plain REST endpoints. Your board UI calls these first, gets a
   JWT back, then connects to Socket.io with that token. ---- */

app.post('/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || username.length < 3 || password.length < 6) {
    return res.status(400).json({ error: 'Username (3+ chars) and password (6+ chars) required.' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);

  const token = jwt.sign({ id: info.lastInsertRowid, username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username, rating: 1200 });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: user.username, rating: user.rating });
});

app.get('/leaderboard', (req, res) => {
  const rows = db.prepare('SELECT username, rating, wins, losses, draws FROM users ORDER BY rating DESC LIMIT 50').all();
  res.json(rows);
});

/* ---- Socket.io: matchmaking + live gameplay ---- */

// waitingQueue holds sockets looking for a game: [{ socket, user }]
let waitingQueue = [];

// games keyed by roomId -> { chess, white: {socket,user}, black: {...} }
const games = new Map();

function getUserRow(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function authenticate(socket, next) {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('No auth token provided'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = getUserRow(payload.id);
    if (!user) return next(new Error('User no longer exists'));
    socket.user = user;
    next();
  } catch (err) {
    next(new Error('Invalid or expired token'));
  }
}

io.use(authenticate);

function tryMatchmake() {
  while (waitingQueue.length >= 2) {
    const p1 = waitingQueue.shift();
    const p2 = waitingQueue.shift();

    // if either socket disconnected while waiting, drop it and retry
    if (!p1.socket.connected) { continue; }
    if (!p2.socket.connected) { waitingQueue.unshift(p1); continue; }

    startGame(p1, p2);
  }
}

function startGame(p1, p2) {
  // randomize colors
  const [whiteEntry, blackEntry] = Math.random() < 0.5 ? [p1, p2] : [p2, p1];
  const roomId = `game_${whiteEntry.socket.id}_${blackEntry.socket.id}_${Date.now()}`;
  const chess = new Chess();

  games.set(roomId, {
    chess,
    white: whiteEntry,
    black: blackEntry,
  });

  whiteEntry.socket.join(roomId);
  blackEntry.socket.join(roomId);
  whiteEntry.socket.data.roomId = roomId;
  blackEntry.socket.data.roomId = roomId;

  const payloadFor = (color) => ({
    roomId,
    color,
    fen: chess.fen(),
    opponent: {
      username: color === 'white' ? blackEntry.socket.user.username : whiteEntry.socket.user.username,
      rating: color === 'white' ? blackEntry.socket.user.rating : whiteEntry.socket.user.rating,
    },
    yourRating: color === 'white' ? whiteEntry.socket.user.rating : blackEntry.socket.user.rating,
  });

  whiteEntry.socket.emit('match_found', payloadFor('white'));
  blackEntry.socket.emit('match_found', payloadFor('black'));
}

function endGame(roomId, result, reason) {
  const game = games.get(roomId);
  if (!game) return;

  const whiteUser = getUserRow(game.white.socket.user.id);
  const blackUser = getUserRow(game.black.socket.user.id);

  // result: 1 = white win, 0 = black win, 0.5 = draw
  const { newWhite, newBlack } = updateRatings(whiteUser.rating, blackUser.rating, result);

  db.prepare('UPDATE users SET rating = ?, wins = wins + ?, losses = losses + ?, draws = draws + ? WHERE id = ?')
    .run(newWhite, result === 1 ? 1 : 0, result === 0 ? 1 : 0, result === 0.5 ? 1 : 0, whiteUser.id);
  db.prepare('UPDATE users SET rating = ?, wins = wins + ?, losses = losses + ?, draws = draws + ? WHERE id = ?')
    .run(newBlack, result === 0 ? 1 : 0, result === 1 ? 1 : 0, result === 0.5 ? 1 : 0, blackUser.id);

  const resultStr = result === 1 ? '1-0' : result === 0 ? '0-1' : '1/2-1/2';
  db.prepare(`INSERT INTO games (white_id, black_id, result, white_rating_before, black_rating_before, white_rating_after, black_rating_after, pgn)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(whiteUser.id, blackUser.id, resultStr, whiteUser.rating, blackUser.rating, newWhite, newBlack, game.chess.pgn());

  io.to(roomId).emit('game_over', {
    result: resultStr,
    reason,
    ratings: {
      white: { username: whiteUser.username, before: whiteUser.rating, after: newWhite },
      black: { username: blackUser.username, before: blackUser.rating, after: newBlack },
    },
  });

  games.delete(roomId);
}

io.on('connection', (socket) => {
  socket.emit('welcome', { username: socket.user.username, rating: socket.user.rating });

  socket.on('find_match', () => {
    // avoid double-queueing
    if (waitingQueue.some((e) => e.socket.id === socket.id)) return;
    waitingQueue.push({ socket, user: socket.user });
    socket.emit('searching');
    tryMatchmake();
  });

  socket.on('cancel_search', () => {
    waitingQueue = waitingQueue.filter((e) => e.socket.id !== socket.id);
  });

  socket.on('move', ({ roomId, from, to, promotion }) => {
    const game = games.get(roomId);
    if (!game) return;

    const isWhite = game.white.socket.id === socket.id;
    const isBlack = game.black.socket.id === socket.id;
    if (!isWhite && !isBlack) return;

    const turnColor = game.chess.turn() === 'w' ? 'white' : 'black';
    if ((turnColor === 'white' && !isWhite) || (turnColor === 'black' && !isBlack)) {
      return socket.emit('illegal_move', { reason: 'Not your turn' });
    }

    let move;
    try {
      move = game.chess.move({ from, to, promotion: promotion || 'q' });
    } catch (err) {
      move = null;
    }

    if (!move) {
      return socket.emit('illegal_move', { from, to });
    }

    io.to(roomId).emit('move_made', {
      from: move.from,
      to: move.to,
      san: move.san,
      fen: game.chess.fen(),
      turn: game.chess.turn() === 'w' ? 'white' : 'black',
    });

    if (game.chess.in_checkmate()) {
      endGame(roomId, turnColor === 'white' ? 1 : 0, 'checkmate');
    } else if (game.chess.in_draw() || game.chess.in_stalemate() || game.chess.in_threefold_repetition()) {
      endGame(roomId, 0.5, 'draw');
    }
  });

  socket.on('resign', ({ roomId }) => {
    const game = games.get(roomId);
    if (!game) return;
    const isWhite = game.white.socket.id === socket.id;
    endGame(roomId, isWhite ? 0 : 1, 'resignation');
  });

  socket.on('offer_draw', ({ roomId }) => {
    const game = games.get(roomId);
    if (!game) return;
    socket.to(roomId).emit('draw_offered');
  });

  socket.on('accept_draw', ({ roomId }) => {
    endGame(roomId, 0.5, 'draw agreed');
  });

  socket.on('disconnect', () => {
    waitingQueue = waitingQueue.filter((e) => e.socket.id !== socket.id);

    const roomId = socket.data.roomId;
    if (roomId && games.has(roomId)) {
      const game = games.get(roomId);
      const isWhite = game.white.socket.id === socket.id;
      // opponent wins by abandonment
      endGame(roomId, isWhite ? 0 : 1, 'opponent disconnected');
    }
  });
});

server.listen(PORT, () => {
  console.log(`Chess server running on port ${PORT}`);
});
