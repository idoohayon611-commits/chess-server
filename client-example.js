/*
 * EXAMPLE: how to wire your existing board UI up to this server.
 * Include socket.io-client in your webpage (via CDN or npm), then adapt
 * this to call into whatever functions your board UI already has for
 * drawing pieces / highlighting moves.
 *
 * CDN tag to add to your HTML <head>:
 *   <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
 */

const SERVER_URL = 'https://your-server-url.onrender.com'; // change after deploying

let socket = null;
let myColor = null;
let myRoomId = null;

/* ---------- 1. Register or log in ---------- */

async function register(username, password) {
  const res = await fetch(`${SERVER_URL}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data; // { token, username, rating }
}

async function login(username, password) {
  const res = await fetch(`${SERVER_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data; // { token, username, rating }
}

/* ---------- 2. Connect socket with the token you got back ---------- */

function connectSocket(token) {
  socket = io(SERVER_URL, { auth: { token } });

  socket.on('welcome', ({ username, rating }) => {
    console.log(`Connected as ${username} (${rating})`);
  });

  socket.on('searching', () => {
    console.log('Looking for an opponent...');
    // e.g. showSearchingSpinner()
  });

  socket.on('match_found', ({ roomId, color, fen, opponent, yourRating }) => {
    myRoomId = roomId;
    myColor = color;
    console.log(`Match found! You are ${color} vs ${opponent.username} (${opponent.rating})`);
    // e.g. yourBoardUI.setPosition(fen);
    // e.g. yourBoardUI.setOrientation(color);
    // e.g. yourBoardUI.setDraggable(color === 'white'); // only allowed to move on your turn
  });

  socket.on('move_made', ({ from, to, san, fen, turn }) => {
    // e.g. yourBoardUI.setPosition(fen);
    // e.g. yourBoardUI.setDraggable(turn === myColor);
    console.log(`Move: ${san}`);
  });

  socket.on('illegal_move', ({ reason }) => {
    console.log('Illegal move:', reason || 'not legal');
    // e.g. yourBoardUI.snapBackPiece();
  });

  socket.on('game_over', ({ result, reason, ratings }) => {
    console.log(`Game over: ${result} (${reason})`);
    console.log(`Your new rating: ${myColor === 'white' ? ratings.white.after : ratings.black.after}`);
    myRoomId = null;
    myColor = null;
  });

  socket.on('draw_offered', () => {
    // e.g. show "opponent offers a draw" prompt with accept button
  });
}

/* ---------- 3. Hook these into your board UI's existing events ---------- */

function findMatch() {
  socket.emit('find_match');
}

// Call this from your board UI's "on piece dropped" handler.
function sendMove(from, to, promotion) {
  socket.emit('move', { roomId: myRoomId, from, to, promotion });
}

function resign() {
  socket.emit('resign', { roomId: myRoomId });
}

function offerDraw() {
  socket.emit('offer_draw', { roomId: myRoomId });
}

function acceptDraw() {
  socket.emit('accept_draw', { roomId: myRoomId });
}
