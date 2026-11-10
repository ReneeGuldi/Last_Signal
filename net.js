// Last Signal networking (client side)
// ------------------------------------------------
// Connects to the multiplayer server, sends our position, and draws other players
// using the survivor models: hoodie tinted in each player's color, name tag overhead,
// arms and legs swinging while they walk.
// If no server can be reached, the game just stays single-player.

import * as THREE from 'three';
import { io } from 'socket.io-client';

// If the game is opened from the server itself (localhost:3000 or a Render URL), connect back to it.
// If it's opened from GitHub Pages, there's no server there, so use the hosted one below.
// After deploying the server, paste its address here, e.g. 'https://last-signal.onrender.com'
const HOSTED_SERVER_URL = '';

function pickServerUrl() {
    if (location.hostname.endsWith('github.io')) return HOSTED_SERVER_URL || null;
    if (location.protocol === 'file:') return null;
    return location.origin; // the server that gave us this page
}

const SEND_RATE = 15; // how many times per second we send our position
let socket = null;
let myId = null;
let sendTimer = 0;
let scene = null;
let playerModels = {}; // { female, male } loaded in main.js
let myProfile = { name: 'Survivor', model: 'female' };
let onStatus = () => {};
let onMyColor = () => {};
let onRemoteShot = () => {};

// Player colors, handed out by the server in this order (index = color slot)
export const PLAYER_COLORS = [0x3f8cff, 0xff7a2f, 0x4fd34f, 0xb05cff, 0xffd23f, 0x2fd6c8, 0xff5c9a, 0xe8e8e8];

// The Blockbench models are 0.74 tall; this makes them about 1.78m, matching the player camera
const PLAYER_SCALE = 2.4;
// Positions from the server are the physics sphere's center, which is 0.5 above the ground
const FEET_OFFSET = -0.5;

// id -> { root, model, limbs, tag, target, targetRotY, walkPhase, profile }
const remotes = new Map();

//------------------------------------------------
// Hoodie tinting
// The hoodie is painted in plain grays. For each player we copy those textures and
// recolor only the gray pixels, so skin, hair, jeans, and boots keep their colors.
// (The torso texture has both hoodie and neck skin on it, so tinting the whole
// material would turn the neck blue too.)

const tintCache = new Map(); // "textureUUID:color" -> recolored texture

function isGray(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;
    // gray, but not white (drawstrings stay white) and not near-black (outlines/shadows stay dark)
    return saturation < 0.12 && max > 40 && max < 235;
}

// Is this texture mostly hoodie? (at least half of its visible pixels are gray)
function isHoodieTexture(image) {
    const data = readPixels(image);
    let gray = 0;
    let visible = 0;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        visible++;
        if (isGray(data[i], data[i + 1], data[i + 2])) gray++;
    }
    return visible > 0 && gray / visible > 0.5;
}

function readPixels(image) {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

function tintedTexture(texture, colorHex) {
    const key = `${texture.uuid}:${colorHex}`;
    if (tintCache.has(key)) return tintCache.get(key);

    const image = texture.image;
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = pixels.data;

    const color = new THREE.Color(colorHex);
    for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0 || !isGray(d[i], d[i + 1], d[i + 2])) continue;
        // keep the shading: light gray becomes light color, dark gray becomes dark color
        const shade = d[i] / 255;
        const boost = 1.7; // your grays are fairly dark, so brighten them a bit
        d[i] = Math.min(255, color.r * shade * boost * 255);
        d[i + 1] = Math.min(255, color.g * shade * boost * 255);
        d[i + 2] = Math.min(255, color.b * shade * boost * 255);
    }
    ctx.putImageData(pixels, 0, 0);

    const tinted = new THREE.CanvasTexture(canvas);
    // copy the original's settings so the pixels stay crisp and the UVs line up
    tinted.flipY = texture.flipY;
    tinted.magFilter = texture.magFilter;
    tinted.minFilter = texture.minFilter;
    tinted.wrapS = texture.wrapS;
    tinted.wrapT = texture.wrapT;
    tinted.colorSpace = texture.colorSpace;
    tintCache.set(key, tinted);
    return tinted;
}

// Remember which materials are hoodie the first time we see them (checked once per model)
const hoodieMaterials = new WeakMap();

function applyTint(model, colorHex) {
    model.traverse((child) => {
        if (!child.isMesh || !child.material.map) return;
        const original = child.userData.originalMap || child.material.map;
        child.userData.originalMap = original;

        if (!hoodieMaterials.has(original)) {
            hoodieMaterials.set(original, original.image ? isHoodieTexture(original.image) : false);
        }
        if (hoodieMaterials.get(original)) {
            child.material.map = tintedTexture(original, colorHex);
            child.material.needsUpdate = true;
        }
    });
}

//------------------------------------------------
// Name tags: the player's name in their color, floating above their head.
// Drawn on top of everything so you can find teammates through walls and fog.

function makeNameTag(name, colorHex) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 30px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // dark rounded backing so it reads against the bright sky
    const width = Math.min(250, ctx.measureText(name).width + 28);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.beginPath();
    ctx.roundRect(128 - width / 2, 10, width, 44, 10);
    ctx.fill();

    ctx.fillStyle = `#${new THREE.Color(colorHex).getHexString()}`;
    ctx.fillText(name, 128, 33);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: texture,
        depthTest: false, // visible through walls
        fog: false,       // stays readable in the fog
    }));
    sprite.scale.set(1.6, 0.4, 1);
    sprite.position.y = 1.75; // just above the head (relative to the sphere center)
    sprite.renderOrder = 999;
    return sprite;
}

//------------------------------------------------
// Building a remote player

function buildModel(r) {
    const { model: which, color } = r.profile;
    const colorHex = PLAYER_COLORS[color % PLAYER_COLORS.length];

    if (r.model) r.root.remove(r.model);
    if (r.tag) r.root.remove(r.tag);

    const source = playerModels[which] || playerModels.female || playerModels.male;
    let model;
    if (source) {
        model = source.clone();
        model.traverse((child) => {
            if (child.isMesh) {
                child.material = child.material.clone();
                child.castShadow = true;
            }
        });
        model.scale.setScalar(PLAYER_SCALE);
        model.position.y = FEET_OFFSET;
        applyTint(model, colorHex);
    } else {
        // models failed to load: fall back to a simple colored capsule
        model = new THREE.Mesh(
            new THREE.CapsuleGeometry(0.4, 1.0, 4, 8),
            new THREE.MeshStandardMaterial({ color: colorHex })
        );
        model.position.y = 0.4;
    }

    r.model = model;
    r.limbs = {
        armL: model.getObjectByName('arm_left'),
        armR: model.getObjectByName('arm_right'),
        legL: model.getObjectByName('leg_left'),
        legR: model.getObjectByName('leg_right'),
    };
    r.tag = makeNameTag(r.profile.name, colorHex);
    r.root.add(model, r.tag);
}

function addRemote(p) {
    if (p.id === myId || remotes.has(p.id)) return;
    const root = new THREE.Group();
    root.position.set(p.x, p.y, p.z);
    root.rotation.y = p.rotY;
    scene.add(root);

    const r = {
        root,
        target: new THREE.Vector3(p.x, p.y, p.z),
        targetRotY: p.rotY,
        lastPos: new THREE.Vector3(p.x, p.y, p.z),
        walkPhase: 0,
        swing: 0,
        profile: { name: p.name, model: p.model, color: p.color },
    };
    buildModel(r);
    remotes.set(p.id, r);
    onStatus(remotes.size);
}

function removeRemote(id) {
    const r = remotes.get(id);
    if (!r) return;
    scene.remove(r.root);
    remotes.delete(id);
    onStatus(remotes.size);
}

//------------------------------------------------
// Messages from the server
// Each socket.on('name', ...) handles one kind of event the server sends

function listen() {
    socket.on('welcome', (msg) => {
        myId = msg.id;
        onMyColor(PLAYER_COLORS[msg.color % PLAYER_COLORS.length]);
        msg.players.forEach(addRemote);
        onStatus(remotes.size);
    });

    socket.on('join', addRemote);

    // someone changed their name or character
    socket.on('profile', (msg) => {
        const r = remotes.get(msg.id);
        if (!r) return;
        r.profile = { name: msg.name, model: msg.model, color: msg.color };
        buildModel(r);
    });

    socket.on('leave', (msg) => removeRemote(msg.id));

    // everyone's latest position, 20 times a second
    socket.on('snapshot', (list) => {
        for (const p of list) {
            if (p.id === myId) continue;
            if (!remotes.has(p.id)) addRemote(p);
            const r = remotes.get(p.id);
            r.target.set(p.x, p.y, p.z);
            r.targetRotY = p.rotY;
        }
    });

    socket.on('shot', (msg) => onRemoteShot(msg.from, msg.to));

    socket.on('full', () => console.log('Server is full, playing solo.'));
}

//------------------------------------------------
// Public functions main.js calls

// options:
//   models: { female, male } loaded player models
//   profile: { name, model } for this player
//   statusCallback(othersOnline), myColorCallback(colorHex), remoteShotCallback(from, to)
export function initNetwork(gameScene, options = {}) {
    scene = gameScene;
    playerModels = options.models || {};
    if (options.profile) myProfile = options.profile;
    if (options.statusCallback) onStatus = options.statusCallback;
    if (options.myColorCallback) onMyColor = options.myColorCallback;
    if (options.remoteShotCallback) onRemoteShot = options.remoteShotCallback;

    const url = pickServerUrl();
    if (!url) {
        console.log('No multiplayer server configured, playing solo.');
        return;
    }

    socket = io(url);
    listen();

    // 'connect' also fires after Socket.IO reconnects by itself (e.g. Wi-Fi blip)
    socket.on('connect', () => {
        console.log('Connected to', url);
        sendProfile(myProfile);
    });
    socket.on('disconnect', () => {
        console.log('Disconnected, trying to reconnect...');
        for (const id of [...remotes.keys()]) removeRemote(id);
    });
}

function isOpen() {
    return socket && socket.connected;
}

// Tell the server (and everyone else) our name and which character we picked
export function sendProfile(profile) {
    myProfile = profile;
    if (!isOpen()) return;
    socket.emit('hello', { name: profile.name, model: profile.model });
}

// Call every frame with the player's physics position and the camera's facing
export function sendState(dt, position, rotY) {
    if (!isOpen()) return;
    sendTimer -= dt;
    if (sendTimer > 0) return;
    sendTimer = 1 / SEND_RATE;
    socket.emit('state', {
        x: +position.x.toFixed(2),
        y: +position.y.toFixed(2),
        z: +position.z.toFixed(2),
        rotY: +rotY.toFixed(3),
    });
}

export function sendShot(from, to) {
    if (!isOpen()) return;
    socket.emit('shot', {
        from: { x: from.x, y: from.y, z: from.z },
        to: { x: to.x, y: to.y, z: to.z },
    });
}

// Smoothly slide other players toward their latest known position and animate walking.
// Updates only arrive 20x a second, so without this they'd look jittery.
export function updateRemotePlayers(dt) {
    if (dt <= 0) return;
    const t = Math.min(1, dt * 12);
    for (const r of remotes.values()) {
        r.root.position.lerp(r.target, t);

        // turn the shortest way around
        let diff = r.targetRotY - r.root.rotation.y;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        r.root.rotation.y += diff * t;

        // Walk cycle: how fast are they moving along the ground?
        const dx = r.root.position.x - r.lastPos.x;
        const dz = r.root.position.z - r.lastPos.z;
        const speed = Math.hypot(dx, dz) / dt;
        r.lastPos.copy(r.root.position);

        // swing size follows speed (bigger when sprinting), and eases back to standing
        const targetSwing = Math.min(speed / 8, 1) * 0.7;
        r.swing += (targetSwing - r.swing) * Math.min(1, dt * 8);
        r.walkPhase += speed * dt * 1.6;

        const angle = Math.sin(r.walkPhase) * r.swing;
        const { armL, armR, legL, legR } = r.limbs;
        if (legL) legL.rotation.x = angle;
        if (legR) legR.rotation.x = -angle;
        if (armL) armL.rotation.x = -angle * 0.8; // arms swing opposite their leg
        if (armR) armR.rotation.x = angle * 0.8;

        // little bounce in each step
        if (r.model) r.model.position.y = FEET_OFFSET + Math.abs(Math.sin(r.walkPhase)) * r.swing * 0.08;
    }
}