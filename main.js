import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as CANNON from 'cannon-es';

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
const MODEL_FILES = {
    husk: 'models/husk.gltf',
    battery: 'models/battery.gltf',
    coil: 'models/coil.gltf',
    transmitter: 'models/transmitter.gltf',
    barrel: 'models/barrel.gltf',
    medkit: 'models/medkit.gltf',
    crate: 'models/crate.gltf',
    ammo: 'models/ammo.gltf',
};

const models = {};
const loader = new GLTFLoader();

async function loadModels() {
    const names = Object.keys(MODEL_FILES);
    const results = await Promise.allSettled(names.map((n) => loader.loadAsync(MODEL_FILES[n])));
    names.forEach((name, i) => {
        if (results[i].status === 'rejected') {
            console.warn(`Couldn't load ${name}`);
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


// Make a copy of loaded model and add it to the scene
// yOffset is used to shift the model inside a "holder" group
// Physics bodies are centered in the middle, but models' origins are at the feet
// shifting them down by half their height to line up correctly.
function spawnModel(name, scale = 1, yOffset = 0) {
    const inner = models[name].clone();
    // Give each copy its own materials so singular items can flash without
    // changing all models of that type
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

function finishBuilding(group, x, z) {
    group.position.set(x, 0, z);
    scene.add(group);
    obstacles.push(group);
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
const playerBody = new CANNON.Body({
    mass: 70,
    shape: new CANNON.Sphere(0.5),
    position: new CANNON.Vec3(0, 2, 10),
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


overlay.addEventListener('click', () => { if (ready && !gameOver) controls.lock(); });
controls.addEventListener('lock', () => (overlay.style.display = 'none'));
controls.addEventListener('unlock', () => (overlay.style.display = 'flex'));

const keys = {};
document.addEventListener('keydown', (e) =>  {
    keys[e.code] = true;
    if (e.code === 'KeyR' && ready) resetGame();
});
document.addEventListener('keyup', (e) => (keys[e.code] = false));

function updateHUD() {
    healthEl.textContent = `Health: ${Math.max(0, Math.ceil(health))}`;
    ammoEl.textContent = `Ammo: ${ammo}`;
    partsEl.textContent = `Parts: ${partsFound}/3`;
    scoreEl.textContent = `Score: ${score}`;

    if (towerState === 'broadcasting') {
        objectiveEl.textContent = `SURVIVE! Evac in ${Math.ceil(evacTimer)}s`;
    } else if (partsFound < 3) {
        objectiveEl.textContent = `Objective: find the radio parts (${partsFound}/3)`;
    } else {
        objectiveEl.textContent = 'Objective: get to the radio tower';
    }
}

let messageTimer = null;
function showMessage(text, seconds = 2.5) {
    messageEl.textContent = text;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => (messageEl.textContent = ''), seconds * 1000);
}

function updatePlayer() {
    if (!controls.isLocked) return;

    const speed = keys.ShiftLeft ? 12 : 6;

    // Which way is the camera facing? If looking down, this should NOT slow player.
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();

    const move = new THREE.Vector3();
    if (keys.KeyW) move.add(forward);
    if (keys.KeyS) move.sub(forward);
    if (keys.KeyD) move.add(right);
    if (keys.KeyA) move.sub(right);
    move.normalize().multiplyScalar(speed);

    // Setting horizontal velocity directional
    // leave vertical to gravity
    playerBody.velocity.x = move.x;
    playerBody.velocity.z = move.z;

    // Simple jump: can't do if moving vertically already
    if (keys.Space && canJump) {
        playerBody.velocity.y = 8;
        canJump = false;
    }

    // Camera follows the physics body
    camera.position.set(
        playerBody.position.x,
        playerBody.position.y + EYE_HEIGHT,
        playerBody.position.z
    );
}



//------------------------------------------------
// Husks
const husks = [];
const HUSK_TURN = 0;

function createHusk(x, z) {
    const mesh = spawnModel('husk', 1, -0.5);
    mesh.children[0].rotation.y = HUSK_TURN;

    const body = new CANNON.Body({
        mass: 50,
        shape: new CANNON.Sphere(0.5),
        position: new CANNON.Vec3(x, 0.5, z),
        fixedRotation: true,
    });
    world.addBody(body);

    const husk = ({ mesh, body, hp: 3, speed: 3.5, aggroRange: 40, stun: 0, dead: false, deathTimer: 0 });
    mesh.userData.husk = husk;
    husks.push(husk);
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

        const dx = playerBody.position.x - h.body.position.x;
        const dz = playerBody.position.z - h.body.position.z;
        const dist = Math.hypot(dx, dz);

        if (h.stun > 0) {
            h.stun -= dt;
        } else if (dist < h.aggroRange && dist > 1.0) {
            h.body.velocity.x = (dx / dist) * h.speed;
            h.body.velocity.z = (dz / dist) * h.speed;
        } else {
            h.body.velocity.x = 0;
            h.body.velocity.z = 0;
        }

        if (dist < 1.5 && !gameOver) {
            health -= 25 * dt;
        }

        h.mesh.position.copy(h.body.position);
        h.mesh.position.y += Math.abs(Math.sin(time * 8)) * 0.05;
        h.mesh.lookAt(playerBody.position.x, h.mesh.position.y, playerBody.position.z);
    }
}


//------------------------------------------------
// Item Pick Ups
const PICKUP_TYPES = {
    battery:        { model: 'battery', scale: 2, radio: true, name: 'the battery' },
    coil:           { model: 'coil', scale: 1.5, radio: true, name: 'the antenna coil' },
    transmitter:    { model: 'transmitter', scale: 2, radio: true, name: 'the transmitter' },
    medkit:         { model: 'medkit', scale: 1.5 },
    ammo:           { model: 'ammo', scale: 1.5 },
};

const pickups = [];

function spawnPickup(type, x, z) {
    const config = PICKUP_TYPES[type];
    const mesh = spawnModel(config.model, config.scale, 0);
    mesh.position.set(x, 0.6, z);

    // radio parts get additional yellow glow to stand out in the fog
    if (config.radio) {
        const glow = new THREE.PointLight(0xffd84a, 3, 5);
        glow.position.y = 0.5;
        mesh.add(glow);
    }

    pickups.push({ type, mesh, collected: false });
}

function collect(p) {
    p.collected = true;
    scene.remove(p.mesh);
    const config = PICKUP_TYPES[p.type];

    if (config.radio) {
        partsFound++;
        score += 100;
        if (partsFound === 3) {
            showMessage('All parts found! Get to the radio tower.', 5);
        } else {
            showMessage(`Found ${config.name}! (${partsFound}/3)`);
        }
    } else if (p.type === 'medkit') {
        health = Math.min(100, health + 35);
        showMessage('+35 health');
    } else if (p.type === 'ammo') {
        ammo += 15;
        showMessage('+15 ammo');
    }
}


function updatePickups(dt, time) {
    for (const p of pickups) {
        if (p.collected) continue;

        p.mesh.rotation.y += dt * 1.5;
        p.mesh.position.y = 0.6 + Math.sin(time * 2) * 0.15;

        const dist = Math.hypot(
            playerBody.position.x - p.mesh.position.x,
            playerBody.position.z - p.mesh.position.z,
        );
        if (dist < 1.5) collect(p);
    }
}


//------------------------------------------------
// Game Easter Eggs

const secrets = [];
let secretsFound = 0;

// Building a small object from boxes and registering it as a secret
function addSecret(x, z, build, message) {
    const g = new THREE.Group();
    build(g);
    g.position.set(x, 0, z);
    scene.add(g);
    secrets.push({ x, z, message, found: false });
}

function buildSecrets() {
    // 1. Survivor's note on the floor inside collapsed house
    addSecret(-37.5, 13.5, (g) => {
        part(g, 0.3, 0.002, 0.4, 0, 0.01, 0, 0xe8e0c8, 0, 0.4, 0);
        part(g, 0.2, 0.025, 0.03, 0, 0.012, -0.05, 0x333333, 0, 0.3, 0);
        part(g, 0.2, 0.025, 0.03, 0, 0.012, 0.05, 0x333333, 0, 0.4, 0);
    }, 'A scrawled note: "Day 212. The Bloom took Marcus today. Tower 9 still has power... I think"');

    // 2. A lonely teddy bear out in the wasteland
    addSecret(55, -45, (g) => {
        const FUR = 0x9c7a55;
        part(g, 0.35, 0.4, 0.25, 0, 0.2, 0, FUR);
        part(g, 0.3, 0.28, 0.25, 0, 0.54, 0, FUR);
        part(g, 0.1, 0.1, 0.06, -0.12, 0.72, 0, FUR);
        part(g, 0.1, 0.1, 0.06, 0.12, 0.72, 0, FUR);
        part(g, 0.04, 0.04, 0.02, 0.06, 0.56, 0.13, 0x111111);
        part(g, 0.1, 0.1, 0.05, 0, 0.48, 0.13, 0xc4a77f);
    }, 'A sun bleached teddy bear, missing an eye. Someone loved this once. I wonder if they made it out.' );

    // RIP (;
    addSecret(-12, -62, (g) => {
        part(g, 0.8, 0.15, 1.4, 0, 0.07, 0, 0x6e5a48);
        part(g, 0.1, 1.0, 0.1, 0, 0.5, -0.6, 0x594638);
        part(g, 0.5, 0.1, 0.1, 0, 0.75, -0.6, 0x594638);
    }, 'Here lies Renee\'s sleep schedule. 2026-2026. Gone but not forgotten');

}

function updateSecrets() {
    for (const s of secrets) {
        if (s.found) continue;
        const dist = Math.hypot(playerBody.position.x - s.x, playerBody.position.z - s.z);
        if (dist < 2) {
            s.found = true;
            secretsFound++;
            score += 50;
            showMessage(`${s.message} (Secret ${secretsFound}/${secrets.length})`, 5);
        }
    }
}


//------------------------------------------------
// World Building
function buildStaticWorld() {
    buildGasStation(30, -20);
    buildCollapsedHouse(-35, 15);
    buildRadioTower(TOWER_POS.x, TOWER_POS.z);
    buildSecrets();

    // rocks (visual only)
    for (let i = 0; i < 80; i++) {
        const rock = new THREE.Mesh(
            new THREE.DodecahedronGeometry(Math.random() * 1.2 + 0.3),
            new THREE.MeshStandardMaterial({ color: 0x6e5a48, flatShading: true })
        );
        rock.position.set((Math.random() - 0.5) * 300, 0.2, (Math.random() - 0.5) * 300);
        rock.castShadow = true;
        scene.add(rock);
    }
}

// To be called at startup and anytime the player presses 'R'
function spawnEntities() {
    // Bus
    spawnBus(10, 30);

    // Crates + Barrels
    for (let i = 0; i < 4; i++) spawnCrate (-5 + i * 1.5, -8);
    spawnBarrel(18, -5);
    spawnBarrel(19, -6.2);
    spawnBarrel(-22, 8);
    spawnBarrel(10, 27);

    // Barrels around the tower for evacuation waves
    spawnBarrel(-6, -44);
    spawnBarrel(6, -56);
    spawnBarrel(-7, -55);

    // Husks
    createHusk(20, -10);
    createHusk(-25, 5);
    createHusk(35, 25);
    createHusk(-30, -30);

    // One radio part at each location
    spawnPickup('battery', 30, -13); // in front of the gas station
    spawnPickup('coil', -35, 13); // inside the house
    spawnPickup('transmitter', 17.5, 27.3); // beside the bus

    // Supplies
    spawnPickup('medkit', -10, 0);
    spawnPickup('medkit', 20, 15);
    spawnPickup('ammo', -20, -25);
    spawnPickup('ammo', 5, -3);
    spawnPickup('ammo', 4, -44); // stocked up at the tower
    spawnPickup('medkit', -4, -44);
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

function spawnTracer(end) {
    // start at the tip of the gun barrel, not the camera
    const start = new THREE.Vector3();
    muzzleLight.getWorldPosition(start);

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

function killHusk(h, impulse) {
    h.dead = true;
    h.deathTimer = 1.5;

    const q = h.mesh.quaternion;
    h.body.quaternion.set(q.x, q.y, q.z, q.w);
    h.body.fixedRotation = false;
    h.body.updateMassProperties();
    h.body.applyImpulse(impulse);
    score += 100;
}

function shoot() {
        if (ammo <= 0) {
            showMessage('Out of ammo!', 1);
            return;
        }
        ammo--;

        // Muzzle flash & recoil
        muzzleLight.intensity = 6;
        setTimeout(() => (muzzleLight.intensity = 0), 50);
        gun.position.z += 0.08;


    raycaster.setFromCamera(screenCenter, camera);
    raycaster.far = 100;
    const targets = [
        ...husks.filter((h) => !h.dead).map((h) => h.mesh),
        ...props.map((p) => p.mesh),
        ...obstacles,
    ];

    const hits = raycaster.intersectObjects(targets, true);
    const endPoint = hits.length > 0
        ? hits[0].point
        : raycaster.ray.origin.clone().add(raycaster.ray.direction.clone().multiplyScalar(100));
        spawnTracer(endPoint);

        if (hits.length === 0) return;

    const hit = hits[0];
    let obj = hit.object;
    while (obj && !obj.userData.husk && !obj.userData.prop) obj = obj.parent;

    // green bloom splatter when hitting husks, dust everywhere else
    spawnImpact(hit.point, obj && obj.userData.husk ? 0x66ff44 : 0xc8a878);

    if (!obj) return;

    const dir = raycaster.ray.direction;

    if (obj.userData.husk) {
        const h = obj.userData.husk;
        h.hp--;
        flashRed(h.mesh);
        hitMarker();
        if (h.hp <= 0) {
            killHusk(h, new CANNON.Vec3(dir.x * 400, 400, dir.z * 400));
        } else {
            h.stun = 0.3;
            h.body.velocity.set(dir.x * 6, 0, dir.z * 6);
        }
    } else {
        const p = obj.userData.prop;
        if (p.explosive) {
            explode(p);
        } else {
            const offset = new CANNON.Vec3(
                hit.point.x - p.body.position.x,
                hit.point.y - p.body.position.y,
                hit.point.z - p.body.position.z
            );
            p.body.applyImpulse(new CANNON.Vec3(dir.x * 30, 5, dir.z * 30),offset)
        }
    }
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

    // husks in range will die & get flung away
    for (const h of husks) {
        if (h.dead) continue;
        if (h.body.position.distanceTo(center) < RADIUS) {
            const away = h.body.position.vsub(center);
            away.normalize();
            killHusk(h, new CANNON.Vec3(away.x * 600, 700, away.z * 600));
        }
    }

    // Crates get blasted, other barrels will chain-react and explode
    for (const other of props) {
        const d = other.body.position.distanceTo(center);
        if (d < RADIUS) {
            // frozen props come to life if the blast hits them
            if (other.dormant) {
                other.dormant = false;
                other.body.type = CANNON.Body.DYNAMIC;
                other.body.mass = 800;
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
    // If player is standing too close, they take damage
    const playerDist = playerBody.position.distanceTo(center);
    if (playerDist < RADIUS) {
        health -= 40 * (1 - playerDist / RADIUS);
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
}


//------------------------------------------------
// Radio Tower & Win Condition
function updateTower(dt, time) {
    const distToTower = Math.hypot(
        playerBody.position.x - TOWER_POS.x,
        playerBody.position.z - TOWER_POS.z
    );

    if (towerState === 'dead') {
        if (distToTower < 6) {
            if (partsFound === 3) {
                towerState = 'broadcasting';
                evacTimer = EVAC_TIME;
                waveTimer = 0;
                showMessage('Signal sent! Hold out until the evac chopper arrives!', 4);
            } else if (!towerHintShown) {
                towerHintShown = true;
                showMessage(`The tower is dead. Find the radio parts (${partsFound}/3).`, 3);
            }
        } else {
            towerHintShown = false;
        }
    } else if (towerState === 'broadcasting') {
        evacTimer -= dt;

        const on = Math.sin(time * 8) > 0;
        beaconLight.intensity = on ? 50 : 0;
        beaconBulb.material.color.setHex(on ? 0xff2020 : 0x330000);

        waveTimer -= dt;
        if (waveTimer <= 0) {
            waveTimer = 4;
            const angle = Math.random() * Math.PI * 2;
            createHusk(
                playerBody.position.x + Math.cos(angle) * 30,
                playerBody.position.z + Math.sin(angle) * 30
            );
        }
        if (evacTimer <= 0) win();
    }
}

// Win state
function win() {
    towerState = 'done';
    gameOver = true;
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

    playerBody.position.set(0, 2, 10);
    playerBody.velocity.set(0, 0, 0);
    camera.position.set(0, 2 + EYE_HEIGHT, 10);
    camera.rotation.set(0, 0, 0);

    health = 100;
    ammo = 30;
    partsFound = 0;
    score = 0;

    towerState = 'dead';
    evacTimer = 0;
    towerHintShown = false;
    beaconLight.intensity = 0;
    beaconBulb.material.color.setHex(0x330000);

    gameOver = false;
    messageEl.textContent = '';
    overlayTitle.textContent = 'LAST SIGNAL';
    overlayText.textContent = 'Click to Start';
}



//------------------------------------------------
// Game Loop
const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.1);
    const time = clock.elapsedTime;

    if (!gameOver && controls.isLocked) {
        updatePlayer();
        updateHusks(dt, time);
        updatePickups(dt, time);
        updateSecrets();
        updateTower(dt, time);
        updateEffects(dt);
        world.step(1 / 60, dt, 3);
    }

    // Sync crates & barrels, (positions & rotation so they are able to tumble)
    for (const p of props) {
        p.mesh.position.copy(p.body.position);
        p.mesh.quaternion.copy(p.body.quaternion);
    }

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
    buildStaticWorld();
    spawnEntities();
    ready = true;
    overlayText.textContent = 'Click to Start';
    animate();
} catch (err) {
    console.error(err);
    overlayText.textContent = "Couldn't load models. Press F12 and check the console."
}

