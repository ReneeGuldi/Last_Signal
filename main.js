import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as CANNON from 'cannon-es';
import { initNetwork, sendState, sendShot, sendProfile, updateRemotePlayers } from './net.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Creating the Renderer, Scene, and Game Camera
const renderer = new THREE.WebGLRenderer({ antialias: true});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// dusty orange sky, may alter
const SKY_COLOR = 0xb08560;
scene.background = new THREE.Color(SKY_COLOR);
// (color, start, end) - focused on hiding map edges
scene.fog = new THREE.Fog(SKY_COLOR, 10, 90); 

// Perspective Camera (fov, aspect, near, far)
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 500);

// Lighting
// Goal is ambient, soft fill everywhere, directional the sun casts shadows

scene.add(new THREE.AmbientLight(0xffe0c0, 0.5));

const sun = new THREE.DirectionalLight(0xffc89a, 1.5);
sun.position.set(30, 50, 20);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);

// The shadow camera is a box, only letting things inside of it get shadows
Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60});
scene.add(sun);
scene.add(sun.target); // sun aims at its target which follows the player

// Game Physics through cannon-es
// Physics will run in its own invisible world, where each frame we copy the
// physics body positions onto the visible Three.js meshes.
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -20, 0)});
// stop the player from sticking to walls
world.defaultContactMaterial.friction = 0;

//------------------------------------------------
// Ground
const groundMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshStandardMaterial({ color: 0x8a6a4a })
);
// planes start vertical, lay it flat
groundMesh.rotation.x = -Math.PI / 2;
groundMesh.receiveShadow = true;
scene.add(groundMesh);

// mass 0 = static
const groundBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(groundBody);



//------------------------------------------------
// Loading Blockbench models
// All models load at once before the game starts
// If a model fails to load, it gets a placeholder instead
const MODEL_FILES = {
    husk: 'models/husk_new_1.gltf',
    battery: 'models/battery.gltf',
    coil: 'models/coil.gltf',
    transmitter: 'models/transmitter.gltf',
    barrel: 'models/barrel.gltf',
    medkit: 'models/medkit.gltf',
    crate: 'models/crate.gltf',
    ammo: 'models/ammo.gltf',
    female: 'models/player_female.gltf',
    male: 'models/player_male.gltf',
    pistol: 'models/pistol.gltf',
    shotgun: 'models/shotgun.gltf',
    machete: 'models/machete.gltf',
    nest: 'models/nest.gltf',
};

const models = {};
const loader = new GLTFLoader();

async function loadModels() {
    const names = Object.keys(MODEL_FILES);
    const results = await Promise.allSettled(names.map((n) => loader.loadAsync(MODEL_FILES[n])));
    names.forEach((name, i) => {
        if (results[i].status === 'rejected') {
            console.warn(`Couldn't load ${name} (${MODEL_FILES[name]}), using a placeholder`);
            return;
        }
        const model = results[i].value.scene;
        model.traverse((child) => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });
        models[name] = model;
    });
}

// Stand-in models if something doesn't load: a plain item-sized box
function placeholderModel() {
    const g = new THREE.Group();
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.4, 0.3, 0.4),
        new THREE.MeshStandardMaterial({ color: 0x8a7a5a })
    );
    mesh.position.y = 0.15;
    mesh.castShadow = true;
    g.add(mesh);
    return g;
}


// Adds a copy of a model to the scene.
function spawnModel(name, scale = 1, yOffset = 0) {
    const inner = models[name] ? models[name].clone() : placeholderModel();
    // Keeps material changes separate between model copies.
    inner.traverse((child) => {
        if (child.isMesh) child.material = child.material.clone();
    });
    inner.scale.setScalar(scale);
    inner.position.y = yOffset;

    const holder = new THREE.Group();
    holder.add(inner);
    scene.add(holder);
    return holder;
}

// Prepares a model for use as a weapon by centering, scaling, and orienting it.
function sizedModel(name, length, flip = false) {
    const src = models[name] ? models[name].clone() : placeholderModel();
    src.traverse((c) => {
        if (c.isMesh) c.material = c.material.clone();
    });
 
    const box = new THREE.Box3().setFromObject(src);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    src.position.sub(center);
 
    const orient = new THREE.Group();
    orient.add(src);
    const longest = Math.max(size.x, size.y, size.z) || 1;
    if (size.x === longest) orient.rotation.y = Math.PI / 2;       // long along x: turn it forward
    else if (size.y === longest) orient.rotation.x = -Math.PI / 2; // modeled standing up: lay it forward
    if (flip) orient.rotateY(Math.PI);
 
    const holder = new THREE.Group();
    holder.add(orient);
    holder.scale.setScalar(length / longest);
    return holder;
}

//------------------------------------------------
// Helper Functions
// Used for placeholder buildings, cars, crates, etc
const obstacles = [];
function createBox(w, h, d, x, z, color, mass = 0) {
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        new THREE.MeshStandardMaterial({ color })
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    obstacles.push(mesh);

    // Cannon boxes are half size
    const body = new CANNON.Body({
        mass: 0,
        shape: new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d /2)),
        position: new CANNON.Vec3(x, h / 2, z),
    });
    world.addBody(body);

    mesh.position.copy(body.position);
    return { mesh, body };
}


//------------------------------------------------
// Colliders & box-built buildings

// Building geometry generated with ChatGPT from my prompt,
// then reviewed and adjusted by me (collider fixes, pickup placement of items)

const SHOW_COLLIDERS = false;

function addStaticCollider(w, h, d, x, z, rotY = 0) {
    const ph = h < 0.05 ? h : Math.max(h, 6);

    const body = new CANNON.Body({
        mass: 0,
        shape: new CANNON.Box(new CANNON.Vec3(w / 2, ph / 2, d / 2)),
        position: new CANNON.Vec3(x, ph / 2, z),
    });
    body.quaternion.setFromEuler(0, rotY, 0);
    world.addBody(body);

    if (SHOW_COLLIDERS) {
        const debug = new THREE.Mesh(
            new THREE.BoxGeometry(w, h, d),
            new THREE.MeshStandardMaterial({ color: 0x00ff00, wireframe: true })
        );
        debug.position.set(x, ph / 2, z);
        debug.rotation.y = rotY;
        scene.add(debug);
    }
}

function part(group, w, h, d, x, y, z, color, rotX = 0, rotY = 0, rotZ = 0) {
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        new THREE.MeshStandardMaterial({ color })
    );
    mesh.position.set(x, y, z);
    mesh.rotation.set(rotX, rotY, rotZ);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
}

// Combines building meshes by material to improve performance.
function mergeGroup(group) {
    group.updateMatrixWorld(true);
    const inverse = new THREE.Matrix4().copy(group.matrixWorld).invert();
    const buckets = new Map();
 
    group.traverse((c) => {
        if (!c.isMesh) return;
        for (let a = c; a && a !== group; a = a.parent) if (a.userData.keep) return;
        const m = c.material;
        if (!m || !m.isMeshStandardMaterial || m.map || m.transparent) return;
        const key = `${m.color.getHex()}|${m.emissive.getHex()}|${m.emissiveIntensity}|${m.flatShading}|${c.geometry.index ? 1 : 0}`;
        if (!buckets.has(key)) buckets.set(key, { material: m, meshes: [] });
        buckets.get(key).meshes.push(c);
    });
 
    for (const { material, meshes } of buckets.values()) {
        if (meshes.length < 2) continue;
        const geos = meshes.map((c) =>
            c.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, c.matrixWorld))
        );
        const merged = mergeGeometries(geos, false);
        if (!merged) continue; // couldn't merge: leave the parts as they are
        for (const c of meshes) c.parent.remove(c);
        const mesh = new THREE.Mesh(merged, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
    }
}

function finishBuilding(group, x, z) {
    group.position.set(x, 0, z);
    scene.add(group);
    mergeGroup(group);
    obstacles.push(group);
}

// Adds a physics collider to the world.
function addSolid(w, h, d, x, y, z, rotX = 0, rotY = 0) {
    const body = new CANNON.Body({
        mass: 0,
        shape: new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2)),
        position: new CANNON.Vec3(x, y, z),
    });
    body.quaternion.setFromEuler(rotX, rotY, 0);
    world.addBody(body);
 
    // Shows the collider when debug mode is enabled.
    if (SHOW_COLLIDERS) {
        const debug = new THREE.Mesh(
            new THREE.BoxGeometry(w, h, d),
            new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true })
        );
        debug.position.set(x, y, z);
        debug.rotation.set(rotX, rotY, 0);
        scene.add(debug);
    }
}

// Helper for adding objects and collision inside buildings.
function makeBuilder(x, z, flip = false) {
    const g = new THREE.Group();
    const f = flip ? -1 : 1;
    return {
        g, x, z, flip,
        // Converts building coordinates to world coordinates.
        at: (lx, lz) => ({ x: x + lx, z: z + lz * f }),
        // Adds a visible object without collision.
        box(w, h, d, lx, ly, lz, color, rx = 0, ry = 0, rz = 0) {
            return part(g, w, h, d, lx, ly, lz * f, color, rx * f, ry * f, rz);
        },
        // Adds a visible object with collision.
        solid(w, h, d, lx, ly, lz, color) {
            part(g, w, h, d, lx, ly, lz * f, color);
            addSolid(w, h, d, x + lx, ly, z + lz * f);
        },
        // Adds an invisible collision box.
        block(w, h, d, lx, ly, lz) {
            addSolid(w, h, d, x + lx, ly, z + lz * f);
        },
        // Adds the finished building to the scene.
        finish() {
            finishBuilding(g, x, z);
        },
    };
}

// Keep trees and rocks from spawning inside buildings or on roads
const reserved = [];
function reserve(x1, z1, x2, z2) {
    reserved.push([Math.min(x1, x2), Math.min(z1, z2), Math.max(x1, x2), Math.max(z1, z2)]);
}
function isFree(x, z, margin = 1) {
    return !reserved.some(([x1, z1, x2, z2]) =>
        x > x1 - margin && x < x2 + margin && z > z1 - margin && z < z2 + margin);
}


// GAS STATION BUILD
function buildGasStation(x, z) {
    const g = new THREE.Group();
    const WALL = 0x9b866b;
    const PALE = 0xc0aa83;
    const DARK = 0x403b34;
    const RUST = 0x75452f;
    const GLASS = 0x52605c;
    const CONCRETE = 0x777064;
    const SIGN = 0xbca45d;

    // Walls: small shop, with a doorway in the front wall (+z)
    part(g, 8, 3.8, 0.35, 0, 2.0, -3.8, WALL);
    part(g, 0.35, 3.8, 7.3, -3.8, 2.0, 0, WALL);
    part(g, 0.35, 3.8, 7.3, 3.8, 2.0, 0, PALE);

    // Front wall split around the entrance
    part(g, 2.0, 3.8, 0.35, -3.0, 2.0, 3.8, WALL);
    part(g, 2.0, 3.8, 0.35, 3.0, 2.0, 3.8, PALE);
    part(g, 2.0, 0.45, 0.35, 0, 3.65, 3.8, WALL);

    // Broken front window and its frame
    part(g, 2.1, 1.5, 0.08, -2.3, 2.5, 3.99, GLASS);
    part(g, 2.35, 0.12, 0.12, -2.3, 3.32, 4.04, DARK);
    part(g, 0.12, 1.6, 0.12, -3.48, 2.5, 4.04, DARK);
    part(g, 0.12, 1.6, 0.12, -1.12, 2.5, 4.04, DARK);
    part(g, 0.8, 0.08, 0.12, -2.0, 2.15, 4.08, RUST, 0, 0, -0.35);

    // Roof: two uneven slabs and a missing corner
    part(g, 4.5, 0.35, 8.5, -1.7, 4.05, 0, DARK);
    part(g, 2.6, 0.3, 6.5, 2.65, 3.9, -0.6, WALL, 0, 0, 0.025);
    part(g, 1.1, 0.2, 2.0, 3.0, 4.2, 2.2, RUST, 0, 0, -0.1);

    // Sagging fuel canopy
    part(g, 10, 0.25, 3.6, 1.0, 4.2, 7.0, PALE, 0, 0, -0.035);
    part(g, 10, 0.16, 3.6, 1.0, 4.02, 7.0, RUST);

    // Canopy supports
    part(g, 0.22, 3.9, 0.22, -3.2, 2.0, 5.7, DARK);
    part(g, 0.22, 3.5, 0.22, 5.2, 1.8, 5.7, DARK);
    part(g, 0.22, 3.9, 0.22, -3.2, 2.0, 8.3, RUST);
    part(g, 0.22, 3.5, 0.22, 5.2, 1.8, 8.3, DARK);

    // Rust patches, faded sign and damaged fascia
    part(g, 1.0, 0.55, 0.08, -2.7, 1.3, 4.02, RUST);
    part(g, 1.4, 0.3, 0.1, 1.5, 3.4, 4.02, SIGN);
    part(g, 2.5, 0.22, 0.16, -0.2, 5.0, -3.95, RUST, 0, 0, 0.03);

    // Fuel pumps: blocky bodies and bent-looking nozzles
    for (const px of [-1.7, 2.3]) {
        part(g, 0.8, 1.35, 0.65, px, 0.8, 7.0, RUST);
        part(g, 0.65, 0.38, 0.08, px, 1.05, 7.36, DARK);
        part(g, 0.3, 0.18, 0.08, px, 1.55, 7.36, SIGN);
        part(g, 0.08, 0.55, 0.08, px + 0.48, 1.05, 6.8, DARK, 0, 0, -0.25);
    }

    // Broken concrete and scattered debris
    part(g, 2.2, 0.14, 1.3, -4.8, 0.07, 4.4, CONCRETE, 0, 0, 0.04);
    part(g, 1.0, 0.2, 0.65, 5.3, 0.1, 3.5, RUST, 0.05, 0.3, 0.1);
    part(g, 0.65, 0.25, 0.7, -4.4, 0.13, -4.8, DARK, 0.1, 0.4, 0.1);

    // Place the building
    finishBuilding(g, x, z);

    // Colliders: shop walls, split front wall and fuel pumps
    addStaticCollider(8, 3.8, 0.35, x, z - 3.8);
    addStaticCollider(0.35, 3.8, 7.3, x - 3.8, z);
    addStaticCollider(0.35, 3.8, 7.3, x + 3.8, z);
    addStaticCollider(2, 3.8, 0.35, x - 3, z + 3.8);
    addStaticCollider(2, 3.8, 0.35, x + 3, z + 3.8);
    addStaticCollider(0.8, 1.35, 0.65, x - 1.7, z + 7);
    addStaticCollider(0.8, 1.35, 0.65, x + 2.3, z + 7);
    addStaticCollider(0.22, 3.9, 0.22, x - 3.2, z + 5.7);
    addStaticCollider(0.22, 3.5, 0.22, x + 5.2, z + 5.7);
    addStaticCollider(0.22, 3.9, 0.22, x - 3.2, z + 8.3);
    addStaticCollider(0.22, 3.5, 0.22, x + 5.2, z + 8.3);
}

// RADIO TOWER
const TOWER_POS = new THREE.Vector3(0, 0, -50);
let beaconLight;
let beaconBulb;

function buildRadioTower(x, z) {
    const g = new THREE.Group();

    // Palette
    const RUST = 0x75432f;
    const DARK = 0x393936;
    const METAL = 0x82796b;
    const PALE = 0xb49a72;
    const WIRE = 0x51473c;

    // Base and anchoring feet
    part(g, 3.4, 0.25, 3.4, 0, 0.12, 0, DARK);
    for (const px of [-1.35, 1.35]) {
        for (const pz of [-1.35, 1.35]) {
            part(g, 0.55, 0.35, 0.55, px, 0.3, pz, METAL);
        }
    }

    // Four tapering-looking legs, built from long tilted boxes
    part(g, 0.24, 24, 0.24, -1.45, 12, -1.45, RUST, 0, 0, -0.045);
    part(g, 0.24, 24, 0.24, 1.45, 12, -1.45, METAL, 0, 0, 0.045);
    part(g, 0.24, 24, 0.24, -1.45, 12, 1.45, METAL, 0.045, 0, -0.045);
    part(g, 0.24, 24, 0.24, 1.45, 12, 1.45, RUST, -0.045, 0, 0.045);

    // Horizontal crossbars at several elevations
    for (const y of [2, 6, 10, 14, 18, 22]) {
        part(g, 3.1, 0.16, 0.16, 0, y, -1.45, METAL);
        part(g, 3.1, 0.16, 0.16, 0, y, 1.45, RUST);
        part(g, 0.16, 0.16, 3.1, -1.45, y, 0, RUST);
        part(g, 0.16, 0.16, 3.1, 1.45, y, 0, METAL);
    }

    // Diagonal braces on all four faces
    for (const y of [2, 6, 10, 14, 18]) {
        part(g, 0.13, 5.7, 0.13, 0, y + 2, -1.45, RUST, 0, 0, 0.65);
        part(g, 0.13, 5.7, 0.13, 0, y + 2, 1.45, METAL, 0, 0, -0.65);
        part(g, 0.13, 5.7, 0.13, -1.45, y + 2, 0, METAL, 0.65, 0, 0);
        part(g, 0.13, 5.7, 0.13, 1.45, y + 2, 0, RUST, -0.65, 0, 0);
    }

    // Damaged upper platform
    part(g, 2.5, 0.18, 2.3, 0, 20, 0, DARK, 0, 0, -0.06);
    part(g, 1.4, 0.15, 0.5, 0.9, 20.2, 0.5, RUST, 0, 0, 0.2);
    part(g, 0.12, 1.1, 0.12, -0.9, 20.5, -0.9, METAL);

    // Antenna mast and broken cross-arms
    part(g, 0.18, 4.5, 0.18, 0, 24.2, 0, RUST, 0, 0, 0.04);
    part(g, 2.2, 0.12, 0.12, 0, 23.2, 0, METAL, 0, 0, -0.08);
    part(g, 1.0, 0.12, 0.12, 0.6, 24.8, 0, RUST, 0, 0, 0.25);
    part(g, 0.12, 1.5, 0.12, 0.4, 23.5, 0, DARK, 0, 0, 0.12);

    // Loose-looking cables and rust patches
    part(g, 0.08, 5, 0.08, -1.0, 17, -1.55, WIRE, 0, 0, 0.3);
    part(g, 0.7, 0.35, 0.08, 1.5, 12, -1.6, RUST);
    part(g, 0.5, 0.4, 0.08, -1.6, 7, 1.5, PALE);

    // beacon at the top of the tower (dark until signal is sent)
    beaconBulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.3, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0x330000 })
    );
    beaconBulb.position.set(0, 26.7, 0);
    beaconBulb.userData.keep = true;
    g.add(beaconBulb);

    beaconLight = new THREE.PointLight(0xff2020, 0, 40);
    beaconLight.position.set(0, 26.7, 0);
    g.add(beaconLight);


    // Place the tower
    finishBuilding(g, x, z);

    // Colliders: base only; leave the lattice open for visibility and navigation
    addStaticCollider(3.4, 0.25, 3.4, x, z);
    for (const px of [-1.45, 1.45]) {
        for (const pz of [-1.45, 1.45]) {
            addStaticCollider(0.24, 2.2, 0.24, x + px, z + pz);
        }
    }
}

// COLLAPSED HOUSE
function buildCollapsedHouse(x, z) {
    const g = new THREE.Group();

    // Palette
    const WALL = 0x8f7b64;
    const PLASTER = 0xb1a087;
    const WOOD = 0x594638;
    const DARK = 0x39352f;
    const RUST = 0x79503b;
    const STONE = 0x71695c;

    // Back wall
    part(g, 7.6, 3.8, 0.3, 0, 1.9, -3.8, WALL);
    part(g, 2.0, 1.0, 0.18, -2.3, 3.7, -3.62, PLASTER);

    // Left wall, with a broken upper edge
    part(g, 0.3, 3.4, 7.6, -3.8, 1.7, 0, PLASTER);
    part(g, 0.35, 1.0, 3.1, -3.8, 3.8, -2.1, WALL, 0, 0, -0.12);
    part(g, 0.3, 0.8, 2.3, -3.8, 3.3, 2.4, WALL, 0.1, 0, 0.08);

    // Right wall, partially collapsed
    part(g, 0.3, 2.5, 3.1, 3.8, 1.25, -2.2, WALL);
    part(g, 0.3, 1.2, 2.1, 3.8, 0.6, 2.5, PLASTER);
    part(g, 0.35, 1.0, 2.7, 3.8, 3.4, -1.0, WALL, 0, 0, -0.12);

    // Front wall segments leave a wide doorway in the middle
    part(g, 2.0, 2.7, 0.3, -2.8, 1.35, 3.8, WALL);
    part(g, 2.0, 2.7, 0.3, 2.8, 1.35, 3.8, PLASTER);
    part(g, 2.0, 0.3, 0.3, 0, 2.7, 3.8, WALL);

    // Roof remnants: only part of the roof survived
    part(g, 4.3, 0.25, 3.0, -1.6, 4.1, -2.2, DARK, 0, 0, -0.06);
    part(g, 2.8, 0.2, 2.0, 1.4, 4.35, -2.6, WOOD, 0, 0, 0.1);
    part(g, 3.7, 0.18, 0.18, -1.3, 3.9, 0.0, WOOD, 0.1, 0, 0.3);
    part(g, 3.0, 0.18, 0.18, 0.8, 3.5, -0.5, WOOD, 0, 0, -0.25);
    part(g, 0.2, 2.8, 0.2, -2.9, 2.5, -1.9, WOOD, 0, 0, 0.12);

    // Interior decay and exposed framing
    part(g, 0.18, 2.2, 0.18, -2.0, 1.8, -3.55, WOOD);
    part(g, 0.18, 2.2, 0.18, 1.7, 1.8, -3.55, WOOD);
    part(g, 1.1, 0.1, 0.12, -2.5, 1.3, -3.58, RUST);
    part(g, 1.4, 0.1, 0.12, 2.2, 1.5, -3.58, DARK);

    // Rubble scattered around the entry and inside
    part(g, 1.4, 0.22, 0.9, -2.8, 0.12, 4.5, STONE, 0, 0.3, 0.08);
    part(g, 0.9, 0.18, 0.7, 2.7, 0.1, 4.4, DARK, 0, 0.5, 0);
    part(g, 1.2, 0.18, 0.65, 0.8, 0.1, 1.0, STONE, 0, 0.2, 0);
    part(g, 0.7, 0.14, 0.6, -1.6, 0.08, -0.5, PLASTER, 0, 0.6, 0.1);

    // Place the house
    finishBuilding(g, x, z);

    // Colliders: perimeter walls; no collider across the doorway
    addStaticCollider(7.6, 3.8, 0.3, x, z - 3.8);
    addStaticCollider(0.3, 3.4, 7.6, x - 3.8, z);
    addStaticCollider(0.3, 2.5, 3.1, x + 3.8, z - 2.2);
    addStaticCollider(0.3, 1.2, 2.1, x + 3.8, z + 2.5);
    addStaticCollider(2, 2.7, 0.3, x - 2.8, z + 3.8);
    addStaticCollider(2, 2.7, 0.3, x + 2.8, z + 3.8);
}

// CRASHED BUS
function buildSchoolBus(x, z) {
    const g = new THREE.Group();

    // Palette
    const YELLOW = 0xb39a42;
    const PALE = 0xc1ad66;
    const DARK = 0x393936;
    const GLASS = 0x465450;
    const RUST = 0x75432f;
    const TIRE = 0x282725;
    const METAL = 0x777269;

    // Main body and offset rear section
    part(g, 9.0, 1.65, 2.7, 0, 1.35, 0, YELLOW);
    part(g, 6.0, 0.7, 2.6, -1.1, 2.48, 0, PALE, 0, 0, -0.035);
    part(g, 2.3, 1.4, 2.7, 3.2, 1.3, 0, RUST, 0, 0, 0.08);

    // Front hood and damaged bumper
    part(g, 1.9, 0.65, 2.5, 4.9, 1.25, 0, YELLOW, 0, 0, -0.12);
    part(g, 2.0, 0.2, 2.8, 5.0, 0.65, 0, DARK, 0, 0, -0.12);
    part(g, 0.65, 0.3, 0.1, 5.95, 1.4, -0.7, METAL);
    part(g, 0.65, 0.3, 0.1, 5.95, 1.4, 0.7, METAL);

    // Window band, with missing panes
    for (const wx of [-2.9, -1.5, -0.1, 1.3]) {
        part(g, 1.05, 0.75, 0.07, wx, 2.48, 1.37, GLASS);
        part(g, 1.1, 0.08, 0.12, wx, 2.88, 1.42, DARK);
        part(g, 0.08, 0.8, 0.12, wx - 0.55, 2.48, 1.42, DARK);
    }

    // Broken rear-side windows and exposed framing
    part(g, 0.85, 0.7, 0.08, -4.0, 2.1, 1.39, GLASS);
    part(g, 0.1, 0.9, 0.12, -4.5, 2.1, 1.42, RUST);
    part(g, 0.1, 0.9, 0.12, -3.5, 2.1, 1.42, DARK);

    // Opposite-side windows
    part(g, 1.1, 0.7, 0.08, -2.6, 2.45, -1.39, GLASS);
    part(g, 1.1, 0.7, 0.08, -0.8, 2.45, -1.39, DARK);
    part(g, 0.1, 0.8, 0.12, 0.0, 2.45, -1.42, RUST);

    // Front windshield, cracked look from intersecting strips
    part(g, 0.9, 0.8, 0.08, 5.65, 2.0, -0.65, GLASS, 0, 0, -0.12);
    part(g, 0.9, 0.8, 0.08, 5.65, 2.0, 0.65, GLASS, 0, 0, -0.12);
    part(g, 0.06, 0.9, 0.1, 5.72, 2.0, 0, DARK, 0, 0, 0.12);

    // Wheels: kept as boxes for the low-poly look
    for (const wx of [-3.2, 2.8]) {
        part(g, 0.75, 0.9, 0.35, wx, 0.55, 1.35, TIRE);
        part(g, 0.75, 0.9, 0.35, wx, 0.55, -1.35, TIRE);
        part(g, 0.3, 0.35, 0.38, wx, 0.55, 1.53, METAL);
        part(g, 0.3, 0.35, 0.38, wx, 0.55, -1.53, METAL);
    }

    // Skewed roof and rusted roof rails
    part(g, 3.6, 0.18, 2.6, -1.6, 3.0, 0, DARK, 0, 0, -0.05);
    part(g, 2.2, 0.16, 2.3, 2.4, 3.05, 0, YELLOW, 0, 0, 0.08);
    part(g, 4.0, 0.12, 0.12, -1.0, 3.15, 1.1, RUST, 0, 0, -0.08);

    // Faded stripe and side damage
    part(g, 4.6, 0.18, 0.06, -0.4, 1.6, 1.39, RUST);
    part(g, 1.2, 0.55, 0.08, 2.2, 1.8, 1.42, DARK, 0, 0, 0.08);
    part(g, 0.9, 0.35, 0.08, -3.5, 1.35, 1.42, RUST);
    part(g, 1.3, 0.22, 0.08, -1.7, 0.85, -1.42, METAL);

    // Debris and detached panels
    part(g, 1.4, 0.16, 0.75, 4.5, 0.1, 2.1, RUST, 0, 0.25, 0.1);
    part(g, 1.0, 0.12, 0.65, -4.8, 0.08, -1.8, DARK, 0, 0.5, 0.1);
    part(g, 0.8, 0.18, 0.6, 5.8, 0.1, -1.8, METAL, 0, 0.3, 0.05);

    return g;
}


//------------------------------------------------
// Physics Props
const props = [];
function spawnCrate(x, z) {
    const mesh = spawnModel('crate', 1, -0.5);
    const body = new CANNON.Body({
        mass: 5,
        shape: new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5)),
        position: new CANNON.Vec3(x, 0.5, z),
    });
    body.linearDamping = 0.4;
    body.angularDamping = 0.6;
    world.addBody(body);
    const prop = { mesh, body };
    mesh.userData.prop = prop;
    props.push(prop);
}

function spawnBarrel(x, z) {
    const mesh = spawnModel('barrel', 1, -0.5);
    const body = new CANNON.Body({
        mass: 10,
        shape: new CANNON.Cylinder(0.35, 0.35, 1, 8),
        position: new CANNON.Vec3(x, 0.5, z),
    });
    body.linearDamping = 0.4;
    body.angularDamping = 0.6;
    world.addBody(body);
    const prop = { mesh, body, explosive: true };
    mesh.userData.prop = prop;
    props.push(prop);
}

// Darken the bus to make it look burnt on explosion
    function charModel(mesh) {
        mesh.traverse((c) => {
            if (c.isMesh) c.material.color.multiplyScalar(0.35);
        });
    }


function spawnBus(x, z) {
    const busModel = buildSchoolBus();
    busModel.position.y = -1.4;
    mergeGroup(busModel);

    const holder = new THREE.Group();
    holder.add(busModel);
    scene.add(holder);

    const body = new CANNON.Body({
        mass: 0,
        position: new CANNON.Vec3(x, 1.4, z),
    });

    body.addShape(new CANNON.Box(new CANNON.Vec3(5.25, 1.4, 1.35)), new CANNON.Vec3(0.75, 0, 0));
    body.linearDamping = 0.5;
    body.angularDamping = 0.6;
    world.addBody(body);

    const prop = { mesh: holder, body, dormant: true, blastScale: 8};
    holder.userData.prop = prop;
    props.push(prop);
}




//------------------------------------------------
// Player
// Invisible physics sphere where the camera sits on top
// Where you spawn (and respawn with `R`): by the farmhouse, facing the dirt path into town
const SPAWN = { x: -63, z: 103, yaw: -1.16 };


const playerBody = new CANNON.Body({
    mass: 70,
    shape: new CANNON.Sphere(0.5),
    position: new CANNON.Vec3(SPAWN.x, 2, SPAWN.z),
    fixedRotation: true, // don't let the sphere roll
});
world.addBody(playerBody);

// Ground check, only allow jumping after landing on something (ground or object)
let canJump = false;
const upAxis = new CANNON.Vec3(0, 1, 0);
const contactNormal = new CANNON.Vec3();

playerBody.addEventListener('collide', (e) => {
    const contact = e.contact;
    // The contact normal points from body "bi" to body "bj", so flip it if the player is "bi"
    if (contact.bi.id === playerBody.id) {
        contact.ni.negate(contactNormal);
    } else {
        contactNormal.copy(contact.ni);
    }
    // if the surface we touched faces mostly upward, it's a floor
    if (contactNormal.dot(upAxis) > 0.5) canJump = true;
});

// camera height right above the sphere's center
const EYE_HEIGHT = 1.1;
let health = 100;
let ammo = 30;
let partsFound = 0;
let score = 0;

let towerState = 'dead';
let evacTimer = 0;
let waveTimer = 0;
let towerHintShown = false;
const EVAC_TIME = 60;

let gameOver = false;
let ready = false; // true once models finish loading


//------------------------------------------------
// Controls & Input from player
// PointerLockControls hides the curser and turns mouse movement into looking around
const controls = new PointerLockControls(camera, document.body);
const overlay = document.getElementById('overlay');
const overlayTitle = document.getElementById('overlay-title');
const overlayText = document.getElementById('overlay-text');
const messageEl = document.getElementById('message');
const healthEl = document.getElementById('health');
const ammoEl = document.getElementById('ammo');
const partsEl = document.getElementById('parts');
const scoreEl = document.getElementById('score');
const crosshairEl = document.getElementById('crosshair');
const objectiveEl = document.getElementById('objective');
const weaponsEl = document.getElementById('weapons');


overlay.addEventListener('click', () => { if (ready && !gameOver) controls.lock(); });
controls.addEventListener('lock', () => {
    overlay.style.display = 'none';
    document.activeElement.blur(); // take focus off the name box so WASD/F/R reach the game
    updateProfile();
});
controls.addEventListener('unlock', () => (overlay.style.display = 'flex'));

const keys = {};
document.addEventListener('keydown', (e) => { 
    if (e.target.tagName === 'INPUT') return;
    keys[e.code] = true; 
    if (e.code === 'KeyR' && ready) resetGame();
    if (e.code === 'KeyF' && controls.isLocked && !gameOver) shove();
    if (e.code === 'KeyE' && controls.isLocked && !gameOver) interact();
    if (controls.isLocked && !gameOver) {
        if (e.code === 'Digit1') equip('pistol');
        if (e.code === 'Digit2') equip('shotgun');
        if (e.code === 'Digit3') equip('machete');
    }
});
document.getElementById('profile').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('keyup', (e) => (keys[e.code] = false));

// Name & character picker on the start screen
const nameInput = document.getElementById('name-input');
const youEl = document.getElementById('you');
const playersEl = document.getElementById('players');
const pickButtons = document.querySelectorAll('#profile button');
let pickedModel = 'female';
pickButtons[0].classList.add('selected');
playersEl.textContent = 'Playing solo';

function myProfile() {
    return { name: nameInput.value.trim() || 'Survivor', model: pickedModel };
}
function updateProfile() {
    sendProfile(myProfile());
    youEl.textContent = `You: ${myProfile().name}`;
}
for (const btn of pickButtons) {
    btn.addEventListener('click', () => {
        pickedModel = btn.dataset.model;
        pickButtons.forEach((b) => b.classList.toggle('selected', b === btn));
        updateProfile();
    });
}
nameInput.addEventListener('change', updateProfile);

let messageTimer = null;
function showMessage(text, seconds = 2.5) {
    messageEl.textContent = text;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => (messageEl.textContent = ''), seconds * 1000);
}

function updateHUD() {
    healthEl.textContent = `Health: ${Math.max(0, Math.ceil(health))}`;
    const w = WEAPONS[weapon];
    ammoEl.textContent = w.melee ? w.name : `${w.name}: ${w.ammo === 'shells' ? shells : ammo}`;
    if (weaponsEl) {
        weaponsEl.textContent = WEAPON_ORDER.filter((k) => owned[k])
            .map((k) => (k === weapon ? `[${WEAPONS[k].slot} ${WEAPONS[k].name}]` : `${WEAPONS[k].slot} ${WEAPONS[k].name}`))
            .join('  ');
    }
    partsEl.textContent = `Parts: ${partsFound}/3`;
    scoreEl.textContent = `Score: ${score}`;

    if (towerState === 'landing') {
        objectiveEl.textContent = `Hold the landing zone! Chopper lands in ${Math.ceil(evacTimer)}s`;
    }   else if (towerState === 'broadcasting') {
        objectiveEl.textContent = `Objective: Follow the road south to the landing zone`;
    }   else if (partsFound < 3) {
        objectiveEl.textContent = `Objective: Find the radio parts (${partsFound}/3)`;
    }   else {
        objectiveEl.textContent = `Objective: Get to the radio tower!`;
    }
}

// Knockback from explosions & hits
const knockback = new THREE.Vector3();
// 1 = normal speed, lower while going through barbed wire (set by updateHazards)
let hazardSlow = 1;

function updatePlayer(dt) {
    if (!controls.isLocked) return;

    const speed = (keys.ShiftLeft ? 12 : 6) * hazardSlow;

    // which way is the camera facing - if looking down, don't slow the player
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();

    const move = new THREE.Vector3();
    if (keys.KeyW) move.add(forward);
    if (keys.KeyS) move.sub(forward);
    if (keys.KeyA) move.sub(right);
    if (keys.KeyD) move.add(right);
    move.normalize().multiplyScalar(speed);

    // Setting horizontal velocity directional (plus any knockback)
    // leave vertical to gravity
    playerBody.velocity.x = move.x + knockback.x;
    playerBody.velocity.z = move.z + knockback.z;
    knockback.multiplyScalar(Math.max(0, 1 - dt * 6));

    if (keys.Space && canJump) {
        playerBody.velocity.y = 8;
        canJump = false;
    }

    // camera follows physics body
    camera.position.set(
        playerBody.position.x,
        playerBody.position.y + EYE_HEIGHT,
        playerBody.position.z
    );
}

// Anything that hurts the player (hazards, husks, etc) should call this to apply knockback and damage and flash the screen red
const hurtEl = document.getElementById('hurt');
let hurtTimer = null;
function hurtPlayer(amount, fromPos = null, push = 0) {
    if (gameOver) return;
    health -= amount;

    hurtEl.style.opacity = Math.min(0.8, 0.25 + amount / 40);
    clearTimeout(hurtTimer);
    hurtTimer = setTimeout(() => (hurtEl.style.opacity = 0), 120);

    if (fromPos && push > 0) {
        const dx = playerBody.position.x - fromPos.x;
        const dz = playerBody.position.z - fromPos.z;
        const d = Math.hypot(dx, dz) || 1;
        knockback.x += (dx / d) * push;
        knockback.z += (dz / d) * push;
        if (push > 10) playerBody.velocity.y = 5; // big hits pop the player up a bit
    }
}



//------------------------------------------------
// Husks
const husks = [];
const HUSK_TURN = 0;
const HUSK_MODEL_SCALE = 2.4;

const HUSK_TYPES = {
    normal: { hp: 3, speed: 3.5, scale: 1, tint: null, damage: 15, aggroRange: 30, score: 100, drop: 0.3,
                lungeRange: 4.5, windup: 0.4, lungeSpeed: 11, lungeTime: 0.3 },
    runner: { hp: 1, speed: 7, scale: 0.75, tint: 0xd07040, damage: 8, aggroRange: 35, score: 75, drop: 0.15,
              lungeRange: 5, windup: 0.25, lungeSpeed: 16, lungeTime: 0.3 },
    brute:  { hp: 12, speed: 2.2, scale: 1.6, tint: 0x6a2a2a, damage: 30, aggroRange: 25, score: 300, drop: 1,
              lungeRange: 12, windup: 0.9, lungeSpeed: 14, lungeTime: 0.7, heavy: true },
}

// home: if given, the husk is a guard. It shuffles around home, only notices you
//       inside guardRadius, and walks back if you lead it too far away.
// alerted: spawn already hunting the player (ambushes, nest spawns, evac waves)
function createHusk(x, z, type = 'normal', { home = null, guardRadius = 12, alerted = false, y = 0 } = {}) {
    const t = HUSK_TYPES[type];
    const radius = 0.5 * t.scale;
    const mesh = spawnModel('husk', t.scale * HUSK_MODEL_SCALE, -radius);
    mesh.children[0].rotation.y = HUSK_TURN;

    if (t.tint) {
        const tint = new THREE.Color(t.tint);
        mesh.traverse((c) => { if (c.isMesh) c.material.color.lerp(tint, 0.6); });
    }

    const body = new CANNON.Body({
        mass: t.heavy ? 200 : 50,
        shape: new CANNON.Sphere(radius),
        position: new CANNON.Vec3(x, y + radius, z),
        fixedRotation: true,
    });
    world.addBody(body);
    mesh.position.copy(body.position);

    const husk = {
        type, t, mesh, body, radius,
        hp: t.hp, stun: 0, dead: false, deathTimer: 0,
        mode: home ? 'guard' : 'idle', // idle, guard, return, chase, windup, lunge
        modeTimer: 0,
        lungeDir: new THREE.Vector3(),
        lungeCooldown: 0,
        attackCooldown: 0,
        alertTimer: alerted ? 8 : 0,
        home: home ? { x: home.x, z: home.z } : null,
        guardRadius,
        wanderTarget: null,
        wanderTimer: 0,
    };
    mesh.userData.husk = husk;
    husks.push(husk);
    return husk;
}

// Spawn a list like [['runner', x, z], ['brute', x, z]] already hunting the player
function spawnGroup(list) {
    for (const [type, x, z] of list) createHusk(x, z, type, { alerted: true });
}

// Wake up every husk within radius of a point (gunshots, explosions, screams)
function alertHusks(x, z, radius) {
    for (const h of husks) {
        if (h.dead) continue;
        if (Math.hypot(h.body.position.x - x, h.body.position.z - z) < radius) {
            h.alertTimer = Math.max(h.alertTimer, 8);
        }
    }
}

function setGlow(mesh, hex) {
    mesh.traverse((c) => {
        if (c.isMesh && c.material.emissive) c.material.emissive.setHex(hex);
    });
}

function moveToward(h, tx, tz, speed) {
    const dx = tx - h.body.position.x;
    const dz = tz - h.body.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.1) {
        h.body.velocity.x = 0;
        h.body.velocity.z = 0;
    } else {
        h.body.velocity.x = (dx / d) * speed;
        h.body.velocity.z = (dz / d) * speed;
    }
    return d;
}

// Every staircase (filled in by buildMultiStory), so husks know how to get
// up, down, in and out of buildings: { area, floorY, bottom, top, doorIn, doorOut }
const stairways = [];
 
function inArea(a, x, z) {
    return x > a.x1 && x < a.x2 && z > a.z1 && z < a.z2;
}

// Handles enemy movement between buildings and floors.
function huskTarget(h, px, py, pz) {
    const hx = h.body.position.x;
    const hy = h.body.position.y;
    const hz = h.body.position.z;
    const near = (p, r = 1.3) => Math.hypot(hx - p.x, hz - p.z) < r;

    // Keeps enemies aligned with the stairs while climbing.
    const along = (dest) => {
        const dz = dest.z - hz;
        return Math.abs(dz) < 1.2 ? dest : { x: dest.x, z: hz + Math.sign(dz) };
    };

    const upper = FLOOR_H - 0.4;
    const pUp = py > upper;
    const hUp = hy > upper;
    const pB = stairways.find((s) => inArea(s.area, px, pz));
    const hB = stairways.find((s) => inArea(s.area, hx, hz));
    const chase = { x: px, z: pz };

    // Handles enemies already upstairs.
    if (hB && hUp) {
        if (h.stairStage === 'up') {
            if (near(hB.top, 1.0)) h.stairStage = null;
            else return along(hB.top);
        }
        if (pB === hB && pUp) {
            h.stairStage = null;
            return chase;
        }
        if (h.stairStage !== 'down' && near(hB.top, 1.0)) h.stairStage = 'down';
        return h.stairStage === 'down' ? along(hB.bottom) : hB.top;
    }

    // Handles enemies on or near the stairs.
    if (hB) {
        if (pB === hB && pUp) {
            // Larger enemies cannot use the stairs.
            if (h.t.heavy) return hB.bottom;
            if (h.stairStage !== 'up' && near(hB.bottom, 1.0)) h.stairStage = 'up';
            return h.stairStage === 'up' ? along(hB.top) : hB.bottom;
        }
        if (h.stairStage === 'down' && hy > 1) return along(hB.bottom);
        if (pB !== hB) {
            // Sends enemies outside through the building's door.
            if (h.stairStage !== 'exit' && near(hB.doorIn)) h.stairStage = 'exit';
            return h.stairStage === 'exit' ? hB.doorOut : hB.doorIn;
        }
        h.stairStage = null;
        return chase;
    }

    // Guides enemies outside toward the player's building.
    if (pB) {
        if (h.stairStage !== 'enter' && near(pB.doorOut)) h.stairStage = 'enter';
        return h.stairStage === 'enter' ? pB.doorIn : pB.doorOut;
    }

    h.stairStage = null;
    return chase;
}

function updateHusks(dt, time) {
    // Loop backwards so removing a dead husk doesn't skip the next one
    for (let i = husks.length - 1; i >= 0; i--) {
        const h = husks[i];

        // Dead husks: physics can fling them around before being removed
        if (h.dead) {
            h.mesh.position.copy(h.body.position);
            h.mesh.quaternion.copy(h.body.quaternion);
            h.deathTimer -= dt;
            if (h.deathTimer <= 0) {
                scene.remove(h.mesh);
                world.removeBody(h.body);
                husks.splice(i, 1);
            }
            continue;
        }

        const px = playerBody.position.x;
        const pz = playerBody.position.z;
        const dx = px - h.body.position.x;
        const dz = pz - h.body.position.z;
        const dist = Math.hypot(dx, dz);

        // only fight on the same floor as the player, otherwise wander around, don't bite through the ceiling/floir
        const sameFloor = Math.abs(playerBody.position.y - h.body.position.y) < 1.5;
        const inner = h.mesh.children[0];
        inner.scale.y = h.t.scale * HUSK_MODEL_SCALE; // undo the wind-up crouch

        h.alertTimer -= dt;
        h.lungeCooldown -= dt;
        h.attackCooldown -= dt;

        const hunting = h.mode === 'chase' || h.mode === 'windup' || h.mode === 'lunge';

        if (h.stun > 0) {
            // knocked back: slide to a stop, any lunge is cancelled
            h.stun -= dt;
            const slow = Math.max(0, 1 - dt * 5);
            h.body.velocity.x *= slow;
            h.body.velocity.z *= slow;
            if (h.mode === 'windup' || h.mode === 'lunge') {
                h.mode = 'chase';
                setGlow(h.mesh, 0x000000);
            }
        } else if (!hunting) {
            const noticeRange = h.home ? h.guardRadius : h.t.aggroRange;
            if (dist < noticeRange || h.alertTimer > 0) {
                // A husk that spots you on its own screams and wakes its friends
                if (h.alertTimer <= 0) alertHusks(h.body.position.x, h.body.position.z, 15);
                h.mode = 'chase';
            } else if (h.mode === 'return') {
                if (moveToward(h, h.home.x, h.home.z, h.t.speed) < 1.5) h.mode = 'guard';
            } else if (h.mode === 'guard') {
                // shuffle around near home
                h.wanderTimer -= dt;
                if (h.wanderTimer <= 0 || !h.wanderTarget) {
                    h.wanderTimer = 2 + Math.random() * 3;
                    const a = Math.random() * Math.PI * 2;
                    const r = Math.random() * h.guardRadius * 0.4;
                    h.wanderTarget = { x: h.home.x + Math.cos(a) * r, z: h.home.z + Math.sin(a) * r };
                }
                moveToward(h, h.wanderTarget.x, h.wanderTarget.z, h.t.speed * 0.3);
            } else {
                h.body.velocity.x = 0;
                h.body.velocity.z = 0;
            }
        } else if (h.mode === 'chase') {
            const interested = dist < h.t.aggroRange * 1.4 || h.alertTimer > 0;
            const farFromHome = h.home &&
                Math.hypot(h.body.position.x - h.home.x, h.body.position.z - h.home.z) > 35;

            if (!interested || (farFromHome && dist > 10 && h.alertTimer <= 0)) {
                // lost interest: guards go home, wanderers just stop
                h.mode = h.home ? 'return' : 'idle';
            } else if (sameFloor && dist < h.t.lungeRange && dist > 1.2 && h.lungeCooldown <= 0) {
                h.mode = 'windup';
                h.modeTimer = h.t.windup;
                setGlow(h.mesh, 0x663300);
            } else if (dist > h.radius + 0.6 || !sameFloor || h.stairStage) {
                const target = huskTarget(h, px, playerBody.position.y, pz);
                moveToward(h, target.x, target.z, h.t.speed);
            } else {
                h.body.velocity.x = 0;
                h.body.velocity.z = 0;
            }
        } else if (h.mode === 'windup') {
            // crouch and glow so the player can see the lunge coming and sidestep
            h.modeTimer -= dt;
            inner.scale.y = h.t.scale * HUSK_MODEL_SCALE * 0.8;
            h.body.velocity.x = 0;
            h.body.velocity.z = 0;
            if (h.modeTimer <= 0) {
                h.mode = 'lunge';
                h.modeTimer = h.t.lungeTime;
                h.lungeDir.set(dx, 0, dz).normalize();
                setGlow(h.mesh, 0x000000);
            }
        } else if (h.mode === 'lunge') {
            h.modeTimer -= dt;
            h.body.velocity.x = h.lungeDir.x * h.t.lungeSpeed;
            h.body.velocity.z = h.lungeDir.z * h.t.lungeSpeed;
            if (h.modeTimer <= 0) {
                h.mode = 'chase';
                h.lungeCooldown = 2 + Math.random();
            }
        }

        // Melee hit: one solid hit per second instead of constant drain
        if (sameFloor && dist < h.radius + 1.0 && h.attackCooldown <= 0 && h.stun <= 0 && !gameOver) {
            h.attackCooldown = h.t.heavy ? 1.5 : 1;
            hurtPlayer(h.t.damage, h.body.position, h.t.heavy ? 16 : 6);
            if (h.mode === 'lunge') {
                h.mode = 'chase';
                h.lungeCooldown = 2;
            }
        }

        h.mesh.position.copy(h.body.position);
        h.mesh.position.y += Math.abs(Math.sin(time * (h.mode === 'lunge' ? 20 : 8))) * 0.05;

        // face the player when hunting, otherwise face the way it's walking
        const vx = h.body.velocity.x;
        const vz = h.body.velocity.z;
        if (h.mode === 'chase' || h.mode === 'windup') {
            h.mesh.lookAt(px, h.mesh.position.y, pz);
        } else if (Math.hypot(vx, vz) > 0.2) {
            h.mesh.lookAt(h.mesh.position.x + vx, h.mesh.position.y, h.mesh.position.z + vz);
        }
    }
}

// dir: direction the hit came from (pushes the husk that way)
// force: multiplies how hard a killing blow flings the body
function damageHusk(h, amount, dir, force = 1) {
    if (h.dead) return;
    h.hp -= amount;
    h.alertTimer = Math.max(h.alertTimer, 8); // getting hurt makes them angry
    flashRed(h.mesh);

    if (h.hp <= 0) {
        killHusk(h, new CANNON.Vec3(dir.x * 400 * force, 400 * force, dir.z * 400 * force));
    } else if (!h.t.heavy) {
        // brutes shrug off bullets, everything else staggers
        h.stun = 0.3;
        h.body.velocity.set(dir.x * 6, 0, dir.z * 6);
    }
}

function killHusk(h, impulse) {
    if (h.dead) return;
    h.dead = true;
    h.deathTimer = 1.5;
    setGlow(h.mesh, 0x000000);

    const q = h.mesh.quaternion;
    h.body.quaternion.set(q.x, q.y, q.z, q.w);
    h.body.fixedRotation = false;
    h.body.updateMassProperties();
    h.body.applyImpulse(impulse.scale(h.body.mass / 50));
    score += h.t.score;

    // Loot! Dropped pickups vanish after a while
    const x = h.body.position.x;
    const z = h.body.position.z;
    const floorY = Math.max(0, h.body.position.y - h.radius - 0.1);
    if (Math.random() < h.t.drop) spawnPickup(Math.random() < 0.25 ? 'shells' : 'ammo', x, z, { temporary: true, y: floorY });
    if (h.type === 'brute') spawnPickup('medkit', x + 1, z, { temporary: true, y: floorY });
}


//------------------------------------------------
// Item Pick Ups (press E)
// respawn: seconds before a collected supply comes back (radio parts never respawn)
// length: weapons are sized by their longest size since blockbench scales vary from my models

const PICKUP_TYPES = {
    battery:     { model: 'battery', scale: 2, radio: true, label: 'the battery' },
    coil:        { model: 'coil', scale: 1.5, radio: true, label: 'the antenna coil' },
    transmitter: { model: 'transmitter', scale: 2, radio: true, label: 'the transmitter' },
    medkit:      { model: 'medkit', scale: 1.5, respawn: 60, label: 'Medkit' },
    ammo:        { model: 'ammo', scale: 1.5, respawn: 40, label: 'Pistol ammo' },
    shells:      { model: 'ammo', scale: 1.5, respawn: 50, label: 'Shotgun shells', tint: 0xb04a2a },
    shotgun:     { model: 'shotgun', weapon: 'shotgun', length: 0.9, label: 'the Shotgun' },
    machete:     { model: 'machete', weapon: 'machete', length: 0.7, label: 'the Machete' },
};

const pickups = [];

// temporary: loot dropped by husks/nests. Blinks and disappears after 25s, never respawns
// y: height of the floor it sits on (for pickups upstairs or on tables)
function spawnPickup(type, x, z, { temporary = false, y = 0 } = {}) {
    const config = PICKUP_TYPES[type];
    let mesh;
    if (config.length) {
        mesh = new THREE.Group();
        mesh.add(sizedModel(config.model, config.length));
        scene.add(mesh);
    } else {
        mesh = spawnModel(config.model, config.scale, 0);
    }
    if (config.tint) {
        const tint = new THREE.Color(config.tint);
        mesh.traverse((c) => { if (c.isMesh) c.material.color.lerp(tint, 0.6); });
    }
    mesh.position.set(x, y + 0.6, z);
 
    // radio parts get additional yellow glow to stand out in the fog
    if (config.radio) {
        const glow = new THREE.PointLight(0xffd84a, 3, 5);
        glow.position.y = 0.5;
        mesh.add(glow);
    }

    const p = { type, mesh, baseY: y, collected: false, respawnTimer: 0, temporary, life: 25 };
    pickups.push(p);
    return p;
}

function collect(p) {
    const config = PICKUP_TYPES[p.type];

    // don't waste a medkit at full health, leave it for later
    if (p.type === 'medkit' && health >= 100) {
        showMessage('Your health is already full.', 1.5);
        return;
    }

    p.collected = true;
    if (config.respawn && !p.temporary) {
        // hide it and start the respawn countdown
        p.mesh.visible = false;
        p.respawnTimer = config.respawn;
    } else {
        scene.remove(p.mesh);
    }
 
    if (config.radio) {
        partsFound++;
        score += 100;
        if (partsFound === 3) {
            showMessage('All parts found! Get to the radio tower.', 5);
        } else {
            showMessage(`Found ${config.label}! (${partsFound}/3)`);
        }
    } else if (config.weapon) {
        giveWeapon(config.weapon);
        if (config.weapon === 'shotgun') shells += 6;
        showMessage(`Picked up ${config.label}! Press ${WEAPONS[config.weapon].slot} to switch to it.`, 3.5);
    } else if (p.type === 'medkit') {
        health = Math.min(100, health + 35);
        showMessage('+35 health');
    } else if (p.type === 'ammo') {
        ammo += 15;
        showMessage('+15 pistol ammo');
    } else if (p.type === 'shells') {
        shells += 6;
        showMessage('+6 shotgun shells');
    }
}


function updatePickups(dt, time) {
    for (let i = pickups.length - 1; i >= 0; i--) {
        const p = pickups[i];

        if (p.collected) {
            if (p.respawnTimer > 0) {
                p.respawnTimer -= dt;
                if (p.respawnTimer <= 0) {
                    p.collected = false;
                    p.mesh.visible = true;
                }
            } else {
                pickups.splice(i, 1); // radio parts, weapons & loot are gone for good
            }
            continue;
        }

        if (p.temporary) {
            p.life -= dt;
            if (p.life <= 0) {
                scene.remove(p.mesh);
                pickups.splice(i, 1);
                continue;
            }
            // blink during the last 5 seconds
            p.mesh.visible = p.life > 5 || Math.sin(time * 20) > 0;
        }

        p.mesh.rotation.y += dt * 1.5;
        p.mesh.position.y = p.baseY + 0.6 + Math.sin(time * 2) * 0.15;
    }
}

//------------------------------------------------
// Game Easter Eggs

const secrets = [];
let secretsFound = 0;

// Building a small object from boxes and registering it as a secret
// y: height it sits at (a table, an upper floor)
function addSecret(x, z, build, message, y = 0) {
    const g = new THREE.Group();
    build(g);
    g.position.set(x, y, z);
    scene.add(g);
    secrets.push({ x, y, z, message, found: false });
}

function buildSecrets() {
    // 1. Survivor's note on the floor inside collapsed house
    addSecret(...at('house', -2.5, -1.5), (g) => notePaper(g),
        'A scrawled note: "Day 212. The Bloom took Marcus today. Tower 9 still has power... I think"');
 
    // 2. A lonely teddy bear near the crash site
    addSecret(...at('crash', -8, -8), (g) => {
        const FUR = 0x9c7a55;
        part(g, 0.35, 0.4, 0.25, 0, 0.2, 0, FUR);
        part(g, 0.3, 0.28, 0.25, 0, 0.54, 0, FUR);
        part(g, 0.1, 0.1, 0.06, -0.12, 0.72, 0, FUR);
        part(g, 0.1, 0.1, 0.06, 0.12, 0.72, 0, FUR);
        part(g, 0.04, 0.04, 0.02, 0.06, 0.56, 0.13, 0x111111);
        part(g, 0.1, 0.1, 0.05, 0, 0.48, 0.13, 0xc4a77f);
    }, 'A sun bleached teddy bear, missing an eye. Someone loved this once. I wonder if they made it out.');
 
    // RIP (;
    addSecret(-12, -62, (g) => {
        part(g, 0.8, 0.15, 1.4, 0, 0.07, 0, 0x6e5a48);
        part(g, 0.1, 1.0, 0.1, 0, 0.5, -0.6, 0x594638);
        part(g, 0.5, 0.1, 0.1, 0, 0.75, -0.6, 0x594638);
    }, 'Here lies Renee\'s sleep schedule. 2026-2026. Gone but not forgotten');
}

//------------------------------------------------
// Interacting (E), picking things up and reading notes
const promptEl = document.getElementById('prompt');
const noteEl = document.getElementById('note');
const noteTextEl = document.getElementById('note-text');
const noteCountEl = document.getElementById('note-count');
const REACH = 2;     // how close you need to be
let focus = null;    // what E would use right now: { pickup } or { secret }
let openNote = null; // the secret currently shown on screen
 
function updateInteraction() {
    const px = playerBody.position.x;
    const pz = playerBody.position.z;
    const feet = playerBody.position.y - 0.5; // height of the floor you're standing on
    let best = null;
    let bestDist = REACH;
 
    for (const p of pickups) {
        if (p.collected) continue;
        const d = Math.hypot(px - p.mesh.position.x, pz - p.mesh.position.z);
        if (d < bestDist && Math.abs(feet - p.baseY) < 1.5) {
            best = { pickup: p };
            bestDist = d;
        }
    }
    for (const s of secrets) {
        const d = Math.hypot(px - s.x, pz - s.z);
        if (d < bestDist && Math.abs(feet - s.y) < 1.5) {
            best = { secret: s };
            bestDist = d;
        }
    }
    focus = best;
 
    // walking away closes the note
    if (openNote && (!focus || focus.secret !== openNote)) closeNote();
 
    if (!focus || openNote) {
        promptEl.style.display = 'none';
        return;
    }
    promptEl.style.display = 'block';
    if (focus.pickup) {
        const p = focus.pickup;
        promptEl.textContent = p.type === 'medkit' && health >= 100
            ? 'Medkit (your health is full)'
            : `[E] Pick up ${PICKUP_TYPES[p.type].label}`;
    } else {
        promptEl.textContent = focus.secret.found ? '[E] Read again' : '[E] Read';
    }
}
 
function interact() {
    if (openNote) {
        closeNote();
        return;
    }
    if (!focus) return;
    if (focus.pickup) collect(focus.pickup);
    else openSecret(focus.secret);
}
 
function openSecret(s) {
    if (!s.found) {
        // first time reading: count it and give the score
        s.found = true;
        secretsFound++;
        score += 50;
    }
    openNote = s;
    noteTextEl.textContent = s.message;
    noteCountEl.textContent = `Secrets found: ${secretsFound}/${secrets.length}`;
    noteEl.style.display = 'block';
    promptEl.style.display = 'none';
}
 
function closeNote() {
    openNote = null;
    noteEl.style.display = 'none';
}

//------------------------------------------------
// Bloom Nests
// Glowing ods inside buildings that keep spawning husks until you destroy them.
const nests = [];
const NEST_GLOW = 0x66ff44;
const NEST_SCALE = 2.4; // same as the husks, if the nest is built at the same Blockbench scale
 
function spawnNest(x, z) {
    const g = new THREE.Group();
 
    let pod;
    if (models.nest) {
        pod = spawnModel('nest', NEST_SCALE, 0);
        g.add(pod);
        // only the "core" group glows, the rest keeps its texture
        const core = pod.getObjectByName('core');
        if (core) core.traverse((c) => {
            if (c.isMesh) {
                c.material.emissive.setHex(NEST_GLOW);
                c.material.emissiveIntensity = 0.6;
            }
        });
    } else {
        pod = new THREE.Mesh(
            new THREE.SphereGeometry(0.8, 12, 10),
            new THREE.MeshStandardMaterial({ color: 0x3f6a2a, emissive: NEST_GLOW, emissiveIntensity: 0.5, flatShading: true })
        );
        pod.position.y = 0.9;
        g.add(pod);
 
        // roots spreading out across the floor
        for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2;
            part(g, 0.15, 0.1, 1.6, Math.cos(a) * 1.1, 0.05, Math.sin(a) * 1.1, 0x2f4a22, 0, Math.PI / 2 - a, 0);
        }
    }
 
    const light = new THREE.PointLight(NEST_GLOW, 4, 10);
    light.position.y = 1;
    g.add(light);
 
    g.position.set(x, 0, z);
    scene.add(g);
 
    const nest = { group: g, pod, light, x, z, hp: 12, spawnTimer: 3, dead: false, baseScale: pod.scale.x };
    g.userData.nest = nest;
    nests.push(nest);
}
 
function updateNests(dt, time) {
    for (const n of nests) {
        if (n.dead) continue;
 
        // slow breathing pulse
        n.pod.scale.setScalar(n.baseScale * (1 + Math.sin(time * 3) * 0.06));
 
        // only active while the player is nearby
        const dist = Math.hypot(playerBody.position.x - n.x, playerBody.position.z - n.z);
        if (dist > 35) continue;
 
        n.spawnTimer -= dt;
        if (n.spawnTimer > 0) continue;
        n.spawnTimer = 10;
 
        // cap how many husks one nest can have around it
        const nearby = husks.filter((h) => !h.dead &&
            Math.hypot(h.body.position.x - n.x, h.body.position.z - n.z) < 15).length;
        if (nearby >= 5) continue;
 
        const a = Math.random() * Math.PI * 2;
        createHusk(n.x + Math.cos(a) * 1.5, n.z + Math.sin(a) * 1.5,
            Math.random() < 0.3 ? 'runner' : 'normal',
            { home: { x: n.x, z: n.z }, alerted: dist < 20 });
    }
}
 
function damageNest(n, amount) {
    if (n.dead) return;
    n.hp -= amount;
    // flash the light red (works for the model and the egg)
    n.light.color.setHex(0xff3030);
    setTimeout(() => n.light.color.setHex(NEST_GLOW), 100);
    if (n.hp <= 0) destroyNest(n);
}
 
function destroyNest(n) {
    n.dead = true;
    scene.remove(n.group);
    score += 250;
    spawnPickup('ammo', n.x + 1, n.z, { temporary: true });
    spawnPickup('medkit', n.x - 1, n.z, { temporary: true });
    alertHusks(n.x, n.z, 25);
    const left = nests.filter((other) => !other.dead).length;
    showMessage(`Bloom nest destroyed! (${nests.length - left}/${nests.length})`);
}


//------------------------------------------------
// Melee Shove (F)
// Never helpless: shove husks in front of you away, even with 0 ammo
let meleeCooldown = 0;

function shove() {
    if (meleeCooldown > 0) return;
    meleeCooldown = 0.7;

    // jab the gun forward
    gun.position.z -= 0.25;
    gun.position.y += 0.05;

    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();

    let hitSomething = false;
    for (const h of husks) {
        if (h.dead || Math.abs(h.body.position.y - playerBody.position.y) > 1.5) continue;
        const dx = h.body.position.x - playerBody.position.x;
        const dz = h.body.position.z - playerBody.position.z;
        const d = Math.hypot(dx, dz) || 0.01;
        // in range and roughly in front of us?
        if (d > 2.6 + h.radius || (dx * forward.x + dz * forward.z) / d < 0.4) continue;

        hitSomething = true;
        const dir = new THREE.Vector3(dx / d, 0, dz / d);
        if (h.t.heavy) {
            // brutes barely budge, but it does interrupt a charge
            h.stun = 0.4;
            flashRed(h.mesh);
        } else {
            damageHusk(h, 1, dir);
            if (!h.dead) {
                h.stun = 1;
                h.body.velocity.set(dir.x * 10, 0, dir.z * 10);
            }
        }
    }
    if (hitSomething) hitMarker();
}


//------------------------------------------------
// Evac Route
// After the signal goes out, the chopper lands at an LZ south of the tower.
// A walled-in road leads there with wrecks, wire, fire, a barricade and ambushes.
const LZ_POS = new THREE.Vector3(0, 0, -138);
const LAND_TIME = 45; // seconds the player must hold the LZ
const LZ_SPAWNS = [[-13, -153], [13, -153], [-13, -124], [13, -124], [0, -153]];

// Straight rubble/concrete wall from (x1,z1) to (x2,z2). Must be along the x or z axis.
function buildWall(x1, z1, x2, z2) {
    const alongX = Math.abs(x2 - x1) > Math.abs(z2 - z1);
    const len = alongX ? Math.abs(x2 - x1) : Math.abs(z2 - z1);
    const cx = (x1 + x2) / 2;
    const cz = (z1 + z2) / 2;
    const g = new THREE.Group();

    const slabs = Math.max(1, Math.round(len / 2));
    const COLORS = [0x7a7064, 0x6e655a, 0x857a6b];
    for (let i = 0; i < slabs; i++) {
        const offset = ((i + 0.5) / slabs - 0.5) * len;
        const h = 2.4 + Math.random() * 0.9;
        const jitter = (Math.random() - 0.5) * 0.15;
        const w = len / slabs + 0.05;
        part(g, alongX ? w : 0.6, h, alongX ? 0.6 : w,
            alongX ? offset : jitter, h / 2, alongX ? jitter : offset,
            COLORS[i % 3], 0, 0, (Math.random() - 0.5) * 0.06);

        // rubble piled at the base now and then
        if (Math.random() < 0.3) {
            part(g, 0.7, 0.45, 0.7, alongX ? offset : 0.7, 0.2, alongX ? 0.7 : offset,
                0x6e5a48, 0.3, Math.random(), 0.2);
        }
    }

    finishBuilding(g, cx, cz);
    addStaticCollider(alongX ? len : 0.6, 3.3, alongX ? 0.6 : len, cx, cz);
}

// Cars are props: buildCar() just records where they go while the world is built,
// spawnCars() (called from spawnEntities) creates them, so R puts them back.
const carSpawns = [];
function buildCar(x, z, rotY = 0, color = 0x6a5a4a, burnt = false) {
    carSpawns.push({ x, z, rotY, color, burnt });
}

// The car's look, built out of boxes like the bus. Length runs along x.
function buildCarModel(color, burnt) {
    const g = new THREE.Group();
    const BODY = burnt ? 0x2e2a26 : color;
    const DARK = 0x2a2724;
    const GLASS = 0x3e4a48;
    const RUST = 0x75452f;

    part(g, 4.2, 0.8, 1.9, 0, 0.7, 0, BODY);                   // lower body
    part(g, 2.2, 0.7, 1.7, -0.2, 1.45, 0, BODY);               // cabin
    part(g, 0.06, 0.6, 1.6, 0.95, 1.4, 0, GLASS, 0, 0, -0.5);  // windshield
    for (const sx of [-1.3, 1.3]) {
        for (const sz of [-0.95, 0.95]) part(g, 0.7, 0.7, 0.3, sx, 0.35, sz, DARK); // wheels
    }
    part(g, 0.9, 0.3, 0.02, 0.8, 0.75, 0.96, RUST);
    part(g, 0.6, 0.25, 0.02, -1.2, 0.6, -0.96, RUST);
    part(g, 1.2, 0.05, 1.0, 1.4, 1.12, 0.1, BODY, 0, 0.2, 0.3); // hood popped open
    mergeGroup(g);
    return g;
}

function spawnCar({ x, z, rotY, color, burnt }) {
    const model = buildCarModel(color, burnt);
    model.position.y = -0.9; // physics box is centered, the model's origin is at the ground

    const holder = new THREE.Group();
    holder.add(model);
    scene.add(holder);

    // frozen in place (mass 0) until a blast wakes it up, just like the bus
    const body = new CANNON.Body({ mass: 0, position: new CANNON.Vec3(x, 0.9, z) });
    body.addShape(new CANNON.Box(new CANNON.Vec3(2.15, 0.9, 1.0)));
    body.quaternion.setFromEuler(0, rotY, 0);
    body.linearDamping = 0.5;  // the ground has no friction, so this stops them sliding forever
    body.angularDamping = 0.5;
    world.addBody(body);

    const prop = { mesh: holder, body, dormant: true, blastScale: 12, wakeMass: 250 };
    holder.userData.prop = prop;
    props.push(prop);
}

function spawnCars() {
    for (const c of carSpawns) spawnCar(c);
}

// Hazard zones: rectangles the player gets hurt/slowed in
const hazards = [];
const fires = [];

function buildWire(z, x1, x2) {
    const g = new THREE.Group();
    for (let x = x1; x <= x2; x += 2) {
        part(g, 0.1, 1.1, 0.1, x, 0.55, (Math.random() - 0.5) * 0.4, 0x4a3f35,
            (Math.random() - 0.5) * 0.1, 0, (Math.random() - 0.5) * 0.15);
    }
    for (const y of [0.3, 0.6, 0.9]) {
        for (const dz of [-0.5, 0, 0.5]) {
            part(g, x2 - x1, 0.025, 0.025, (x1 + x2) / 2, y + Math.random() * 0.1, dz,
                0x8a8a80, Math.random() * 0.2, 0, 0);
        }
    }
    g.position.set(0, 0, z);
    scene.add(g); // not an obstacle, bullets pass through
    hazards.push({ type: 'wire', x1, x2, z1: z - 1.2, z2: z + 1.2, warned: false,
        warning: 'Barbed wire! It slows you down.' });
}

function buildFire(x, z, w, d) {
    const g = new THREE.Group();
    const flames = [];
    for (let i = 0; i < 14; i++) {
        const flame = new THREE.Mesh(
            new THREE.ConeGeometry(0.35 + Math.random() * 0.3, 1.2 + Math.random(), 6),
            new THREE.MeshBasicMaterial({ color: i % 3 ? 0xff7a20 : 0xffc040, transparent: true, opacity: 0.85 })
        );
        flame.position.set((Math.random() - 0.5) * w, 0.6, (Math.random() - 0.5) * d);
        flame.userData.phase = Math.random() * 10;
        g.add(flame);
        flames.push(flame);
    }
    const light = new THREE.PointLight(0xff7020, 8, 14);
    light.position.y = 1.5;
    g.add(light);
    g.position.set(x, 0, z);
    scene.add(g);

    fires.push({ flames, light });
    hazards.push({ type: 'fire', x1: x - w / 2, x2: x + w / 2, z1: z - d / 2, z2: z + d / 2, warned: false,
        warning: "You're on fire! Get out!" });
}

function updateHazards(dt, time) {
    for (const f of fires) {
        for (const flame of f.flames) {
            flame.scale.y = 1 + 0.35 * Math.sin(time * 12 + flame.userData.phase);
        }
        f.light.intensity = 6 + Math.random() * 4;
    }

    hazardSlow = 1;
    const px = playerBody.position.x;
    const pz = playerBody.position.z;
    for (const zone of hazards) {
        if (px < zone.x1 || px > zone.x2 || pz < zone.z1 || pz > zone.z2) continue;
        if (!zone.warned) {
            zone.warned = true;
            showMessage(zone.warning, 2);
        }
        if (zone.type === 'fire') hurtPlayer(20 * dt);
        if (zone.type === 'wire') {
            hazardSlow = 0.4;
            hurtPlayer(4 * dt);
        }
    }
}

// Flare: glowing stick on the ground marking the route (no light, cheap)
function buildFlare(x, z) {
    const flare = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.06, 0.4, 6),
        new THREE.MeshBasicMaterial({ color: 0xff3020 })
    );
    flare.position.set(x, 0.2, z);
    flare.rotation.z = 0.5;
    scene.add(flare);
}

// The barricade blocks the road until something blows it up (or you shoot it to pieces)
let barricade = null;

function spawnBarricade(z) {
    const g = new THREE.Group();
    for (let x = -6.3; x <= 6.4; x += 1.4) {
        part(g, 1.3, 1.2, 1.2, x, 0.6, (Math.random() - 0.5) * 0.3, 0x6b5238, 0, Math.random() * 0.3, 0);
        if (Math.random() < 0.7) {
            part(g, 1.2, 1.1, 1.1, x + (Math.random() - 0.5) * 0.4, 1.75, 0, 0x7a6040, 0, Math.random() * 0.4, 0);
        }
    }
    part(g, 14.5, 0.25, 0.1, 0, 1.0, 0.7, 0x594638, 0, 0, 0.04);
    part(g, 14.5, 0.25, 0.1, 0, 2.1, 0.7, 0x594638, 0, 0, -0.05);
    part(g, 3, 1.6, 0.06, -3, 1.4, 0.75, 0x777269, 0, 0, 0.1);
    part(g, 2.4, 1.3, 0.06, 3.5, 1.2, 0.75, 0x75452f, 0, 0, -0.08);
    g.position.set(0, 0, z);
    scene.add(g);

    const body = new CANNON.Body({
        mass: 0,
        shape: new CANNON.Box(new CANNON.Vec3(7.3, 3, 0.7)),
        position: new CANNON.Vec3(0, 3, z),
    });
    world.addBody(body);

    barricade = { group: g, body, hp: 30, z };
    g.userData.barricade = barricade;
}

function damageBarricade(amount) {
    if (!barricade) return;
    barricade.hp -= amount;
    if (barricade.hp <= 0) breakBarricade();
}

function breakBarricade() {
    if (!barricade) return;
    const { group, body, z } = barricade;
    scene.remove(group);
    world.removeBody(body);
    barricade = null;

    // a few crates go flying as debris
    for (let i = 0; i < 5; i++) {
        spawnCrate(-5 + i * 2.5, z);
        props[props.length - 1].body.applyImpulse(
            new CANNON.Vec3((Math.random() - 0.5) * 30, 40, -20 - Math.random() * 30)
        );
    }
    showMessage('The barricade is down!', 2.5);

    // the noise brings out whatever was hiding behind it
    spawnGroup([['normal', -3, z - 8], ['normal', 3, z - 9], ['runner', 0, z - 12], ['runner', -5, z - 14]]);
}

// Ambush triggers: fire once when the player walks south past a z line on the road
const triggers = [];

function setupTriggers() {
    triggers.length = 0;
    triggers.push(
        { z: -70, run: () => spawnGroup([['runner', -3, -86], ['runner', 3, -88], ['runner', 0, -90]]) },
        { z: -90, run: () => { if (barricade) showMessage('A barricade blocks the road. Those barrels look useful...', 4); } },
        { z: -101, run: () => spawnGroup([['brute', 0, -118], ['normal', 3, -119], ['normal', -2, -121]]) },
    );
    for (const t of triggers) t.fired = false;
}

function updateTriggers() {
    const px = playerBody.position.x;
    const pz = playerBody.position.z;
    if (Math.abs(px) > 8) return; // only on the road
    for (const t of triggers) {
        if (!t.fired && pz < t.z) {
            t.fired = true;
            t.run();
        }
    }
}

// Evac chopper, built from boxes. Circles the LZ after the signal, then lands.
let chopper;
let rotor;

function buildChopper() {
    const g = new THREE.Group();
    const BODY = 0x4a5240;
    const DARK = 0x23241f;
    const GLASS = 0x3e4a48;

    part(g, 2.2, 1.8, 4.2, 0, 1.6, 0, BODY);       // cabin
    part(g, 1.9, 1.0, 1.0, 0, 1.9, -2.4, GLASS);   // nose window
    part(g, 0.5, 0.5, 5, 0, 2.1, 4.4, BODY);       // tail boom
    part(g, 0.15, 1.5, 0.9, 0, 2.8, 6.7, BODY);    // tail fin
    part(g, 0.2, 0.4, 0.2, 0, 2.6, 0, DARK);       // rotor mast
    for (const sx of [-1, 1]) {
        part(g, 0.12, 0.12, 4.2, sx, 0.1, 0, DARK); // skids
        for (const sz of [-1.2, 1.2]) part(g, 0.1, 0.6, 0.1, sx, 0.4, sz, DARK);
    }

    rotor = new THREE.Group();
    part(rotor, 9, 0.08, 0.35, 0, 0, 0, DARK);
    part(rotor, 0.35, 0.08, 9, 0, 0, 0, DARK);
    rotor.position.y = 2.8;
    g.add(rotor);

    g.visible = false;
    scene.add(g);
    chopper = g;
}

function buildEvacRoute() {
    // Road walls from the tower down to the LZ
    buildWall(-7.3, -60, -7.3, -120);
    buildWall(7.3, -60, 7.3, -120);

    // LZ enclosure, only open where the road comes in
    buildWall(-16, -120, -16, -156);
    buildWall(16, -120, 16, -156);
    buildWall(-16, -156, 16, -156);
    buildWall(-16, -120, -7.3, -120);
    buildWall(7.3, -120, 16, -120);

    // Wrecks you have to weave around
    buildCar(-4, -67, 0.1, 0x5a6a70);
    buildCar(-1.8, -70, -0.35, 0x7a4a3a);
    buildCar(4, -84, -0.15, 0x6a5a4a, true);
    buildCar(-4, -116, 0.1, 0x55604a);

    // Hazards
    buildWire(-76, -7, 7);
    buildCar(4, -109, 0.3, 0, true); // the burning one
    buildFire(3.8, -109, 6.4, 6);

    // Supply cache halfway: tarp over two posts
    part(scene, 0.15, 2.4, 0.15, -6.5, 1.2, -88, 0x594638);
    part(scene, 0.15, 2.4, 0.15, -6.5, 1.2, -92, 0x594638);
    part(scene, 2.2, 0.06, 4.6, -5.6, 2.3, -90, 0x5a6a50, 0, 0, -0.15);

    // Flares marking the way
    for (let z = -62; z >= -118; z -= 12) {
        buildFlare(-6, z);
        buildFlare(6, z - 6);
    }

    // Helipad: concrete square with an "H"
    const PAD = 0x8a8478;
    const MARK = 0xd8c88a;
    part(scene, 10, 0.06, 10, LZ_POS.x, 0.03, LZ_POS.z, PAD);
    part(scene, 0.6, 0.07, 5, LZ_POS.x - 1.6, 0.04, LZ_POS.z, MARK);
    part(scene, 0.6, 0.07, 5, LZ_POS.x + 1.6, 0.04, LZ_POS.z, MARK);
    part(scene, 2.6, 0.07, 0.6, LZ_POS.x, 0.04, LZ_POS.z, MARK);
    for (const [fx, fz] of [[-5, -5], [5, -5], [-5, 5], [5, 5]]) buildFlare(LZ_POS.x + fx, LZ_POS.z + fz);

    // Green smoke column so you can spot the LZ from the tower
    const smoke = new THREE.Mesh(
        new THREE.CylinderGeometry(1.2, 2, 30, 10, 1, true),
        new THREE.MeshBasicMaterial({ color: 0x66ff66, transparent: true, opacity: 0.18, depthWrite: false })
    );
    smoke.position.set(LZ_POS.x + 6, 15, LZ_POS.z - 6);
    scene.add(smoke);

    buildChopper();
}

//------------------------------------------------
// OUTSKIRTS: five new locations + the journal pages that tell the Bloom's story
// Story order (players can find them in any order):
//   Farm (Day 1) -> Checkpoint bulletin -> Diner (Day 96) -> Chapel (Day 150)
//   -> Crashed EVAC-2 recorder -> your existing house note (Day 212)
 
// Small paper note, same look as the one in the collapsed house
function notePaper(g, y = 0.01) {
    part(g, 0.3, 0.002, 0.4, 0, y, 0, 0xe8e0c8, 0, 0.4, 0);
    part(g, 0.2, 0.025, 0.03, 0, y + 0.002, -0.05, 0x333333, 0, 0.3, 0);
    part(g, 0.2, 0.025, 0.03, 0, y + 0.002, 0.05, 0x333333, 0, 0.4, 0);
}
 
 
// MILITARY QUARANTINE CHECKPOINT
// Two tents, a sandbag wall with a gate, fence, floodlight and an abandoned jeep
function buildCheckpoint(x, z) {
    const g = new THREE.Group();
    const OLIVE = 0x4f5536;
    const CANVAS = 0x6b6a4a;
    const SAND = 0x8f7f5c;
    const DARK = 0x2f312a;
    const METAL = 0x6d6a60;
    const RED = 0x8a3a2a;
    const WHITE = 0xcfc8b0;
 
    // Two army tents: canvas body, peaked roof, open flap facing the camp
    for (const tx of [-6, 6]) {
        part(g, 5, 2.2, 4, tx, 1.1, -4, CANVAS);
        part(g, 5.2, 0.12, 2.4, tx, 2.6, -5, OLIVE, -0.5, 0, 0);
        part(g, 5.2, 0.12, 2.4, tx, 2.6, -3, OLIVE, 0.5, 0, 0);
        part(g, 1.2, 1.8, 0.05, tx, 0.9, -1.97, DARK);
    }
 
    // Field desk infront of the left tent, with a dead radio on it
    part(g, 1.6, 0.08, 0.9, -6, 0.75, -0.9, OLIVE);
    for (const [lx, lz] of [[-0.7, -0.4], [0.7, -0.4], [-0.7, 0.4], [0.7, 0.4]]) {
        part(g, 0.06, 0.75, 0.06, -6 + lx, 0.37, -0.9 + lz, DARK);
    }
    part(g, 0.4, 0.25, 0.3, -5.5, 0.92, -1.1, DARK);
 
    // Sandbag wall with a gap in the middle for the gate
    for (let sx = -9; sx <= 9; sx += 0.9) {
        if (Math.abs(sx) < 2) continue;
        for (let row = 0; row < 3; row++) {
            part(g, 0.85, 0.35, 0.5, sx + (row % 2) * 0.4, 0.18 + row * 0.33, 3.5, SAND,
                0, (Math.random() - 0.5) * 0.1, 0);
        }
    }
 
    // Gate: post and a red/white boom arm, snapped and hanging
    part(g, 0.3, 1.2, 0.3, 2.3, 0.6, 3.5, METAL);
    for (let i = 0; i < 4; i++) {
        part(g, 1, 0.15, 0.15, 1.8 - i, 1.15 - i * 0.15, 3.5, i % 2 ? RED : WHITE, 0, 0, 0.15);
    }
 
    // Fence along the back
    for (let fx = -10; fx <= 10; fx += 2.5) if (Math.abs(fx) > 3) part(g, 0.12, 2.2, 0.12, fx, 1.1, -8, METAL);
    for (const y of [0.4, 1.2, 2.0]) for (const s of [-1, 1]) part(g, 7, 0.04, 0.04, s * 6.5, y, -8, METAL);
    part(g, 6, 1.8, 0.03, -6, 1.1, -8, 0x5a5a52, 0, 0, 0.05); // sagging fence panel
 
    // Quarantine sign
    part(g, 0.15, 3, 0.15, -9, 1.5, 4.5, METAL);
    part(g, 2.2, 1.2, 0.08, -9, 2.6, 4.55, WHITE);
    part(g, 2.0, 0.25, 0.09, -9, 2.95, 4.58, RED);
 
    // Floodlight tower and supply crates
    part(g, 0.2, 5, 0.2, 9, 2.5, -6, METAL);
    part(g, 1.4, 0.6, 0.4, 9, 5.1, -6, DARK, 0.3, 0, 0);
    part(g, 1, 1, 1, 8, 0.5, -1, OLIVE);
    part(g, 1, 1, 1, 8.2, 1.5, -1.1, OLIVE, 0, 0.3, 0);
    part(g, 1, 0.6, 0.8, 9.2, 0.3, -0.5, OLIVE, 0, 0.2, 0);
 
    finishBuilding(g, x, z);
    buildCar(x + 7, z + 6, 0.4, OLIVE); // abandoned army jeep (has its own collider)
 
    // Colliders: tents, both halves of the sandbag wall, fence, crates
    addStaticCollider(5, 2.2, 4, x - 6, z - 4);
    addStaticCollider(5, 2.2, 4, x + 6, z - 4);
    addStaticCollider(7.6, 1.1, 0.6, x - 5.6, z + 3.5);
    addStaticCollider(7.6, 1.1, 0.6, x + 6.0, z + 3.5);
    addStaticCollider(7, 2.2, 0.2, x - 6.5, z - 8);
    addStaticCollider(7, 2.2, 0.2, x + 6.5, z - 8);
    addStaticCollider(2, 2, 1.2, x + 8.5, z - 1);
}
 
 
// ROADSIDE DINER
// Long building with the door on the west side, counter and booths inside,
// tall sign and a parking lot out front
function buildDiner(x, z) {
    const g = new THREE.Group();
    const WALL = 0xa8a090;
    const TRIM = 0x8a3a2a;
    const ROOF = 0x4a4540;
    const GLASS = 0x52605c;
    const CHROME = 0x9a968c;
    const COUNTER = 0x7a5a40;
    const SEAT = 0x7a2a2a;
    const CONCRETE = 0x777064;
 
    // Walls: door gap in the west wall
    part(g, 0.35, 3.4, 7, 6, 1.7, 0, WALL);          // back (east)
    part(g, 12, 3.4, 0.35, 0, 1.7, -3.5, WALL);      // north
    part(g, 12, 1.1, 0.35, 0, 0.55, 3.5, WALL);      // south, below the windows
    part(g, 12, 0.7, 0.35, 0, 3.05, 3.5, WALL);      // south, above the windows
    part(g, 0.35, 3.4, 2.5, -6, 1.7, -2.25, WALL);   // west, left of the door
    part(g, 0.35, 3.4, 2.5, -6, 1.7, 2.25, WALL);    // west, right of the door
    part(g, 0.35, 0.8, 2.0, -6, 3.0, 0, WALL);       // over the door
 
    // Big front windows: two intact, one shattered, one missing
    for (const mx of [-3, 0, 3]) part(g, 0.15, 1.6, 0.4, mx, 1.9, 3.5, CHROME);
    part(g, 2.8, 1.5, 0.06, -4.5, 1.9, 3.5, GLASS);
    part(g, 2.8, 1.5, 0.06, 1.5, 1.9, 3.5, GLASS);
    part(g, 1.2, 0.7, 0.06, -1.9, 1.5, 3.5, GLASS, 0, 0, 0.4);
 
    // Red trim stripes and flat roof
    part(g, 12.1, 0.2, 0.05, 0, 1.0, 3.7, TRIM);
    part(g, 12.1, 0.2, 0.05, 0, 1.0, -3.7, TRIM);
    part(g, 12.8, 0.3, 7.8, 0, 3.55, 0, ROOF);
    part(g, 12.8, 0.4, 0.1, 0, 3.4, 3.95, TRIM);
 
    // Counter with a chrome top and a row of stools (one knocked over)
    part(g, 7, 1.0, 0.8, 1, 0.5, -2.4, COUNTER);
    part(g, 7.2, 0.08, 1.0, 1, 1.04, -2.4, CHROME);
    for (let sx = -1.5; sx <= 3.5; sx += 1.25) {
        if (Math.abs(sx - 1) < 0.1) continue;
        part(g, 0.12, 0.7, 0.12, sx, 0.35, -1.5, CHROME);
        part(g, 0.45, 0.1, 0.45, sx, 0.72, -1.5, SEAT);
    }
    part(g, 0.45, 0.1, 0.45, 1.2, 0.22, -0.8, SEAT, 1.4, 0.3, 0);
    part(g, 0.12, 0.7, 0.12, 1.0, 0.1, -0.5, CHROME, 1.5, 0.3, 0);
 
    // Booths along the window wall
    for (const bx of [-4, -1, 2]) {
        part(g, 1.2, 0.08, 0.8, bx, 0.75, 2.6, COUNTER);
        part(g, 0.1, 0.75, 0.1, bx, 0.37, 2.6, CHROME);
        for (const side of [-1, 1]) {
            part(g, 0.5, 0.5, 0.8, bx + side * 0.95, 0.25, 2.6, SEAT);
            part(g, 0.15, 1.0, 0.8, bx + side * 1.2, 0.75, 2.6, SEAT);
        }
    }
 
    // Tall roadside sign, leaning a little
    part(g, 0.3, 6, 0.3, -8, 3, -4, CHROME);
    part(g, 3.2, 1.4, 0.25, -8, 6.4, -4, TRIM, 0, 0, 0.08);
    part(g, 2.6, 0.4, 0.27, -8, 6.4, -4, 0xd8d0b8, 0, 0, 0.08);
 
    // Parking lot with faded lines
    part(g, 9, 0.04, 9, -11, 0.02, 0, CONCRETE);
    for (const lz of [-3, 0, 3]) part(g, 3, 0.05, 0.12, -12.5, 0.03, lz, 0xc8c0a0);
 
    finishBuilding(g, x, z);
    buildCar(x - 11, z + 1.5, 0.1, 0x7a3a3a);
    buildCar(x - 12, z - 3.5, -0.2, 0x5a6a70, true);
 
    // Colliders: walls (door left open) and the counter
    addStaticCollider(0.35, 3.4, 7, x + 6, z);
    addStaticCollider(12, 3.4, 0.35, x, z - 3.5);
    addStaticCollider(12, 3.4, 0.35, x, z + 3.5);
    addStaticCollider(0.35, 3.4, 2.5, x - 6, z - 2.25);
    addStaticCollider(0.35, 3.4, 2.5, x - 6, z + 2.25);
    addStaticCollider(7, 1.0, 0.8, x + 1, z - 2.4);
}
 
 
// FARM: where the Bloom started
// Farmhouse with a porch, a silo, a rusty tractor and a field of glowing Bloom crops
 
// Shared by every crop stalk so 40+ stalks don't each make their own material
const BLOOM_STALK_MAT = new THREE.MeshStandardMaterial({ color: 0x3f5a2a });
const BLOOM_BULB_MAT = new THREE.MeshStandardMaterial({ color: 0x66ff44, emissive: 0x66ff44, emissiveIntensity: 0.8 });
const STALK_GEO = new THREE.BoxGeometry(0.08, 1.6, 0.08);
const BULB_GEO = new THREE.BoxGeometry(0.22, 0.3, 0.22);
 
function buildFarm(x, z) {
    const g = new THREE.Group();
    const WALL = 0xb8a888;
    const WOOD = 0x594638;
    const ROOF = 0x5a3a2e;
    const DARK = 0x2f2c28;
    const GLASS = 0x52605c;
    const SILO = 0x8a8478;
    const RUST = 0x75452f;
    const DIRT = 0x5e4632;
 
    // Farmhouse walls: door in the east wall, facing the porch
    part(g, 0.3, 3.4, 7, -4, 1.7, 0, WALL);
    part(g, 8, 3.4, 0.3, 0, 1.7, -3.5, WALL);
    part(g, 8, 3.4, 0.3, 0, 1.7, 3.5, WALL);
    part(g, 0.3, 3.4, 2.5, 4, 1.7, -2.25, WALL);
    part(g, 0.3, 3.4, 2.5, 4, 1.7, 2.25, WALL);
    part(g, 0.3, 0.8, 2.0, 4, 3.0, 0, WALL);
 
    // Boarded-up front windows
    for (const wz of [-2.25, 2.25]) {
        part(g, 0.05, 1.0, 1.2, 4.17, 1.9, wz, GLASS);
        part(g, 0.06, 0.15, 1.4, 4.2, 1.7, wz, WOOD, 0.3, 0, 0);
        part(g, 0.06, 0.15, 1.4, 4.2, 2.1, wz, WOOD, -0.25, 0, 0);
    }
 
    // Pitched roof (ridge runs north-south) and stepped gable ends
    part(g, 4.6, 0.25, 8, -2.1, 4.2, 0, ROOF, 0, 0, 0.45);
    part(g, 4.6, 0.25, 8, 2.1, 4.2, 0, ROOF, 0, 0, -0.45);
    for (const gz of [-3.5, 3.5]) {
        part(g, 5, 0.6, 0.3, 0, 3.7, gz, WALL);
        part(g, 2.4, 0.6, 0.3, 0, 4.3, gz, WALL);
        part(g, 0.5, 0.45, 0.3, 0, 4.8, gz, WALL);
    }
 
    // Porch
    part(g, 2.5, 0.2, 7, 5.3, 0.1, 0, WOOD);
    for (const pz of [-3.3, 3.3]) part(g, 0.15, 2.9, 0.15, 6.4, 1.5, pz, WOOD);
    part(g, 2.8, 0.15, 7.4, 5.4, 3.05, 0, ROOF, 0, 0, -0.12);
    part(g, 0.6, 0.6, 0.6, 5.8, 0.5, -2.5, WOOD, 0, 0.4, 0);
 
    // Silo with a rusty dome and a ladder
    const silo = new THREE.Mesh(
        new THREE.CylinderGeometry(2.2, 2.2, 10, 10),
        new THREE.MeshStandardMaterial({ color: SILO })
    );
    silo.position.set(10, 5, -7);
    silo.castShadow = true;
    silo.receiveShadow = true;
    g.add(silo);
    const cap = new THREE.Mesh(
        new THREE.SphereGeometry(2.2, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: RUST })
    );
    cap.position.set(10, 10, -7);
    cap.castShadow = true;
    g.add(cap);
    part(g, 0.1, 9, 0.5, 12.25, 4.5, -7, DARK);
 
    // Old tractor
    part(g, 2.4, 1.0, 1.2, 7, 1.1, 7, RUST);
    part(g, 0.9, 1.0, 1.1, 6.2, 2.0, 7, RUST);
    for (const wz of [6.2, 7.8]) {
        part(g, 1.4, 1.4, 0.35, 6.2, 0.7, wz, DARK);
        part(g, 0.8, 0.8, 0.3, 7.9, 0.4, wz, DARK);
    }
    part(g, 0.12, 0.9, 0.12, 7.8, 2.0, 7, DARK);
 
    // The Bloom field: dirt patch full of glowing stalks, with a clearing for the nest
    part(g, 9.5, 0.03, 13, -11.75, 0.015, 0, DIRT);
    for (let fx = -15.5; fx <= -7.5; fx += 1.6) {
        for (let fz = -5.5; fz <= 5.5; fz += 1.4) {
            if (Math.hypot(fx + 11, fz) < 2.5) continue;
            const sx = fx + (Math.random() - 0.5) * 0.4;
            const sz = fz + (Math.random() - 0.5) * 0.4;
            const h = 0.8 + Math.random() * 0.6;
 
            const stalk = new THREE.Mesh(STALK_GEO, BLOOM_STALK_MAT);
            stalk.scale.y = h;
            stalk.position.set(sx, 0.8 * h, sz);
            stalk.rotation.set((Math.random() - 0.5) * 0.3, 0, (Math.random() - 0.5) * 0.3);
            g.add(stalk);
 
            const bulb = new THREE.Mesh(BULB_GEO, BLOOM_BULB_MAT);
            bulb.position.set(sx, 1.6 * h, sz);
            g.add(bulb);
        }
    }
 
    // Wooden fence along both sides of the field
    for (const fz of [-6.8, 6.8]) {
        for (let fx = -16; fx <= -7; fx += 2) part(g, 0.12, 1.1, 0.12, fx, 0.55, fz, WOOD);
        part(g, 9, 0.1, 0.06, -11.5, 0.8, fz, WOOD, 0, 0, fz > 0 ? 0.06 : -0.04);
    }
 
    finishBuilding(g, x, z);
 
    // Colliders: house walls (door open), silo, tractor
    addStaticCollider(0.3, 3.4, 7, x - 4, z);
    addStaticCollider(8, 3.4, 0.3, x, z - 3.5);
    addStaticCollider(8, 3.4, 0.3, x, z + 3.5);
    addStaticCollider(0.3, 3.4, 2.5, x + 4, z - 2.25);
    addStaticCollider(0.3, 3.4, 2.5, x + 4, z + 2.25);
    addStaticCollider(4.4, 10, 4.4, x + 10, z - 7);
    addStaticCollider(2.4, 2.4, 1.6, x + 7, z + 7);
}
 
 
// CRASHED EVAC-2 CHOPPER
// The first rescue attempt: cabin rolled on its side, tail torn off, rotor blades everywhere
function buildCrashedChopper(x, z, rotY = 0.5) {
    const g = new THREE.Group();
    const BODY = 0x3e4436;
    const DARK = 0x23241f;
    const BURNT = 0x2a2622;
    const GLASS = 0x3e4a48;
    const SCORCH = 0x3a2e24;
 
    // Scorched ground
    part(g, 13, 0.02, 10, 0, 0.012, 1, SCORCH);
 
    // Cabin rolled onto its side, with a skid sticking up
    part(g, 2.2, 1.8, 4.2, 0, 1.3, 0, BODY, 0, 0, 1.2);
    part(g, 1.9, 1.0, 1.0, -0.2, 1.2, -2.5, GLASS, 0, 0, 1.2);
    part(g, 1.4, 1.2, 0.06, 0.6, 1.1, 2.12, BURNT, 0, 0, 1.2);
    part(g, 0.12, 0.12, 4.2, 1.76, 1.69, 0, DARK, 0, 0, 1.2);
    part(g, 0.12, 0.12, 3, 2.6, 0.1, -1, DARK, 0, 0.4, 0);
 
    // Tail boom torn off and lying a few meters away
    part(g, 0.5, 0.5, 4.5, 2.8, 0.3, 5.5, BODY, 0, 0.5, 0);
    part(g, 0.15, 1.5, 0.9, 3.8, 0.9, 7.3, BODY, 0, 0.5, 0.25);
 
    // Rotor blades: two flung across the ground, one stabbed into the dirt
    part(g, 4.5, 0.08, 0.35, -4.5, 0.05, 2.5, DARK, 0, 0.8, 0);
    part(g, 4, 0.08, 0.35, 3.5, 0.05, -4.5, DARK, 0, -0.4, 0.04);
    part(g, 0.35, 3.2, 0.08, -2.8, 1.3, -4.2, DARK, 0.3, 0, 0.25);
 
    // Debris
    part(g, 0.8, 0.3, 0.6, -3, 0.15, 4, BURNT, 0.2, 0.5, 0.1);
    part(g, 1.2, 0.2, 0.9, 4.5, 0.1, 1, BURNT, 0, 1.1, 0.1);
    part(g, 0.5, 0.5, 0.5, -1, 0.25, 4.5, BODY, 0.3, 0.2, 0.2);
 
    g.rotation.y = rotY;
    finishBuilding(g, x, z);
    addStaticCollider(4.4, 2.6, 4.6, x, z, rotY); // cabin only, the rest you can walk over
 
    // Thin smoke column (added to the scene, not the building, so bullets pass through it)
    const smoke = new THREE.Mesh(
        new THREE.CylinderGeometry(0.8, 1.6, 16, 8, 1, true),
        new THREE.MeshBasicMaterial({ color: 0x4a4540, transparent: true, opacity: 0.12, depthWrite: false })
    );
    smoke.position.set(x, 8, z);
    scene.add(smoke);
}
 
 
// CHAPEL AND GRAVEYARD
// Stone chapel with a steeple and stained glass, pews inside, graves out the east side
function buildChapel(x, z) {
    const g = new THREE.Group();
    const STONE = 0x8a8274;
    const DARK_STONE = 0x6e675c;
    const ROOF = 0x3f3a36;
    const WOOD = 0x594638;
    const STAINED = [0x8a3a3a, 0x3a4a7a, 0xa08a3a];
 
    // Walls: 6 wide, 10 long, door in the north wall facing town
    part(g, 0.4, 3.8, 10, -3, 1.9, 0, STONE);
    part(g, 0.4, 3.8, 10, 3, 1.9, 0, STONE);
    part(g, 6.4, 3.8, 0.4, 0, 1.9, -5, STONE);
    part(g, 2.2, 3.8, 0.4, -1.9, 1.9, 5, STONE);
    part(g, 2.2, 3.8, 0.4, 1.9, 1.9, 5, STONE);
    part(g, 1.6, 1.0, 0.4, 0, 3.3, 5, STONE);
 
    // Stained glass: three windows per side, and a 4-pane window behind the altar
    for (const side of [-1, 1]) {
        [-3, 0, 3].forEach((wz, i) => {
            part(g, 0.06, 1.6, 0.9, side * 3.22, 2.2, wz, STAINED[(i + (side > 0 ? 1 : 0)) % 3]);
        });
    }
    [[-0.4, 2.0], [0.4, 2.0], [-0.4, 2.8], [0.4, 2.8]].forEach(([wx, wy], i) => {
        part(g, 0.75, 0.75, 0.06, wx, wy, -5.22, STAINED[i % 3]);
    });
 
    // Pitched roof and gable ends
    part(g, 3.8, 0.25, 10.8, -1.6, 4.6, 0, ROOF, 0, 0, 0.5);
    part(g, 3.8, 0.25, 10.8, 1.6, 4.6, 0, ROOF, 0, 0, -0.5);
    for (const gz of [-5, 5]) {
        part(g, 3.9, 0.6, 0.4, 0, 4.1, gz, STONE);
        part(g, 1.7, 0.6, 0.4, 0, 4.7, gz, STONE);
    }
 
    // Steeple over the door, with a spire and a crooked cross
    part(g, 2, 3.6, 2, 0, 5.6, 4.6, STONE);
    part(g, 0.8, 1.0, 0.05, 0, 6.4, 5.62, 0x1e1c1a); // belfry opening
    const spire = new THREE.Mesh(
        new THREE.ConeGeometry(1.5, 3.5, 4),
        new THREE.MeshStandardMaterial({ color: ROOF })
    );
    spire.position.set(0, 9.15, 4.6);
    spire.rotation.y = Math.PI / 4;
    spire.castShadow = true;
    g.add(spire);
    part(g, 0.12, 1.0, 0.12, 0, 11.4, 4.6, WOOD, 0, 0, 0.3);
    part(g, 0.6, 0.12, 0.12, 0.08, 11.6, 4.6, WOOD, 0, 0, 0.3);
 
    // Pews on both sides of the aisle (a few knocked over) and the altar
    for (let pz = 3; pz >= -2.5; pz -= 1.3) {
        for (const side of [-1, 1]) {
            const knocked = Math.random() < 0.25;
            part(g, 2, 0.45, 0.4, side * 1.6, knocked ? 0.2 : 0.45, pz, WOOD, knocked ? 1.3 : 0, 0, 0);
            if (!knocked) part(g, 2, 0.6, 0.1, side * 1.6, 0.8, pz - 0.2, WOOD);
        }
    }
    part(g, 2, 1, 0.8, 0, 0.5, -4.2, DARK_STONE);
 
    // Graveyard to the east: rows of leaning headstones with dirt mounds
    for (let gx = 6.5; gx <= 12.5; gx += 2) {
        for (let gz = -0.5; gz <= 7.5; gz += 2.5) {
            const tilt = (Math.random() - 0.5) * 0.25;
            part(g, 0.7, 0.9 + Math.random() * 0.3, 0.15, gx, 0.45, gz, DARK_STONE, tilt, 0, tilt * 0.5);
            part(g, 0.7, 0.05, 1.4, gx, 0.03, gz + 0.8, 0x4a3a2c);
        }
    }
    // A freshly dug grave with a shovel left in the dirt pile
    part(g, 0.9, 0.02, 1.8, 6.5, 0.01, -3, 0x2a2018);
    part(g, 0.9, 0.4, 0.9, 7.6, 0.2, -3, 0x5e4632, 0, 0.4, 0);
    part(g, 0.06, 1.3, 0.06, 7.3, 0.6, -2.4, WOOD, 0.4, 0, 0.2);
 
    // Low fence around the graveyard (no collider, you can walk through gaps)
    for (const fz of [-4.5, 9]) {
        for (let fx = 5.5; fx <= 13.5; fx += 1.5) part(g, 0.1, 0.8, 0.1, fx, 0.4, fz, WOOD);
        part(g, 8, 0.08, 0.05, 9.5, 0.6, fz, WOOD);
    }
 
    finishBuilding(g, x, z);
 
    // Colliders: walls (door open) and the altar
    addStaticCollider(0.4, 3.8, 10, x - 3, z);
    addStaticCollider(0.4, 3.8, 10, x + 3, z);
    addStaticCollider(6.4, 3.8, 0.4, x, z - 5);
    addStaticCollider(2.2, 3.8, 0.4, x - 1.9, z + 5);
    addStaticCollider(2.2, 3.8, 0.4, x + 1.9, z + 5);
    addStaticCollider(2, 1, 0.8, x, z - 4.2);
}
 

//------------------------------------------------
// CITY LAYOUT
// Every landmark's center. 
const LAYOUT = {
    farm:       [-75, 100], // far north-west: where you start, and where the Bloom started
    checkpoint: [0, 72],    // quarantine line across the north end of Main Street
    house:      [-27, 27],  // collapsed house
    houseB:     [-13, 27],  // the intact house next door
    apartment:  [-20, 13],  // 2 floors, door faces south
    diner:      [25, 26],
    pharmacy:   [20, 12],   // door faces south
    police:     [-20, -17], // 2 floors, armory upstairs
    gas:        [26, -20],
    hardware:   [12, -18],
    bus:        [-20, 40],  // crashed across North Street
    chapel:     [-62, 15],
    crash:      [66, -22],
};
 
// Position relative to a landmark
function at(name, dx = 0, dz = 0) {
    const [x, z] = LAYOUT[name];
    return [x + dx, z + dz];
}
 
// Roads: [x1, z1, x2, z2] along their center lines (each one runs along x or z)
const ROAD_W = 8;   // asphalt width
const WALK_W = 2.5; // sidewalk on each side
const ROADS = [
    [0, -45, 0, 85],      // Main Street: tower plaza up to the checkpoint
    [-40, -36, -40, 40],  // West Avenue
    [40, -36, 40, 40],    // East Avenue
    [-46, 40, 46, 40],    // North Street
    [-60, 0, 60, 0],      // Center Street, out toward the chapel and the crash site
    [-46, -36, 46, -36],  // South Street
];
 
const FLOOR_H = 3.6;               // height of one story
const UPPER_Y = FLOOR_H + 0.125;   // top of an upper floor (where you stand)
 
 
//------------------------------------------------
// Roads, sidewalks and the tower plaza
function buildRoads() {
    const g = new THREE.Group();
    const ASPHALT = 0x3a3632;
    const WALK = 0x8a8478;
    const LINE = 0x9a8a4a;
    const CRACK = 0x2a2724;
 
    const half = ROAD_W / 2;
    const corridor = half + WALK_W;
 
    ROADS.forEach(([x1, z1, x2, z2], i) => {
        const alongX = z1 === z2;
        const a = alongX ? Math.min(x1, x2) : Math.min(z1, z2);
        const b = alongX ? Math.max(x1, x2) : Math.max(z1, z2);
        const fixed = alongX ? z1 : x1;
        const len = b - a + ROAD_W;
        const mid = (a + b) / 2;
        const y = 0.02 + i * 0.002; // tiny height difference so crossings don't flicker
 
        // asphalt
        if (alongX) part(g, len, 0.04, ROAD_W, mid, y, fixed, ASPHALT);
        else part(g, ROAD_W, 0.04, len, fixed, y, mid, ASPHALT);
 
        // where other roads cross this one (no sidewalk or center line there)
        const crossings = ROADS.filter((r, j) => j !== i && (r[1] === r[3]) !== alongX)
            .map((r) => (alongX ? r[0] : r[1]))
            .filter((c) => c >= a - 1 && c <= b + 1);
        const blocked = (t, pad) => crossings.some((c) => Math.abs(t - c) < half + pad);
 
        // sidewalks on both sides, in 2 m pieces so they can skip the crossings
        for (let t = a - half; t < b + half; t += 2) {
            if (blocked(t + 1, 0)) continue;
            for (const side of [-1, 1]) {
                const off = fixed + side * (half + WALK_W / 2);
                if (alongX) part(g, 2, 0.12, WALK_W, t + 1, 0.06, off, WALK);
                else part(g, WALK_W, 0.12, 2, off, 0.06, t + 1, WALK);
            }
        }
 
        // faded, dashed center line
        for (let t = a; t < b; t += 5) {
            if (blocked(t, 1.5) || Math.random() < 0.25) continue;
            if (alongX) part(g, 2.2, 0.01, 0.18, t, y + 0.021, fixed, LINE);
            else part(g, 0.18, 0.01, 2.2, fixed, y + 0.021, t, LINE);
        }
 
        // cracks and potholes
        for (let k = 0; k < len / 10; k++) {
            const t = a + Math.random() * (b - a);
            const o = (Math.random() - 0.5) * (ROAD_W - 1);
            const w = 0.4 + Math.random() * 1.4;
            if (alongX) part(g, w, 0.01, 0.15 + Math.random() * 0.5, t, y + 0.022, fixed + o, CRACK, 0, Math.random(), 0);
            else part(g, 0.15 + Math.random() * 0.5, 0.01, w, fixed + o, y + 0.022, t, CRACK, 0, Math.random(), 0);
        }
 
        // keep trees and rocks off the road
        if (alongX) reserve(a - corridor, fixed - corridor, b + corridor, fixed + corridor);
        else reserve(fixed - corridor, a - corridor, fixed + corridor, b + corridor);
    });
 
    // Cracked concrete plaza in front of the radio tower
    part(g, 24, 0.05, 18, 0, 0.03, -47, 0x77706a);
    for (let k = 0; k < 14; k++) {
        part(g, 0.2 + Math.random() * 0.4, 0.01, 1 + Math.random() * 2,
            (Math.random() - 0.5) * 22, 0.06, -47 + (Math.random() - 0.5) * 16, 0x4a4540, 0, Math.random() * 3, 0);
    }
 
    scene.add(g);
    mergeGroup(g);
}
 
// Dirt path from the farm (where you start) to the checkpoint at the top of Main Street
const PATH_POINTS = [[-63, 101], [-52, 97], [-38, 93], [-24, 91], [-11, 89], [0, 88]];
 
function buildDirtPath() {
    const g = new THREE.Group();
    const DIRT = 0x6b5038;
    const DARK = 0x5a4430;
    for (let i = 0; i < PATH_POINTS.length - 1; i++) {
        const [x1, z1] = PATH_POINTS[i];
        const [x2, z2] = PATH_POINTS[i + 1];
        const len = Math.hypot(x2 - x1, z2 - z1);
        const rot = Math.atan2(x2 - x1, z2 - z1);
        part(g, 3.2, 0.03, len + 1.5, (x1 + x2) / 2, 0.015, (z1 + z2) / 2, DIRT, 0, rot, 0);
        // wheel ruts and stones
        part(g, 0.5, 0.01, len, (x1 + x2) / 2, 0.035, (z1 + z2) / 2, DARK, 0, rot, 0);
        for (let k = 0; k < 4; k++) {
            const t = Math.random();
            const side = (Math.random() < 0.5 ? -1 : 1) * (1.8 + Math.random() * 0.6);
            const sx = x1 + (x2 - x1) * t + Math.cos(rot) * side;
            const sz = z1 + (z2 - z1) * t - Math.sin(rot) * side;
            part(g, 0.3, 0.2, 0.25, sx, 0.1, sz, 0x6e6258, 0.2, Math.random() * 3, 0.1);
        }
        reserve(Math.min(x1, x2) - 2, Math.min(z1, z2) - 2, Math.max(x1, x2) + 2, Math.max(z1, z2) + 2);
    }
    // a few broken fence posts beside the first stretch
    for (let k = 0; k < 6; k++) {
        const x = -60 + k * 4;
        part(g, 0.12, 1.0 - Math.random() * 0.4, 0.12, x, 0.45, 102.3 - k * 1.45, 0x594638, (Math.random() - 0.5) * 0.3, 0, (Math.random() - 0.5) * 0.3);
    }
    scene.add(g);
    mergeGroup(g);
}

//------------------------------------------------
// Adds street lights, traffic lights, trash and abandoned cars.
const lamps = []; // Stores working lamps for the flickering effect.

// Adds a street lamp.
// (toX, toZ): which way the arm reaches, toward the road
function buildLamp(g, x, z, toX, toZ, lit = false) {
    const POLE = 0x4a4844;
    part(g, 0.16, 5.6, 0.16, x, 2.8, z, POLE);
    part(g, 0.35, 0.3, 0.35, x, 0.15, z, POLE);
    // Positions the arm over the road.
    const ax = toX;
    const az = toZ;
    const armDir = Math.atan2(-toZ, toX);
    part(g, 1.6, 0.1, 0.1, x + ax * 0.75, 5.55, z + az * 0.75, POLE, 0, armDir, 0);
    const head = new THREE.Mesh(
        new THREE.BoxGeometry(0.6, 0.18, 0.35),
        new THREE.MeshStandardMaterial({
            color: lit ? 0xffe0a0 : 0x2f2d2a,
            emissive: lit ? 0xffc870 : 0x000000,
            emissiveIntensity: lit ? 0.9 : 0,
        })
    );
    head.position.set(x + ax * 1.5, 5.45, z + az * 1.5);
    head.rotation.y = armDir;
    g.add(head);
    addStaticCollider(0.25, 5.6, 0.25, x, z);
 
    if (lit) {
        const light = new THREE.PointLight(0xffd08a, 6, 16);
        light.position.set(x + ax * 1.5, 5.2, z + az * 1.5);
        scene.add(light);
        lamps.push({ light, phase: Math.random() * 10 });
    }
}
 
function buildStreetDetails() {
    const g = new THREE.Group();
    const edge = ROAD_W / 2 + WALK_W - 0.5; // Keeps lamps near the sidewalk edge
 
    // Street lamps along Main Street, alternating sides (arms point toward the road)
    [[-26, 1], [-12, -1], [14, 1], [28, -1], [54, 1], [64, -1]].forEach(([z, side], i) => {
        buildLamp(g, side * edge, z, -side, 0, i === 2);
    });
    // Street lamps along Center Street.
    [[-52, 1], [-26, -1], [-14, 1], [14, -1], [26, 1], [52, -1]].forEach(([x, side], i) => {
        buildLamp(g, x, side * edge, 0, -side, i === 4);
    });
    // A few lamps along the north and south roads
    buildLamp(g, -28, 40 - edge, 0, 1);
    buildLamp(g, 22, 40 + edge, 0, -1, true);
    buildLamp(g, -16, -36 + edge, 0, -1);
    buildLamp(g, 18, -36 - edge, 0, 1);
 
    // Traffic light at the Main and Center Street intersection
    const POLE = 0x3f3d3a;
    part(g, 0.2, 5, 0.2, edge, 2.5, edge, POLE);
    part(g, 3.2, 0.12, 0.12, edge - 1.5, 4.9, edge, POLE);
    part(g, 0.35, 0.9, 0.3, edge - 2.8, 4.45, edge, 0x2a2826);
    for (const [ly, c] of [[4.75, 0x4a1a1a], [4.45, 0x4a3a1a], [4.15, 0x1a3a1a]]) {
        part(g, 0.2, 0.2, 0.05, edge - 2.8, ly, edge + 0.16, c);
    }
    addStaticCollider(0.3, 5, 0.3, edge, edge);
    // A second traffic light lying in the road
    part(g, 0.2, 5, 0.2, -edge - 1.5, 0.15, -edge + 1, POLE, 0, 0.6, Math.PI / 2);
 
    // Trash bags, newspapers and junk along the sidewalks
    const JUNK = [0x2a2a2a, 0x3a3a2e, 0x5a5048, 0xc8c0a8];
    for (let k = 0; k < 40; k++) {
        const r = ROADS[k % ROADS.length];
        const alongX = r[1] === r[3];
        const t = (alongX ? Math.min(r[0], r[2]) : Math.min(r[1], r[3])) + Math.random() * Math.abs(alongX ? r[2] - r[0] : r[3] - r[1]);
        const off = (Math.random() < 0.5 ? -1 : 1) * (ROAD_W / 2 + 0.6 + Math.random() * 1.5);
        const x = alongX ? t : r[0] + off;
        const z = alongX ? r[1] + off : t;
        const c = JUNK[k % JUNK.length];
        if (c === 0xc8c0a8) part(g, 0.4, 0.01, 0.3, x, 0.13, z, c, 0, Math.random() * 3, 0); // newspaper
        else part(g, 0.5, 0.4, 0.45, x, 0.32, z, c, 0.1, Math.random() * 3, 0.1);           // trash bag
    }
 
    scene.add(g);
    mergeGroup(g);
    obstacles.push(g);
 
    // Abandoned cars along the streets (props: barrels can throw them around)
    buildCar(2.6, 20, Math.PI / 2 + 0.1, 0x5a6a70);
    buildCar(-2.6, 58, Math.PI / 2 - 0.2, 0x6a5a4a, true);
    buildCar(2.4, -22, Math.PI / 2, 0x7a4a3a);
    buildCar(-30, -2.4, 0.05, 0x55604a);
    buildCar(32, 2.5, -0.1, 0x6a5a4a, true);
    buildCar(50, -2, 0.3, 0x5a5a68);
    buildCar(14, 42.5, 0, 0x7a6a4a);
    buildCar(-18, -34, 0.1, 0x4a5a6a);
    buildCar(24, -38, -0.2, 0x6a3a3a, true);
    buildCar(-42.4, 22, Math.PI / 2, 0x5a6a50);
    buildCar(42.5, -12, Math.PI / 2 + 0.2, 0x7a5a4a);
    buildCar(-24, -8.5, 0, 0x2a3a5a); // police cruiser out front
}
 
function updateCity(time) {
    // Makes the working street lamps flicker.
    for (const l of lamps) {
        const f = Math.sin(time * 13 + l.phase) + Math.sin(time * 31 + l.phase * 2);
        l.light.intensity = f > 1.5 ? 0.5 : 6;
    }
}
 
 
//------------------------------------------------
// Furniture used to fill the buildings
const WOOD = 0x6b5238;
const DARK_WOOD = 0x4a3a2c;
const METAL = 0x6d6a60;
const ITEM_COLORS = [0x8a3a2a, 0x3a5a7a, 0xa08a3a, 0x5a6a50, 0xc8c0a0, 0x6a4a6a];

// Creates a table
function fTable(b, lx, lz, y0 = 0, w = 1.6, d = 0.9, color = WOOD) {
    b.box(w, 0.08, d, lx, y0 + 0.78, lz, color);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        b.box(0.08, 0.76, 0.08, lx + sx * (w / 2 - 0.1), y0 + 0.38, lz + sz * (d / 2 - 0.1), color);
    }
    b.block(w, 0.82, d, lx, y0 + 0.41, lz);
}

// Creates a chair, with an option to knock it over
function fChair(b, lx, lz, y0 = 0, rot = 0, knocked = false) {
    if (knocked) {
        b.box(0.45, 0.06, 0.45, lx, y0 + 0.22, lz, DARK_WOOD, 1.4, rot, 0);
        b.box(0.45, 0.5, 0.06, lx + 0.2, y0 + 0.05, lz, DARK_WOOD, 0, rot, 1.5);
        return;
    }
    b.box(0.45, 0.06, 0.45, lx, y0 + 0.45, lz, DARK_WOOD, 0, rot, 0);
    b.box(0.45, 0.5, 0.06, lx - Math.sin(rot) * 0.2, y0 + 0.72, lz - Math.cos(rot) * 0.2, DARK_WOOD, 0, rot, 0);
    for (const sx of [-0.18, 0.18]) for (const sz of [-0.18, 0.18]) {
        b.box(0.05, 0.45, 0.05, lx + sx, y0 + 0.22, lz + sz, DARK_WOOD);
    }
}
 
// Creates a shelf with randomly placed items
function fShelf(b, lx, lz, y0 = 0, len = 2.4, alongX = true, h = 2.0) {
    const w = alongX ? len : 0.5;
    const d = alongX ? 0.5 : len;
    for (const s of [-1, 1]) {
        b.box(alongX ? 0.06 : 0.5, h, alongX ? 0.5 : 0.06, lx + (alongX ? s * len / 2 : 0), y0 + h / 2, lz + (alongX ? 0 : s * len / 2), METAL);
    }
    for (const sy of [0.1, 0.75, 1.4, h - 0.05]) {
        b.box(w, 0.04, d, lx, y0 + sy, lz, METAL);
        if (sy > h - 0.1) continue;
        // stuff on the shelf
        for (let t = -len / 2 + 0.25; t < len / 2 - 0.2; t += 0.3 + Math.random() * 0.25) {
            if (Math.random() < 0.3) continue;
            const ih = 0.15 + Math.random() * 0.3;
            const c = ITEM_COLORS[Math.floor(Math.random() * ITEM_COLORS.length)];
            b.box(0.18, ih, 0.2, lx + (alongX ? t : 0), y0 + sy + 0.02 + ih / 2, lz + (alongX ? 0 : t), c);
        }
    }
    b.block(w, h, d, lx, y0 + h / 2, lz);
}
 
// Creates a bed with a mattress, blanket and pillow
function fBed(b, lx, lz, y0 = 0, alongX = true, blanket = 0x5a4a5a) {
    const w = alongX ? 2.0 : 1.0;
    const d = alongX ? 1.0 : 2.0;
    b.box(w, 0.3, d, lx, y0 + 0.2, lz, DARK_WOOD);             // frame
    b.box(w - 0.1, 0.18, d - 0.1, lx, y0 + 0.44, lz, 0xb8b0a0); // mattress
    b.box(alongX ? w * 0.6 : d - 0.1, 0.06, alongX ? d - 0.1 : w * 0.6,
        lx + (alongX ? 0.3 : 0), y0 + 0.55, lz + (alongX ? 0 : 0.3), blanket);
    b.box(alongX ? 0.4 : 0.6, 0.12, alongX ? 0.6 : 0.4,
        lx - (alongX ? w / 2 - 0.3 : 0), y0 + 0.58, lz - (alongX ? 0 : d / 2 - 0.3), 0xd0c8b8); // pillow
    b.block(w, 0.55, d, lx, y0 + 0.27, lz);
}
 
// Creates a storage cabinet
function fCabinet(b, lx, lz, y0 = 0, color = METAL) {
    b.solid(0.6, 1.3, 0.5, lx, y0 + 0.65, lz, color);
    for (const dy of [0.35, 0.75, 1.1]) b.box(0.4, 0.04, 0.02, lx, y0 + dy, lz + 0.26, 0x2a2a2a);
}
 
// Creates a couch
function fCouch(b, lx, lz, y0 = 0, alongX = true, color = 0x5a4a3a) {
    const w = alongX ? 2.2 : 0.9;
    const d = alongX ? 0.9 : 2.2;
    b.solid(w, 0.45, d, lx, y0 + 0.22, lz, color);
    if (alongX) b.box(w, 0.6, 0.2, lx, y0 + 0.65, lz - 0.35, color);
    else b.box(0.2, 0.6, d, lx - 0.35, y0 + 0.65, lz, color);
}
 
// Creates a counter
function fCounter(b, lx, lz, y0 = 0, len = 3, alongX = true, color = WOOD) {
    const w = alongX ? len : 0.7;
    const d = alongX ? 0.7 : len;
    b.solid(w, 1.0, d, lx, y0 + 0.5, lz, color);
    b.box(w + 0.1, 0.06, d + 0.1, lx, y0 + 1.03, lz, 0x8a8478);
}

// Adds a few scattered crates
function fCrates(b, lx, lz, y0 = 0) {
    b.solid(1, 1, 1, lx, y0 + 0.5, lz, 0x7a6040);
    b.box(0.9, 0.9, 0.9, lx + 0.1, y0 + 1.45, lz - 0.05, 0x6b5238, 0, 0.3, 0);
    b.box(0.8, 0.6, 0.7, lx + 1.0, y0 + 0.3, lz + 0.2, 0x7a6040, 0, 0.5, 0);
}
 
// Adds random debris to the floor
function fDebris(b, lx, lz, y0 = 0, n = 6) {
    for (let k = 0; k < n; k++) {
        b.box(0.2 + Math.random() * 0.5, 0.05 + Math.random() * 0.15, 0.2 + Math.random() * 0.4,
            lx + (Math.random() - 0.5) * 2, y0 + 0.05, lz + (Math.random() - 0.5) * 2,
            [0x6e655a, 0x4a4540, 0xc8c0a8][k % 3], Math.random() * 0.3, Math.random() * 3, 0);
    }
}
 
 
//------------------------------------------------
// Creates a two-story building with stairs connecting both floors
function buildMultiStory(x, z, o) {
    const b = makeBuilder(x, z, o.flip);
    const { w, d } = o;
    const FH = FLOOR_H;
    const H = FH * 2 + 0.2;
    const T = 0.3;
    const WALL = o.wall ?? 0x8f8374;
    const TRIM = o.trim ?? 0x5a4f44;
    const FLOOR = o.floor ?? 0x5e574e;
    const GLASS = 0x3e4a48;
    const DARK = 0x1e1c1a;
    const ROOF = 0x3f3a36;
 
    // Builds the walls and doorway
    const DOOR = 2.2;
    const DOOR_H = 2.7;
    const seg = (w - DOOR) / 2;
    b.solid(w, H, T, 0, H / 2, -d / 2, WALL);                                   // back
    b.solid(T, H, d, -w / 2, H / 2, 0, WALL);                                   // left
    b.solid(T, H, d, w / 2, H / 2, 0, WALL);                                    // right
    b.solid(seg, FH, T, -(DOOR / 2 + seg / 2), FH / 2, d / 2, WALL);            // front, left of door
    b.solid(seg, FH, T, DOOR / 2 + seg / 2, FH / 2, d / 2, WALL);               // front, right of door
    b.solid(DOOR, FH - DOOR_H, T, 0, DOOR_H + (FH - DOOR_H) / 2, d / 2, WALL);  // over the door
    b.solid(w, H - FH, T, 0, FH + (H - FH) / 2, d / 2, WALL);                   // front, upper floor
 
    // Adds windows to both floors, some smashed
    for (const y of [1.8, FH + 1.8]) {
        for (let wx = -w / 2 + 1.6; wx <= w / 2 - 1.6; wx += 2.6) {
            if (y < FH && Math.abs(wx) < DOOR / 2 + 0.9) continue; // not over the door
            for (const side of [1, -1]) {
                const c = Math.random() < 0.35 ? DARK : GLASS;
                b.box(1.3, 1.1, 0.06, wx, y, side * (d / 2 + 0.17), c);
                b.box(1.3, 1.1, 0.06, wx, y, side * (d / 2 - 0.17), c);
            }
            b.box(1.5, 0.1, 0.14, wx, y - 0.6, d / 2 + 0.22, TRIM); // sill
        }
        for (let wz = -d / 2 + 1.6; wz <= d / 2 - 1.6; wz += 2.6) {
            for (const side of [1, -1]) {
                const c = Math.random() < 0.35 ? DARK : GLASS;
                b.box(0.06, 1.1, 1.3, side * (w / 2 + 0.17), y, wz, c);
                b.box(0.06, 1.1, 1.3, side * (w / 2 - 0.17), y, wz, c);
            }
        }
    }
    // Adds exterior trim and the roof
    b.box(w + 0.1, 0.3, 0.06, 0, FH, d / 2 + 0.18, TRIM);
    b.box(w + 0.1, 0.3, 0.06, 0, FH, -d / 2 - 0.18, TRIM);
    b.box(0.06, 0.3, d + 0.1, w / 2 + 0.18, FH, 0, TRIM);
    b.box(0.06, 0.3, d + 0.1, -w / 2 - 0.18, FH, 0, TRIM);
    b.box(DOOR + 0.4, 0.2, 0.1, 0, DOOR_H + 0.1, d / 2 + 0.2, TRIM);
    b.solid(w + 0.4, 0.3, d + 0.4, 0, H + 0.15, 0, ROOF);
    b.box(w + 0.4, 0.5, 0.2, 0, H + 0.55, d / 2 + 0.1, TRIM);
    b.box(w + 0.4, 0.5, 0.2, 0, H + 0.55, -d / 2 - 0.1, TRIM);
    b.box(0.2, 0.5, d + 0.4, w / 2 + 0.1, H + 0.55, 0, TRIM);
    b.box(0.2, 0.5, d + 0.4, -w / 2 - 0.1, H + 0.55, 0, TRIM);
 
    // Ground floor
    b.box(w - T, 0.04, d - T, 0, 0.02, 0, FLOOR);
 
    // Builds stairs along the left wall
    const SW = 1.6;               // stair width (brutes don't fit; they guard the bottom)
    const SL = 6.4;               // long enough to stay under 30 degrees
    const sx = -w / 2 + T / 2 + SW / 2 + 0.05;
    const sz0 = d / 2 - 1.4;      // first step
    const szTop = sz0 - SL;       // last step
    const holeX = sx + SW / 2 + 0.05;
    const area = { x1: x - w / 2, x2: x + w / 2, z1: z - d / 2, z2: z + d / 2 };
    const steps = Math.round(FH / 0.3);
    for (let i = 0; i < steps; i++) {
        const h = (i + 1) * (FH / steps);
        b.box(SW, h, SL / steps, sx, h / 2, sz0 - (i + 0.5) * (SL / steps), 0x6e655a);
    }
    // Adds a ramp for smoother movement up the stairs
    const angle = Math.atan2(FH, SL) * (o.flip ? -1 : 1);
    const rampMid = b.at(sx, sz0 - SL / 2);
    addSolid(SW, 0.2, Math.hypot(FH, SL) + 0.3, rampMid.x, FH / 2 - 0.05, rampMid.z, angle, 0);
    stairways.push({
        area,
        floorY: FH,
        bottom: b.at(sx, sz0 + 0.7),
        top: b.at(sx, szTop - 1.6),   // on the landing, a little back from the top step
        doorIn: b.at(0, d / 2 - 1.2),
        doorOut: b.at(0, d / 2 + 1.6),
    });
 
    // Upper floor and stair railing
    const SLAB = 0.25;
    const inL = -w / 2 + T / 2;
    const inR = w / 2 - T / 2;
    const inB = -d / 2 + T / 2;
    b.solid(inR - holeX, SLAB, d - T, (holeX + inR) / 2, FH, 0, FLOOR);
    b.solid(holeX - inL, SLAB, szTop - inB, (inL + holeX) / 2, FH, (szTop + inB) / 2, FLOOR);
    b.solid(0.08, 1.0, SL + 1.2, holeX + 0.04, FH + 0.62, sz0 - SL / 2 + 0.6, TRIM);
 
    o.ground?.(b);
    o.upper?.(b);
    b.finish();
    reserve(x - w / 2 - 1, z - d / 2 - 1, x + w / 2 + 1, z + d / 2 + 1);
    return b;
}
 
// Creates a one-story building with optional storefront windows and a pitched roof
function buildShop(x, z, o) {
    const b = makeBuilder(x, z, o.flip);
    const { w, d } = o;
    const H = o.pitched ? 3.4 : 3.6;
    const T = 0.3;
    const WALL = o.wall ?? 0xa09684;
    const TRIM = o.trim ?? 0x5a4f44;
    const GLASS = 0x4a5a56;
    const DOOR = 2.0;
    const seg = (w - DOOR) / 2;
 
    b.solid(w, H, T, 0, H / 2, -d / 2, WALL);
    b.solid(T, H, d, -w / 2, H / 2, 0, WALL);
    b.solid(T, H, d, w / 2, H / 2, 0, WALL);
    b.solid(seg, H, T, -(DOOR / 2 + seg / 2), H / 2, d / 2, WALL);
    b.solid(seg, H, T, DOOR / 2 + seg / 2, H / 2, d / 2, WALL);
    b.box(DOOR, H - 2.6, T, 0, 2.6 + (H - 2.6) / 2, d / 2, WALL);
    b.box(w - T, 0.04, d - T, 0, 0.02, 0, o.floor ?? 0x5e574e);
 
    if (o.storefront) {
        for (const s of [-1, 1]) {
            b.box(seg - 0.6, 1.8, 0.06, s * (DOOR / 2 + seg / 2), 1.7, d / 2 + 0.17, Math.random() < 0.5 ? 0x1e1c1a : GLASS);
            b.box(seg - 0.6, 0.12, 0.14, s * (DOOR / 2 + seg / 2), 0.75, d / 2 + 0.22, TRIM);
        }
    } else {
        for (const s of [-1, 1]) b.box(1.2, 1.0, 0.06, s * (DOOR / 2 + seg / 2), 1.8, d / 2 + 0.17, GLASS);
    }
    for (const s of [-1, 1]) b.box(0.06, 1.0, 1.2, s * (w / 2 + 0.17), 1.8, 0, Math.random() < 0.4 ? 0x1e1c1a : GLASS);
 
    if (o.pitched) {
        const ROOF = o.roof ?? 0x5a3a2e;
        b.box(w / 2 + 0.6, 0.25, d + 0.8, -w / 4, H + 0.8, 0, ROOF, 0, 0, 0.45);
        b.box(w / 2 + 0.6, 0.25, d + 0.8, w / 4, H + 0.8, 0, ROOF, 0, 0, -0.45);
        for (const s of [-1, 1]) {
            b.box(w - 3, 0.6, T, 0, H + 0.3, s * d / 2, WALL);
            b.box(w - 5.6, 0.6, T, 0, H + 0.9, s * d / 2, WALL);
        }
    } else {
        b.box(w + 0.4, 0.3, d + 0.4, 0, H + 0.15, 0, o.roof ?? 0x3f3a36);
    }
    if (o.sign) {
        b.box(w * 0.6, 0.7, 0.15, 0, H - 0.25, d / 2 + 0.25, o.sign);
        b.box(w * 0.5, 0.25, 0.17, 0, H - 0.25, d / 2 + 0.26, 0xd8d0b8);
    }
 
    o.furnish?.(b);
    b.finish();
    reserve(x - w / 2 - 1, z - d / 2 - 1, x + w / 2 + 1, z + d / 2 + 1);
    return b;
}
 
 
//------------------------------------------------
// City buildings
 
// POLICE STATION: front desk, filing cabinets and a holding cell downstairs,
// the armory (and the shotgun) upstairs
function buildPolice(x, z) {
    buildMultiStory(x, z, {
        w: 16, d: 12, wall: 0x7a8088, trim: 0x2a3a5a, floor: 0x5a5a5a,
        ground(b) {
            fCounter(b, 3, 3, 0, 4, true, 0x4a4a52);
            fTable(b, -3.5, -0.5, 0, 1.6, 0.9, 0x5a5048);
            fChair(b, -3.5, 0.3, 0, Math.PI);
            fChair(b, -2.2, -1.5, 0, 0.8, true);
            for (const cx of [1.5, 2.2, 2.9]) fCabinet(b, cx, -5.5, 0);
            fCouch(b, 7.3, 1, 0, false, 0x3a3a44);
            // holding cell in the back right corner, door hanging open
            const BAR = 0x4a4a4a;
            for (let bz = -5.7; bz <= -2.4; bz += 0.3) b.box(0.05, 2.6, 0.05, 4.2, 1.3, bz, BAR);
            for (let bx = 4.2; bx <= 7.8; bx += 0.3) if (bx < 5.0 || bx > 6.0) b.box(0.05, 2.6, 0.05, bx, 1.3, -2.2, BAR);
            b.box(1.0, 2.6, 0.05, 5.8, 1.3, -1.7, BAR, 0, 0.9, 0);
            b.block(0.1, 2.6, 3.6, 4.2, 1.3, -4.0);
            b.block(0.8, 2.6, 0.1, 4.6, 1.3, -2.2);
            b.block(1.85, 2.6, 0.1, 6.95, 1.3, -2.2);
            fBed(b, 6.6, -5.2, 0, true, 0x4a4a52);
            fDebris(b, 1, 1.5, 0, 5);
        },
        upper(b) {
            const y = UPPER_Y;
            for (let lx = 0; lx <= 5; lx += 0.75) b.solid(0.7, 2.0, 0.5, lx, y + 1.0, -5.5, 0x4a5a4a); // lockers
            // empty weapon racks on the right wall
            for (const rz of [-2.5, 0, 2.5]) {
                b.box(0.1, 1.4, 2.0, 7.7, y + 1.3, rz, DARK_WOOD);
                for (let k = -0.7; k <= 0.7; k += 0.35) b.box(0.15, 0.05, 0.05, 7.6, y + 0.9, rz + k, METAL);
            }
            fTable(b, 2, -1, y, 2.0, 1.0, 0x5a5048);
            fChair(b, 2, 0, y, Math.PI, true);
            fCrates(b, 5, 4, y);
            fBed(b, -3, 4.5, y, true, 0x4a5a4a); // a cot someone slept on
            fDebris(b, -2, -3, y, 4);
        },
    });
}
 
// APARTMENT BLOCK: lobby with mailboxes downstairs, bedrooms upstairs
function buildApartment(x, z) {
    buildMultiStory(x, z, {
        w: 14, d: 12, flip: true, wall: 0x9a8270, trim: 0x5a4434, floor: 0x5e5048,
        ground(b) {
            b.solid(0.4, 1.6, 3, 6.5, 0.8, 2, 0x6a6a60); // mailboxes
            for (let mz = 0.8; mz <= 3.2; mz += 0.4) for (const my of [0.5, 0.9, 1.3]) b.box(0.05, 0.25, 0.3, 6.28, my, mz, 0x3a3a34);
            fCouch(b, 3, -4.8, 0, true, 0x6a4a3a);
            fTable(b, 3, -3, 0, 1.2, 0.7, DARK_WOOD);
            fChair(b, 1.5, -1.2, 0, 0.5, true);
            fCrates(b, -3.5, -4.5, 0);
            fDebris(b, 2, 1, 0, 6);
        },
        upper(b) {
            const y = UPPER_Y;
            fBed(b, 3, -4.8, y, true, 0x5a4a6a);
            fBed(b, 6, 1.5, y, false, 0x4a5a6a);
            fShelf(b, 6.7, -2.5, y, 2.0, false, 1.6);
            fTable(b, -1.5, -3, y, 1.4, 0.9, DARK_WOOD);
            fChair(b, -1.5, -2.1, y, Math.PI);
            fCouch(b, 1, 3.5, y, true, 0x5a3a3a);
            fDebris(b, 2, -1, y, 4);
        },
    });
}
 
// PHARMACY: aisles of shelves and a counter at the back. Door faces south.
function buildPharmacy(x, z) {
    buildShop(x, z, {
        w: 12, d: 8, flip: true, storefront: true, sign: 0x3a6a5a, wall: 0xb0a898,
        furnish(b) {
            fShelf(b, -2.5, 0.6, 0, 3.5, true, 1.8);
            fShelf(b, -2.5, -1.6, 0, 3.5, true, 1.8);
            fShelf(b, 3.2, 0.6, 0, 2.6, true, 1.8);
            fCounter(b, 2.5, -3.0, 0, 4, true, 0xc8c0b0);
            b.box(0.4, 0.3, 0.35, 3.2, 1.2, -3.0, 0x2a2a2a); // cash register
            fDebris(b, 0.5, 2, 0, 6);
        },
    });
}
 
// HARDWARE STORE: tools on the walls, workbench at the back (the machete is on it)
function buildHardware(x, z) {
    buildShop(x, z, {
        w: 8, d: 8, storefront: true, sign: 0x8a5a2a, wall: 0x9a8a74,
        furnish(b) {
            fShelf(b, -2.7, 0.2, 0, 3.4, false, 2.0);
            fShelf(b, 2.7, 0.8, 0, 2.6, false, 2.0);
            fCounter(b, 1.3, -3.25, 0, 3.2, true, DARK_WOOD); // workbench
            // tools hanging on the back wall
            for (let tx = -1.5; tx <= 2.5; tx += 0.6) {
                b.box(0.05, 0.6 + Math.random() * 0.3, 0.05, tx, 2.0, -3.75, 0x5a5048);
                b.box(0.25, 0.1, 0.06, tx, 2.3, -3.75, METAL);
            }
            fCrates(b, -2.2, -3, 0);
            for (let k = 0; k < 5; k++) b.box(0.25, 0.3, 0.25, 0.2 + k * 0.32, 0.15, 2.8, ITEM_COLORS[k]); // paint cans
        },
    });
}
 
// The intact house next to the collapsed one
function buildHouseB(x, z) {
    buildShop(x, z, {
        w: 8, d: 7, pitched: true, wall: 0xa89878, roof: 0x4a3a32,
        furnish(b) {
            fBed(b, -2.6, -2.4, 0, true, 0x6a5a4a);
            fTable(b, 1.6, -1.2, 0, 1.4, 0.9, WOOD);
            fChair(b, 1.6, -0.3, 0, Math.PI);
            fChair(b, 2.6, -1.4, 0, 0, true);
            fCouch(b, 2.2, 2.2, 0, true, 0x5a4a3a);
            fShelf(b, -3.55, 1.4, 0, 1.6, false, 1.6);
        },
    });
}
 
// Furniture for the older buildings (gas station shop, collapsed house, farmhouse)
function furnishOldBuildings() {
    // Gas station shop
    let b = makeBuilder(...LAYOUT.gas);
    fShelf(b, -2.4, -0.2, 0, 2.6, false, 1.8);
    fShelf(b, -1.2, -3.3, 0, 2.2, true, 2.0); // drinks cooler along the back
    fCounter(b, 2.6, 2.3, 0, 1.6, true, 0x5a5048);
    b.box(0.4, 0.3, 0.35, 2.6, 1.2, 2.3, 0x2a2a2a);
    fDebris(b, 0, 2.5, 0, 4);
    b.finish();
 
    // Collapsed house: what's left of someone's home
    b = makeBuilder(...LAYOUT.house);
    fTable(b, 2.0, 0.3, 0, 1.4, 0.9, DARK_WOOD);
    fChair(b, 2.8, 1.3, 0, 0, true);
    fBed(b, -2.3, -2.7, 0, true, 0x5a4a3a);
    b.box(2.4, 1.8, 0.4, 1.6, 0.6, -3.2, METAL, 0.9, 0, 0.1); // shelf that fell over
    fDebris(b, 1.5, -1.5, 0, 6);
    b.finish();
 
    // Farmhouse kitchen and bedroom
    b = makeBuilder(...LAYOUT.farm);
    fTable(b, -1, 0, 0, 1.6, 1.0, WOOD);
    fChair(b, -1, -0.8, 0, 0);
    fChair(b, -1, 0.8, 0, Math.PI);
    b.solid(0.8, 0.9, 0.7, -3.3, 0.45, -2.6, 0x3a3a3a); // stove
    fBed(b, -2.6, 2.4, 0, true, 0x7a5a3a);
    fShelf(b, 1.5, -3.1, 0, 2.0, true, 1.6);
    b.finish();
}
 
 
//------------------------------------------------
// Nature: dead trees and rocks, kept off roads and out of buildings
function buildDeadTree(g, x, z, s = 1) {
    const BARK = 0x3a2e24;
    const h = (4 + Math.random() * 2.5) * s;
    const lean = (Math.random() - 0.5) * 0.15;
    const trunk = new THREE.Group();
    trunk.position.set(x, 0, z);
    trunk.rotation.set(lean, Math.random() * 6, -lean);
    g.add(trunk);
    part(trunk, 0.4 * s, h, 0.4 * s, 0, h / 2, 0, BARK);
    part(trunk, 0.7 * s, 0.3, 0.7 * s, 0, 0.15, 0, BARK); // root flare
 
    const branches = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < branches; i++) {
        const pivot = new THREE.Group();
        pivot.position.y = h * (0.45 + Math.random() * 0.5);
        pivot.rotation.y = Math.random() * Math.PI * 2;
        trunk.add(pivot);
        const arm = new THREE.Group();
        arm.rotation.z = 0.5 + Math.random() * 0.6;
        pivot.add(arm);
        const len = (1.2 + Math.random() * 1.4) * s;
        part(arm, len, 0.14 * s, 0.14 * s, len / 2, 0, 0, BARK);
        // a twig off the end
        const twig = new THREE.Group();
        twig.position.x = len;
        twig.rotation.z = 0.5;
        arm.add(twig);
        part(twig, len * 0.5, 0.08 * s, 0.08 * s, len * 0.25, 0, 0, BARK);
    }
    addStaticCollider(0.45 * s, h, 0.45 * s, x, z);
    reserve(x - 1, z - 1, x + 1, z + 1);
}
 
function buildNature() {
    const g = new THREE.Group();
 
    // trees in specific spots: yards, along the dirt path, the farm, the chapel
    const spots = [
        [-35, 17], [-8, 16], [-33, 8], [-7, 33],                    // residential yards
        [-56, 104], [-46, 99], [-32, 96], [-18, 94], [-5, 92],     // along the path
        [-44, 89], [-28, 87], [-14, 85],
        [-92, 108], [-88, 92], [-60, 112], [-70, 85],              // farm
        [-70, 22], [-52, 26], [-68, 6],                             // chapel
        [72, -10], [58, -14], [76, -30],                            // crash site
        [-50, -20], [-55, -45], [52, 30], [55, 55], [-55, 55], [30, 60], [-25, 62], [25, 70],
    ];
    for (const [x, z] of spots) if (isFree(x, z, 0.5)) buildDeadTree(g, x, z, 0.8 + Math.random() * 0.5);
 
    // extra random trees in the open outskirts
    for (let k = 0, placed = 0; k < 400 && placed < 25; k++) {
        const x = (Math.random() - 0.5) * 240;
        const z = (Math.random() - 0.5) * 240 + 10;
        if (Math.abs(x) < 50 && z > -45 && z < 50) continue; // not in the middle of the city
        if (!isFree(x, z, 3)) continue;
        buildDeadTree(g, x, z, 0.7 + Math.random() * 0.6);
        placed++;
    }
    scene.add(g);
    mergeGroup(g);
    obstacles.push(g);
 
    // rocks (visual only)
    const rocks = new THREE.Group();
    for (let k = 0, placed = 0; k < 500 && placed < 70; k++) {
        const x = (Math.random() - 0.5) * 300;
        const z = (Math.random() - 0.5) * 300;
        if (!isFree(x, z, 1.5)) continue;
        const rock = new THREE.Mesh(
            new THREE.DodecahedronGeometry(Math.random() * 1.2 + 0.3),
            new THREE.MeshStandardMaterial({ color: 0x6e5a48, flatShading: true })
        );
        rock.position.set(x, 0.2, z);
        rock.rotation.set(Math.random(), Math.random(), Math.random());
        rocks.add(rock);
        placed++;
    }
    scene.add(rocks);
    mergeGroup(rocks);
}
 
 
//------------------------------------------------
// Skeletons: lying on the ground, or sitting against a wall
const BONE = 0xd6cdb4;
 
function buildSkeleton(x, z, rot = 0, sitting = false, y = 0) {
    const g = new THREE.Group();
    if (!sitting) {
        // lying on its back, head toward -z
        part(g, 0.22, 0.2, 0.25, 0, 0.1, -0.85, BONE);               // skull
        part(g, 0.04, 0.04, 0.03, -0.05, 0.16, -0.97, 0x222222);     // eye sockets
        part(g, 0.04, 0.04, 0.03, 0.05, 0.16, -0.97, 0x222222);
        part(g, 0.05, 0.05, 0.6, 0, 0.04, -0.4, BONE);               // spine
        for (let i = 0; i < 5; i++) part(g, 0.34 - i * 0.03, 0.04, 0.03, 0, 0.08, -0.6 + i * 0.07, BONE); // ribs
        part(g, 0.3, 0.06, 0.14, 0, 0.05, -0.05, BONE);              // pelvis
        for (const s of [-1, 1]) {
            part(g, 0.05, 0.05, 0.45, s * 0.1, 0.03, 0.25, BONE, 0, s * 0.08, 0);   // thigh
            part(g, 0.045, 0.045, 0.42, s * 0.14, 0.03, 0.68, BONE, 0, s * 0.12, 0); // shin
            part(g, 0.04, 0.04, 0.3, s * 0.24, 0.03, -0.45, BONE, 0, -s * 0.4, 0);   // upper arm
            part(g, 0.035, 0.035, 0.28, s * 0.3, 0.03, -0.18, BONE, 0, s * 0.25, 0); // forearm
        }
    } else {
        // sitting against a wall (behind it is -z), legs stretched out toward +z
        part(g, 0.22, 0.22, 0.24, 0, 0.82, -0.05, BONE, 0.3, 0, 0.15); // skull, slumped
        part(g, 0.04, 0.04, 0.03, -0.05, 0.85, 0.08, 0x222222);
        part(g, 0.04, 0.04, 0.03, 0.05, 0.85, 0.08, 0x222222);
        part(g, 0.05, 0.55, 0.05, 0, 0.4, -0.12, BONE, -0.15, 0, 0); // spine
        for (let i = 0; i < 4; i++) part(g, 0.32 - i * 0.03, 0.03, 0.18, 0, 0.62 - i * 0.08, -0.06, BONE);
        part(g, 0.3, 0.1, 0.16, 0, 0.06, -0.1, BONE);                 // pelvis
        for (const s of [-1, 1]) {
            part(g, 0.05, 0.05, 0.45, s * 0.1, 0.05, 0.15, BONE, 0, s * 0.05, 0);
            part(g, 0.045, 0.045, 0.42, s * 0.12, 0.04, 0.58, BONE, 0, s * 0.08, 0);
            part(g, 0.04, 0.3, 0.04, s * 0.2, 0.45, -0.05, BONE, 0, 0, s * 0.2);   // arms hanging down
            part(g, 0.035, 0.035, 0.28, s * 0.25, 0.12, 0.12, BONE, 0, s * 0.3, 0);
        }
    }
    g.position.set(x, y, z);
    g.rotation.y = rot;
    scene.add(g);
    mergeGroup(g);
}
 
function buildSkeletons() {
    // Positions are relative to landmarks where it matters, so they move with them
    buildSkeleton(...at('checkpoint', -3, 6), 0.4);
    buildSkeleton(...at('checkpoint', 9, -3), 2.0);
    buildSkeleton(3, 50, 1.2);
    buildSkeleton(-36, 3, -0.6);
    buildSkeleton(35, -32, 2.5);
    buildSkeleton(...at('crash', 3, 4), 0.8);
    buildSkeleton(...at('chapel', 5.2, -3), 1.0);  // next to the open grave
    buildSkeleton(...at('farm', -6, 8), -0.5);
    buildSkeleton(3, -80, 2.2);                     // evac road
    buildSkeleton(-4, -126, -1.0);                  // landing zone
    // sitting ones
    buildSkeleton(...at('diner', -4.9, 2.6), Math.PI / 2, true, 0.5);   // in a diner booth
    buildSkeleton(...at('police', 6.8, -5.0), 0, true, 0.55);           // on the cell bed
    buildSkeleton(...at('police', 7.2, 3), -Math.PI / 2, true, UPPER_Y); // upstairs, by the racks
    buildSkeleton(-13.7, 17.5, -Math.PI / 2, true, UPPER_Y);            // apartment, upstairs bedroom
    buildSkeleton(...at('houseB', -2.4, -2.4), Math.PI / 2, false, 0.5); // in bed
}

// LORE: journal pages and records at each new location.
// They use addSecret, so they count toward the secrets total and give +50 score.
function buildLoreNotes() {
    addSecret(...at('farm', 5.5, -1.5), (g) => notePaper(g),
        'Torn journal page: "Day 1. The corn came up overnight with green veins in every stalk. At night the whole field glows. Dad thinks it\'s beautiful."', 0.2);
 
    addSecret(...at('checkpoint', -6, -0.9), (g) => notePaper(g),
        'Military bulletin: "SECTOR 9 QUARANTINE. The Bloom spreads by spore. Infected hosts are hostile. Evacuation flights suspended until further notice."', 0.79);
 
    addSecret(...at('police', 2, -1.2), (g) => notePaper(g),
        'Duty log, Officer Reyes: "Day 31. No word from command in a week. I left the shotgun up here in the armory. If you\'re reading this, it\'s yours now."', UPPER_Y + 0.82);
 
    addSecret(-21.5, 16, (g) => notePaper(g),
        'Journal page: "Day 58. We barricaded the stairwell, but they learned to climb. Nowhere is high enough anymore."', UPPER_Y + 0.82);
 
    addSecret(...at('diner', -3, -0.8), (g) => notePaper(g),
        'Journal page: "Day 96. Marcus found us at the diner. Six of us now. He says Tower 9 can still reach the evac channel if we find the parts."');
 
    addSecret(...at('chapel', 0, -4.2), (g) => notePaper(g),
        'Journal page: "Day 150. We buried Ellie behind the chapel. Marcus has started coughing. It comes up green."', 1.01);
 
    addSecret(...at('crash', -3, 3), (g) => {
        part(g, 0.4, 0.3, 0.5, 0, 0.15, 0, 0xd0661a, 0, 0.5, 0);
        part(g, 0.42, 0.06, 0.52, 0, 0.22, 0, 0x222222, 0, 0.5, 0);
    }, 'Flight recorder: "EVAC-2 to base... spore cloud in the intake... losing power... we\'re going dow—" The recording ends.');
}


//------------------------------------------------
// World Building
function buildStaticWorld() {
    // Keep trees and rocks out of these areas (buildings reserve their own space too)
    reserve(...at('gas', -6, -6), ...at('gas', 7, 10));
    reserve(...at('house', -5, -5), ...at('house', 5, 6));
    reserve(...at('diner', -16, -5), ...at('diner', 7, 6));
    reserve(...at('checkpoint', -11, -9), ...at('checkpoint', 11, 9));
    reserve(...at('farm', -17, -11), ...at('farm', 13, 10));
    reserve(...at('chapel', -4, -6), ...at('chapel', 14, 10));
    reserve(...at('crash', -8, -8), ...at('crash', 8, 9));
    reserve(-13, -58, 13, -36);    // tower plaza
    reserve(-18, -160, 18, -58);   // evac road and landing zone
 
    buildRoads();
    buildDirtPath();
 
    // Landmarks from before, moved into a new layout
    buildGasStation(...LAYOUT.gas);
    buildCollapsedHouse(...LAYOUT.house);
    buildRadioTower(TOWER_POS.x, TOWER_POS.z);
    buildEvacRoute();
    buildCheckpoint(...LAYOUT.checkpoint);
    buildDiner(...LAYOUT.diner);
    buildFarm(...LAYOUT.farm);
    buildCrashedChopper(...LAYOUT.crash);
    buildChapel(...LAYOUT.chapel);
 
    // New city buildings, with furniture inside
    buildPolice(...LAYOUT.police);
    buildApartment(...LAYOUT.apartment);
    buildPharmacy(...LAYOUT.pharmacy);
    buildHardware(...LAYOUT.hardware);
    buildHouseB(...LAYOUT.houseB);
    furnishOldBuildings();
 
    buildStreetDetails();
    buildNature();
    buildSkeletons();
    buildSecrets();
    buildLoreNotes();
}

// A group of guards around one spot
function spawnCluster(homeX, homeZ, list, guardRadius = 12) {
    for (const [type, x, z] of list) {
        createHusk(x, z, type, { home: { x: homeX, z: homeZ }, guardRadius });
    }
}

// Same, but everything relative to a landmark from LAYOUT.
// y: spawn them on an upper floor (UPPER_Y)
function guards(name, homeDx, homeDz, list, guardRadius = 12, y = 0) {
    const [x, z] = LAYOUT[name];
    for (const [type, dx, dz] of list) {
        createHusk(x + dx, z + dz, type, { home: { x: x + homeDx, z: z + homeDz }, guardRadius, y });
    }
}

// To be called at startup and anytime the player presses 'R'
function spawnEntities() {
    // Bus crashed across North Street, and every parked car
    spawnBus(...LAYOUT.bus);
    spawnCars();
 
    // Crates + barrels
    for (let i = 0; i < 4; i++) spawnCrate(-3 + i * 1.5, 52); // abandoned supply drop on Main Street
    spawnBarrel(...at('gas', -5, 6));
    spawnBarrel(...at('gas', -5.6, 7.2));
    spawnBarrel(...at('police', 6, 8));
    spawnBarrel(...at('police', 7, 8.6));
    spawnBarrel(...at('bus', 8, 3));
    spawnBarrel(...at('diner', -11, -6));
    spawnBarrel(...at('hardware', -5, 5));
    spawnBarrel(...at('checkpoint', -8, 6));
    spawnBarrel(...at('checkpoint', -7.2, 6.6));
    spawnBarrel(...at('farm', -4, 9));
    spawnBarrel(-14, 4.5);  // in front of the apartments
    spawnBarrel(6, 30);     // Main Street
 
    // Barrels around the tower
    spawnBarrel(-6, -44);
    spawnBarrel(6, -56);
    spawnBarrel(-7, -55);
 
    // Bloom nests: farm field, diner, police station, gas station, collapsed house
    spawnNest(...at('farm', -11, 0));
    spawnNest(...at('diner', 4, 0));
    spawnNest(...at('police', -1, -3.5));
    spawnNest(...at('gas', 1.5, -1.5));
    spawnNest(...at('house', -1.5, 2));
 
    // Husks, location by location
    guards('farm', -9, 0, [['normal', -8, -4], ['normal', -14, 5], ['runner', -6, 7]]);
    guards('checkpoint', 0, 8, [['normal', -3, 8], ['normal', 3, 7], ['runner', 0, 12]]);
    guards('bus', 4, -2, [['brute', 4, -6], ['normal', 10, 0], ['normal', -6, -3], ['runner', 2, 5]]);
    guards('house', 0, 6, [['normal', 0, 7], ['normal', 4, 5]]);
    // apartment: one in the lobby, one upstairs, two out front (door faces south, z goes down)
    guards('apartment', 2, 0, [['normal', 2, 0]], 8);
    guards('apartment', 3, 3, [['normal', 3, 3]], 8, UPPER_Y);
    guards('apartment', 0, -9, [['normal', -2, -9], ['runner', 4, -9.5]]);
    guards('diner', -9, 0, [['normal', -10, -3], ['normal', -8, 3], ['runner', -13, 0]]);
    guards('pharmacy', 0, -8, [['normal', -2, -7], ['runner', 3, -7]]);
    // police: two out front, one at the front desk, two in the armory upstairs
    guards('police', 0, 9, [['normal', -2, 8], ['normal', 3, 9]]);
    guards('police', 3, -2, [['normal', 3, -2]], 8);
    guards('police', 2, -3, [['normal', 0, -3], ['runner', 5, 2]], 8, UPPER_Y);
    guards('gas', 0, 7, [['normal', -3, 6], ['normal', 3, 6], ['normal', 0, 10], ['runner', -5, 3]]);
    guards('hardware', 0, 5, [['normal', -1, 6], ['runner', 2, 7]]);
    guards('chapel', 0, 6, [['normal', 2, 8], ['normal', -2, 8], ['normal', 10, 5]]);
    guards('crash', 0, 0, [['normal', 4, 4], ['runner', -4, -3]]);
    spawnCluster(0, -50, [['normal', 4, -46], ['normal', -4, -47], ['runner', 0, -57]], 10); // tower
 
    // A few wanderers out in the open
    createHusk(-35, -20);
    createHusk(30, 45, 'runner');
    createHusk(50, 20);
    createHusk(-50, -30, 'brute', { home: { x: -50, z: -30 }, guardRadius: 10 });
 
    // One radio part at each location
    spawnPickup('battery', ...at('gas', 0, 7));          // under the gas station canopy
    spawnPickup('coil', ...at('house', 0, -2));          // inside the collapsed house
    spawnPickup('transmitter', ...at('bus', 7.5, -2.7)); // beside the bus
 
    // Weapons, as rewards for exploring
    spawnPickup('shotgun', ...at('police', 2.5, 1), { y: UPPER_Y }); // police armory, upstairs
    spawnPickup('machete', ...at('hardware', 1.8, -3.25), { y: 1.06 }); // on the hardware store workbench
 
    // Supplies (these respawn after being picked up)
    spawnPickup('ammo', ...at('farm', 6, 1.5), { y: 0.2 });   // farmhouse porch, near the start
    spawnPickup('medkit', ...at('farm', 1.5, 1.2));           // farmhouse kitchen
    spawnPickup('ammo', ...at('checkpoint', 6, -0.5));
    spawnPickup('ammo', ...at('checkpoint', -6, -7));
    spawnPickup('shells', ...at('checkpoint', 7, 1));
    spawnPickup('ammo', 2, 50);                               // by the supply crates
    spawnPickup('ammo', ...at('houseB', 1.6, -1.2), { y: 0.82 }); // on the kitchen table
    spawnPickup('ammo', ...at('apartment', 3, 2));            // lobby (door faces south)
    spawnPickup('medkit', ...at('apartment', -2, 5), { y: UPPER_Y });
    spawnPickup('ammo', ...at('apartment', 1, 4.5), { y: UPPER_Y });
    spawnPickup('medkit', ...at('diner', -1, 1));
    spawnPickup('medkit', ...at('pharmacy', 1, 1.5));         // door faces south, so +z is the back
    spawnPickup('medkit', ...at('pharmacy', -4.8, -2.5));
    spawnPickup('ammo', ...at('police', 3, -0.5));
    spawnPickup('shells', ...at('police', 3.5, 1.6), { y: UPPER_Y });
    spawnPickup('shells', ...at('hardware', 0.5, -1));
    spawnPickup('ammo', ...at('gas', -1, 1.5));
    spawnPickup('ammo', ...at('chapel', 0, 1));
    spawnPickup('medkit', ...at('crash', 3, -3));
    spawnPickup('ammo', 4, -44); // stocked up at the tower
    spawnPickup('medkit', -4, -44);
 
    // Evac route: crates, barrels at the barricade, supply cache, LZ supplies
    spawnCrate(-3, -84);
    spawnCrate(-4.5, -84.6);
    spawnBarricade(-98);
    spawnBarrel(-2, -96.5);
    spawnBarrel(2.5, -96.5);
    spawnPickup('ammo', -5.5, -89);
    spawnPickup('medkit', -5.5, -91);
    spawnPickup('shells', -5.5, -87.5);
    spawnBarrel(-10, -130);
    spawnBarrel(10, -146);
    spawnBarrel(9, -128);
    spawnPickup('ammo', -12, -150);
    spawnPickup('ammo', 12, -150);
    spawnPickup('medkit', 0, -125);
 
    setupTriggers();
}

//------------------------------------------------
// Shooting & Barrel Explostions
const raycaster = new THREE.Raycaster();
const screenCenter = new THREE.Vector2(0, 0);
const effects = [];

// Reusable light for explosion flashes
const blastLight = new THREE.PointLight(0xff8030, 0, 20);
scene.add(blastLight);



scene.add(camera);

// simple gun like model, built from boxes, attached to the camera so it follows player view
const gun = new THREE.Group();
const gunBody = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 0.1, 0.4),
    new THREE.MeshStandardMaterial({ color: 0x2a2a2a })
);

const gunBarrel = new THREE.Mesh(
    new THREE.BoxGeometry(0.04, 0.04, 0.25),
    new THREE.MeshStandardMaterial({ color: 0x1a1a1a })
);
gunBarrel.position.set(0, 0.02, -0.3);

const gunGrip = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.14, 0.07),
    new THREE.MeshStandardMaterial({ color: 0x4a3a2a})
);


gunGrip.position.set(0, -0.1, 0.1);
gunGrip.rotation.x = 0.3;
gun.add(gunBody, gunBarrel, gunGrip);

const GUN_REST = new THREE.Vector3(0.25, -0.22, -0.5); 
gun.position.copy(GUN_REST);
camera.add(gun);

// Light at tip of barrel for muzzle flash simulation
const muzzleLight = new THREE.PointLight(0xffc060, 0, 6);
muzzleLight.position.set(0, 0.02, -0.45);
gun.add(muzzleLight);

const fx = [];

function addFx(mesh, life, grow) {
    scene.add(mesh);
    fx.push({ mesh, age: 0, life, grow });
}

function updateFx(dt) {
    for (let i = fx.length -1; i >= 0; i--) {
        const f = fx[i];
        f.age += dt;
        const t = f.age / f.life;
        f.mesh.scale.setScalar(1 + t * f.grow);
        f.mesh.material.opacity = 1 - t;
        if (t >= 1) {
            scene.remove(f.mesh);
            f.mesh.geometry.dispose();
            f.mesh.material.dispose();
            fx.splice(i, 1);
        }
    }
}

function spawnTracer(end, start = null) {
    // start at the tip of the gun barrel, not the camera
    // our own shots start at the gun barrel; other players' shots pass in their own start
    if (!start) {
        start = new THREE.Vector3();
        muzzleLight.getWorldPosition(start);
    }

    const length = start.distanceTo(end);
    const tracer = new THREE.Mesh(
        new THREE.CylinderGeometry(0.015, 0.015, length, 4),
        new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true })
    );

    // place it half way between start and end
    tracer.position.copy(start).add(end).multiplyScalar(0.5);
    // rotate it to point from start to end
    const direction = new THREE.Vector3().subVectors(end, start).normalize();
    tracer.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);

    addFx(tracer, 0.08, 0);
}

function spawnImpact(point, color) {
    const puff = new THREE.Mesh(
        new THREE.SphereGeometry(0.08, 6, 4),
        new THREE.MeshBasicMaterial({ color, transparent: true })
    );
    puff.position.copy(point);
    addFx(puff, 0.25, 3);
}


document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !controls.isLocked || gameOver) return;
    shoot();
});

function flashRed(mesh) {
    mesh.traverse((child) => {
        if (child.isMesh && child.material.emissive) {
            child.material.emissive.setHex(0xff0000);
            setTimeout(() => child.material.emissive.setHex(0x000000), 100);
        }
    });
}

function hitMarker() {
    crosshairEl.style.background = '#ff4040';
    setTimeout(() => (crosshairEl.style.background = '#fff'), 100);
}


//------------------------------------------------
// Weapons
// 1 = pistol, 2 = shotgun, 3 = machete (or scroll the mouse wheel).
// You start with the pistol; the shotgun and machete have to be found in the city.
//
// Each weapon model is sized automatically by its longest side (length).
// If one shows up pointing backwards, set flip: true. Use viewPos / viewRot
// to nudge how it sits in your hand: [x, y, z] in meters / radians.
const WEAPONS = {
    pistol: {
        name: 'Pistol', slot: 1, model: 'pistol', length: 0.32,
        ammo: 'ammo', pellets: 1, spread: 0.003, damage: 1, cooldown: 0.2, range: 100,
        recoil: 0.07, kick: 0.1, alert: 30,
        viewPos: [0, 0, 0], viewRot: [0, 0, 0], flip: false,
    },
    shotgun: {
        name: 'Shotgun', slot: 2, model: 'shotgun', length: 0.8,
        ammo: 'shells', pellets: 7, spread: 0.06, damage: 1, cooldown: 0.85, range: 35,
        recoil: 0.18, kick: 0.3, alert: 45,
        viewPos: [0, 0.02, -0.12], viewRot: [0, 0, 0], flip: false,
    },
    machete: {
        name: 'Machete', slot: 3, model: 'machete', length: 0.65,
        melee: true, damage: 2, cooldown: 0.45, reach: 2.6,
        viewPos: [0.05, 0.08, -0.05], viewRot: [0.35, 0, -0.5], flip: false,
    },
};
const WEAPON_ORDER = ['pistol', 'shotgun', 'machete'];
 
let weapon = 'pistol';
const owned = { pistol: true, shotgun: false, machete: false };
let shells = 0;
let weaponCooldown = 0;
const viewModels = {}; // weapon -> the model held on screen
 
// Box-built stand-ins, used when a weapon's model file is missing
function fallbackViewModel(key) {
    const g = new THREE.Group();
    const DARK = 0x2a2a2a;
    if (key === 'pistol') {
        g.add(gunBody, gunBarrel, gunGrip); // the original box gun
        g.userData.muzzle = 0.45;
    } else if (key === 'shotgun') {
        part(g, 0.09, 0.1, 0.55, 0, 0, -0.1, DARK);
        part(g, 0.05, 0.05, 0.5, 0, 0.04, -0.55, 0x1a1a1a);
        part(g, 0.07, 0.12, 0.3, 0, -0.04, 0.3, 0x4a3a2a, 0.2, 0, 0);
        g.userData.muzzle = 0.82;
    } else {
        part(g, 0.05, 0.14, 0.12, 0, -0.05, 0.12, 0x3a2a1a);        // handle
        part(g, 0.015, 0.1, 0.55, 0, 0, -0.22, 0x9a9a92);           // blade
    }
    return g;
}
 
// Build the on-screen model for each weapon (after the models have loaded)
function initWeapons() {
    gun.remove(gunBody, gunBarrel, gunGrip); // the box gun is only used if the pistol model is missing
    for (const key of WEAPON_ORDER) {
        const w = WEAPONS[key];
        let vm;
        if (models[w.model]) {
            vm = sizedModel(w.model, w.length, w.flip);
            vm.position.set(...w.viewPos);
            vm.rotation.set(...w.viewRot);
            vm.userData.muzzle = w.length / 2 + 0.05 - w.viewPos[2];
            vm.traverse((c) => { if (c.isMesh) c.castShadow = false; });
        } else {
            vm = fallbackViewModel(key);
        }
        vm.visible = false;
        gun.add(vm);
        viewModels[key] = vm;
    }
    equip('pistol');
}
 
function equip(key) {
    if (!owned[key] || !viewModels[key]) return;
    weapon = key;
    for (const [k, vm] of Object.entries(viewModels)) vm.visible = k === key;
    muzzleLight.position.set(0, 0.02, -(viewModels[key].userData.muzzle || 0.45));
    gun.position.y = GUN_REST.y - 0.3; // dip out of view, then it slides back up
    weaponCooldown = Math.max(weaponCooldown, 0.25);
}
 
function giveWeapon(key) {
    owned[key] = true;
    equip(key);
}
 
function cycleWeapon(dir) {
    const list = WEAPON_ORDER.filter((k) => owned[k]);
    const i = list.indexOf(weapon);
    equip(list[(i + dir + list.length) % list.length]);
}
 
document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !controls.isLocked || gameOver) return;
    attack();
});
document.addEventListener('wheel', (e) => {
    if (!controls.isLocked || gameOver || e.deltaY === 0) return;
    cycleWeapon(Math.sign(e.deltaY));
});
 
// Everything a bullet can hit
function shootTargets() {
    return [
        ...husks.filter((h) => !h.dead).map((h) => h.mesh),
        ...nests.filter((n) => !n.dead).map((n) => n.group),
        ...(barricade ? [barricade.group] : []),
        ...props.map((p) => p.mesh),
        ...obstacles,
    ];
}
 
function attack() {
    if (weaponCooldown > 0) return;
    const w = WEAPONS[weapon];
    if (w.melee) {
        swingMelee(w);
        return;
    }
 
    const left = w.ammo === 'shells' ? shells : ammo;
    if (left <= 0) {
        const what = w.ammo === 'shells' ? 'shells' : 'ammo';
        showMessage(owned.machete ? `Out of ${what}! Press 3 for the machete.` : `Out of ${what}! Press F to shove.`, 1.5);
        return;
    }
    if (w.ammo === 'shells') shells--;
    else ammo--;
    weaponCooldown = w.cooldown;
 
    // Muzzle flash & recoil
    muzzleLight.intensity = w.pellets > 1 ? 10 : 6;
    setTimeout(() => (muzzleLight.intensity = 0), 50);
    gun.position.z += w.recoil;
    gun.rotation.x += w.kick;
 
    // gunshots are loud: nearby husks come running
    alertHusks(playerBody.position.x, playerBody.position.z, w.alert);
 
    const origin = new THREE.Vector3();
    const forward = new THREE.Vector3();
    camera.getWorldPosition(origin);
    camera.getWorldDirection(forward);
    const targets = shootTargets();
    let hitSomething = false;
 
    for (let i = 0; i < w.pellets; i++) {
        const dir = forward.clone();
        if (w.spread) {
            dir.x += (Math.random() - 0.5) * 2 * w.spread;
            dir.y += (Math.random() - 0.5) * 2 * w.spread;
            dir.z += (Math.random() - 0.5) * 2 * w.spread;
            dir.normalize();
        }
        raycaster.set(origin, dir);
        raycaster.far = w.range;
        const hits = raycaster.intersectObjects(targets, true);
        const end = hits.length > 0 ? hits[0].point : origin.clone().addScaledVector(dir, w.range);
        spawnTracer(end);
        if (i < 3) sendShot(origin, end); // a few tracers is plenty for other players to see
        if (hits.length > 0 && applyHit(hits[0], dir, w.damage)) hitSomething = true;
    }
    if (hitSomething) hitMarker();
}
 
// What happens where a bullet lands. Returns true if it hit a husk or nest.
function applyHit(hit, dir, damage) {
    let obj = hit.object;
    while (obj && !obj.userData.husk && !obj.userData.prop && !obj.userData.nest && !obj.userData.barricade) {
        obj = obj.parent;
    }
 
    // green bloom splatter when hitting husks or nests, dust everywhere else
    const bloom = obj && (obj.userData.husk || obj.userData.nest);
    spawnImpact(hit.point, bloom ? 0x66ff44 : 0xc8a878);
    if (!obj) return false;
 
    if (obj.userData.husk) {
        damageHusk(obj.userData.husk, damage, dir);
        return true;
    }
    if (obj.userData.nest) {
        damageNest(obj.userData.nest, damage);
        return true;
    }
    if (obj.userData.barricade) {
        damageBarricade(damage);
        return false;
    }
 
    const p = obj.userData.prop;
    if (!props.includes(p)) return false; // already blown up by an earlier pellet
    if (p.explosive) {
        explode(p);
    } else {
        const offset = new CANNON.Vec3(
            hit.point.x - p.body.position.x,
            hit.point.y - p.body.position.y,
            hit.point.z - p.body.position.z
        );
        p.body.applyImpulse(new CANNON.Vec3(dir.x * 30 * damage, 5, dir.z * 30 * damage), offset);
    }
    return false;
}
 
// Machete: quiet (doesn't alert husks), hits everything in an arc in front of you
function swingMelee(w) {
    weaponCooldown = w.cooldown;
    gun.rotation.set(-0.7, 0.6, 1.0); // wind-up pose; it swings back as it eases to rest
 
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const px = playerBody.position.x;
    const pz = playerBody.position.z;
    let hitSomething = false;
 
    for (const h of husks) {
        if (h.dead || Math.abs(h.body.position.y - playerBody.position.y) > 1.5) continue;
        const dx = h.body.position.x - px;
        const dz = h.body.position.z - pz;
        const d = Math.hypot(dx, dz) || 0.01;
        if (d > w.reach + h.radius || (dx * forward.x + dz * forward.z) / d < 0.5) continue;
        damageHusk(h, w.damage, new THREE.Vector3(dx / d, 0, dz / d), 0.6);
        hitSomething = true;
    }
    for (const n of nests) {
        if (!n.dead && Math.hypot(n.x - px, n.z - pz) < w.reach + 1) {
            damageNest(n, w.damage);
            hitSomething = true;
        }
    }
    if (barricade && Math.abs(pz - barricade.z) < 2.2 && Math.abs(px) < 8) damageBarricade(w.damage);
    if (hitSomething) hitMarker();
}

function explode(p) {
    const center = p.body.position;
    
    // Remove barrel from scene
    scene.remove(p.mesh);
    world.removeBody(p.body);
    props.splice(props.indexOf(p), 1);

    // generate a fireball that grows & fades
    const fireball = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.9 })
    );

    fireball.position.copy(center);
    scene.add(fireball);
    blastLight.position.copy(center);
    effects.push({ fireball, age: 0});

    const RADIUS = 6;

    // husks in range take 8 damage: normal husks & runners die, brutes get staggered
    for (const h of husks) {
        if (h.dead) continue;
        if (h.body.position.distanceTo(center) < RADIUS) {
            const away = h.body.position.vsub(center);
            away.y = 0;
            away.normalize();
            damageHusk(h, 8, away, 1.6);
            if (!h.dead) {
                h.stun = 0.8;
                h.body.velocity.set(away.x * 8, 0, away.z * 8);
            }
        }
    }

    // nests caught in the blast take heavy damage
    for (const n of nests) {
        if (!n.dead && Math.hypot(n.x - center.x, n.z - center.z) < RADIUS) damageNest(n, 8);
    }

    // Crates get blasted, other barrels will chain-react and explode
    for (const other of props) {
        const d = other.body.position.distanceTo(center);
        if (d < RADIUS) {
            // frozen props come to life if the blast hits them
            if (other.dormant) {
                other.dormant = false;
                other.body.type = CANNON.Body.DYNAMIC;
                other.body.mass = other.wakeMass || 800;
                other.body.updateMassProperties();
                other.body.wakeUp();
                charModel(other.mesh);
            }

            const away = other.body.position.vsub(center);
            away.normalize();
            const strength = other.blastScale || 15;
            const push = (1 - d / RADIUS) * other.body.mass * strength;
            other.body.applyImpulse(
                new CANNON.Vec3(away.x * push, push, away.z * push),
                new CANNON.Vec3(0, 0.6, 0)
            );

            if (other.explosive) {
                setTimeout(() => { if (props.includes(other)) explode(other); }, 150);
            }
        }
    }

    // blow open the barricade if the blast is close enough
    if (barricade && Math.abs(center.z - barricade.z) < RADIUS && Math.abs(center.x) < 9) {
        breakBarricade();
    }

    // everything nearby heard that
    alertHusks(center.x, center.z, 45);

    // If player is standing too close, they take damage and get thrown
    const playerDist = playerBody.position.distanceTo(center);
    if (playerDist < RADIUS) {
        hurtPlayer(40 * (1 - playerDist / RADIUS), center, 14);
    }
}

function updateEffects(dt) {
    for (let i = effects.length - 1; i >= 0; i--) {
        const e = effects[i];
        e.age += dt;
        const t = e.age / 0.5;
        e.fireball.scale.setScalar(1 + t * 5);
        e.fireball.material.opacity = 0.9 * (1 - t);
        blastLight.intensity = 40 * (1 - t);
        if (t >= 1) {
            scene.remove(e.fireball);
            blastLight.intensity = 0;
            effects.splice(i, 1);
        }
    }
    updateFx(dt);
    gun.position.lerp(GUN_REST, Math.min(1, dt * 15));
    const ease = Math.min(1, dt * 12);
    gun.rotation.x += (0 - gun.rotation.x) * ease;
    gun.rotation.y += (0 - gun.rotation.y) * ease;
    gun.rotation.z += (0 - gun.rotation.z) * ease;
}


//------------------------------------------------
// Radio Tower & Win Condition
// towerState: 'dead' -> 'broadcasting' (get to the LZ) -> 'landing' (hold the LZ) -> 'done'
let lzHintShown = false;

function updateTower(dt, time) {
    const px = playerBody.position.x;
    const pz = playerBody.position.z;
    const distToTower = Math.hypot(px - TOWER_POS.x, pz - TOWER_POS.z);
    const inLZ = pz < -122 && Math.abs(px - LZ_POS.x) < 16;

    if (towerState === 'dead') {
        if (distToTower < 6) {
            if (partsFound === 3) {
                towerState = 'broadcasting';
                chopper.visible = true;
                showMessage('Signal sent! The chopper is inbound. Follow the road south to the landing zone!', 5);
            } else if (!towerHintShown) {
                towerHintShown = true;
                showMessage(`The tower is dead. Find the radio parts (${partsFound}/3).`, 3);
            }
        } else {
            towerHintShown = false;
        }
        if (inLZ && !lzHintShown) {
            lzHintShown = true;
            showMessage('An empty landing zone. Fix the radio tower to call for evac.', 3);
        }
        return;
    }

    // beacon blinks for the rest of the game
    const on = Math.sin(time * 8) > 0;
    beaconLight.intensity = on ? 50 : 0;
    beaconBulb.material.color.setHex(on ? 0xff2020 : 0x330000);
    rotor.rotation.y += dt * 25;

    if (towerState === 'broadcasting') {
        // chopper circles high above the LZ waiting for you
        const angle = time * 0.3;
        chopper.position.set(LZ_POS.x + Math.cos(angle) * 20, 45, LZ_POS.z + Math.sin(angle) * 20);
        chopper.rotation.y = -angle;

        if (inLZ) {
            towerState = 'landing';
            evacTimer = LAND_TIME;
            waveTimer = 2;
            showMessage('Hold the landing zone until the chopper touches down!', 4);
        }
    } else if (towerState === 'landing') {
        evacTimer -= dt;
        const progress = 1 - evacTimer / LAND_TIME; // 0 -> 1

        // descend straight onto the helipad
        chopper.position.set(LZ_POS.x, 45 * (1 - progress), LZ_POS.z);
        chopper.rotation.y += (0 - chopper.rotation.y) * dt;

        // waves get faster and nastier as the chopper gets closer
        waveTimer -= dt;
        const alive = husks.filter((h) => !h.dead).length;
        if (waveTimer <= 0 && alive < 30) {
            waveTimer = Math.max(1.6, 4 - progress * 2.5);
            const [sx, sz] = LZ_SPAWNS[Math.floor(Math.random() * LZ_SPAWNS.length)];
            let type = Math.random() < 0.4 ? 'runner' : 'normal';
            if (progress > 0.5 && Math.random() < 0.15) type = 'brute';
            createHusk(sx, sz, type, { alerted: true });
        }

        if (evacTimer <= 0) win();
    }
}

// Win state
function win() {
    towerState = 'done';
    gameOver = true;
    chopper.position.set(LZ_POS.x, 0, LZ_POS.z);
    score += Math.ceil(health) * 5;
    beaconLight.intensity = 0;
    controls.unlock();
    overlayTitle.textContent = 'EVAC ARRIVED';
    overlayText.textContent = `You made it out. Final Score: ${score}. Press 'R' to play again.`;
}


//------------------------------------------------
// Game Reset

function clearEntities() {
    for (const h of husks) { scene.remove(h.mesh); world.removeBody(h.body); }
    husks.length = 0;

    for (const p of props) { scene.remove(p.mesh); world.removeBody(p.body); }
    props.length = 0;

    for (const p of pickups) scene.remove(p.mesh);
    pickups.length = 0;

    for (const n of nests) scene.remove(n.group);
    nests.length = 0;

    if (barricade) {
        scene.remove(barricade.group);
        world.removeBody(barricade.body);
        barricade = null;
    }

    for (const f of fx) scene.remove(f.mesh);
    fx.length = 0;

    for (const e of effects) scene.remove(e.fireball);
    effects.length = 0;
    blastLight.intensity = 0;
}

function resetGame() {
    clearEntities();
    spawnEntities();

    for (const s of secrets) s.found = false;
    secretsFound = 0;
    for (const zone of hazards) zone.warned = false;

    playerBody.position.set(SPAWN.x, 2, SPAWN.z);
    playerBody.velocity.set(0, 0, 0);
    camera.position.set(SPAWN.x, 2 + EYE_HEIGHT, SPAWN.z);
    camera.rotation.set(0, SPAWN.yaw, 0);
    knockback.set(0, 0, 0);
    hurtEl.style.opacity = 0;

    health = 100;
    ammo = 30;
    shells = 0;
    owned.shotgun = false;
    owned.machete = false;
    equip('pistol');
    closeNote();
    partsFound = 0;
    score = 0;
    meleeCooldown = 0;

    towerState = 'dead';
    evacTimer = 0;
    towerHintShown = false;
    lzHintShown = false;
    beaconLight.intensity = 0;
    beaconBulb.material.color.setHex(0x330000);
    chopper.visible = false;

    gameOver = false;
    messageEl.textContent = '';
    overlayTitle.textContent = 'LAST SIGNAL';
    overlayText.textContent = 'Click to Start';
}



//------------------------------------------------
// Game Loop
const clock = new THREE.Clock();
const lookDir = new THREE.Vector3();

function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.1);
    const time = clock.elapsedTime;

    if (!gameOver && controls.isLocked) {
        meleeCooldown -= dt;
        weaponCooldown -= dt;
        updatePlayer(dt);
        updateHazards(dt, time);
        updateHusks(dt, time);
        updateNests(dt, time);
        updatePickups(dt, time);
        updateInteraction();
        updateTriggers();
        updateTower(dt, time);
        updateEffects(dt);
        world.step(1 / 60, dt, 3);
    }

    // Multiplayer: share where we are and which way we're facing, then move other players
    if (!gameOver) {
        camera.getWorldDirection(lookDir);
        sendState(dt, playerBody.position, Math.atan2(-lookDir.x, -lookDir.z));
    }
    updateRemotePlayers(dt);

    // Sync crates & barrels, (positions & rotation so they are able to tumble)
    for (const p of props) {
        p.mesh.position.copy(p.body.position);
        p.mesh.quaternion.copy(p.body.quaternion);
    }

    // Keep the sun's shadow box centered on the player so shadows work on the evac route too
    sun.position.set(playerBody.position.x + 30, 50, playerBody.position.z + 20);
    sun.target.position.set(playerBody.position.x, 0, playerBody.position.z);

    updateCity(time);
    updateHUD();
    if (health <= 0 && !gameOver) {
        gameOver = true;
        controls.unlock();
        overlayTitle.textContent = 'YOU DIED';
        overlayText.textContent = 'The Bloom claims another. Press `R` to try again.';
    }

    renderer.render(scene, camera);
}

window.addEventListener('resize', () => { 
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});


//------------------------------------------------
// New game start

try {
    await loadModels();
    initWeapons();
    buildStaticWorld();
    spawnEntities();
    camera.position.set(SPAWN.x, 2 + EYE_HEIGHT, SPAWN.z);
    camera.rotation.set(0, SPAWN.yaw, 0);
    initNetwork(scene, {
        models: { female: models.female, male: models.male },
        profile: myProfile(),
        statusCallback: (others) => {
            playersEl.textContent = others === 0 ? 'Playing solo' : `Survivors online: ${others + 1}`;
        },
        myColorCallback: (hex) => {
            youEl.style.color = `#${hex.toString(16).padStart(6, '0')}`;
            youEl.textContent = `You: ${myProfile().name}`;
        },
        remoteShotCallback: (from, to) => {
            spawnTracer(new THREE.Vector3(to.x, to.y, to.z), new THREE.Vector3(from.x, from.y, from.z));
        },
    });
    ready = true;
    overlayText.textContent = 'Click to Start';
    animate();
} catch (err) {
    console.error(err);
    overlayText.textContent = "Couldn't load models. Press F12 and check the console."
}

