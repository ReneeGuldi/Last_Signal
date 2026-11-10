// Last Signal multiplayer server
// ------------------------------------------------
// Does two jobs on ONE port:
//   1. Serves the game files (index.html, main.js, models/...) like GitHub Pages did
//   2. Runs a Socket.IO "relay" so every browser can hear about every other player
//
// Run it with:   cd server && npm install && npm start
// Then open:     http://localhost:3000

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';

const PORT = process.env.PORT || 3000; // hosting sites (Render, Railway...) set PORT for you
const GAME_DIR = fileURLToPath(new URL('..', import.meta.url)); // repo root, one folder up

const MIME = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.gltf': 'model/gltf+json',
    '.bin': 'application/octet-stream',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
};

//------------------------------------------------
// 1. Static file server
const httpServer = createServer(async (req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';

    // normalize() + the startsWith check stop "../../" tricks from reading files outside the game
    const filePath = normalize(join(GAME_DIR, urlPath));
    if (!filePath.startsWith(GAME_DIR) || filePath.includes(`${GAME_DIR}server`)) {
        res.writeHead(403).end('Forbidden');
        return;
    }

    try {
        const data = await readFile(filePath);
        res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
        res.end(data);
    } catch {
        res.writeHead(404).end('Not found');
    }
});

//------------------------------------------------
// 2. Socket.IO relay
// Socket.IO sends named events: socket.emit('name', data) on one side
// arrives at socket.on('name', (data) => ...) on the other.
// cors lets the GitHub Pages copy of the game connect to this server too.
const io = new Server(httpServer, { cors: { origin: '*' } });

// socket.id -> { id, socket, state, profile, color }
const players = new Map();
let nextId = 1;
const MAX_PLAYERS = 8;
const MODELS = ['female', 'male'];

// Everything other players need to know about someone
function publicInfo(p) {
    return { id: p.id, ...p.state, ...p.profile, color: p.color };
}

// Players who have said hello (we know their name & character) are the ones others can see
function introduced() {
    return [...players.values()].filter((p) => p.profile);
}

// Lowest color slot nobody is using, so 4 players always get 4 different colors
function freeColor() {
    const used = new Set([...players.values()].map((p) => p.color));
    let c = 0;
    while (used.has(c)) c++;
    return c;
}

// Names come from other people's browsers, so clean them up before sharing
function cleanName(name, id) {
    if (typeof name !== 'string') return `Survivor ${id}`;
    const cleaned = name.replace(/[^\w .'-]/g, '').trim().slice(0, 16);
    return cleaned || `Survivor ${id}`;
}

io.on('connection', (socket) => {
    if (players.size >= MAX_PLAYERS) {
        socket.emit('full');
        socket.disconnect();
        return;
    }

    // our own short number for each player (socket.id is a long random string)
    const player = { id: nextId++, socket, state: { x: 0, y: 2, z: 10, rotY: 0 }, profile: null, color: freeColor() };
    players.set(socket.id, player);
    console.log(`Player ${player.id} connected (${players.size} online)`);

    // Tell the new player who they are, their color, and who is already here
    const others = introduced().filter((p) => p !== player).map(publicInfo);
    socket.emit('welcome', { id: player.id, color: player.color, players: others });

    // name & character choice: first hello = joining, later ones = changing it
    socket.on('hello', (msg) => {
        if (!msg) return;
        const firstTime = !player.profile;
        player.profile = {
            name: cleanName(msg.name, player.id),
            model: MODELS.includes(msg.model) ? msg.model : 'female',
        };
        // socket.broadcast = everyone except this player
        socket.broadcast.emit(firstTime ? 'join' : 'profile', publicInfo(player));
        if (firstTime) console.log(`Player ${player.id} is "${player.profile.name}"`);
    });

    socket.on('state', (msg) => {
        if (!msg) return;
        // Only copy the fields we expect, as numbers, never trust the client blindly
        const s = player.state;
        for (const key of ['x', 'y', 'z', 'rotY']) {
            if (Number.isFinite(msg[key])) s[key] = msg[key];
        }
    });

    socket.on('shot', (msg) => {
        // Cosmetic only for now: lets other players see your tracer
        if (!msg || !player.profile) return;
        socket.broadcast.emit('shot', { id: player.id, from: msg.from, to: msg.to });
    });

    socket.on('disconnect', () => {
        players.delete(socket.id);
        io.emit('leave', { id: player.id });
        console.log(`Player ${player.id} left (${players.size} online)`);
    });
});

//------------------------------------------------
// Send everyone's position out 20 times a second (a "tick")
// Batching like this is much cheaper than forwarding every single message
const TICK_RATE = 20;
setInterval(() => {
    const list = introduced();
    if (list.length < 2) return;
    io.emit('snapshot', list.map(publicInfo));
}, 1000 / TICK_RATE);

httpServer.listen(PORT, () => {
    console.log(`Last Signal running at http://localhost:${PORT}`);
});