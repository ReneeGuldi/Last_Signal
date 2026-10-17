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
    const loaded = await Promise.all(names.map((n) => loader.loadAsync(MODEL_FILES[n])));
    names.forEach((name, i) => {
        const model = loaded[i].scene;
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

// camera height right above the sphere's center
const EYE_HEIGHT = 1.1;
let health = 100;
let ammo = 30;
let partsFound = 0;
let score = 0;
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

overlay.addEventListener('click', () => { if (ready && !gameOver) controls.lock(); });
controls.addEventListener('lock', () => (overlay.style.display = 'none'));
controls.addEventListener('unlock', () => (overlay.style.display = 'flex'));

const keys = {};
document.addEventListener('keydown', (e) => (keys[e.code] = true));
document.addEventListener('keyup', (e) => (keys[e.code] = false));

function updateHUD() {
    healthEl.textContent = `Health: ${Math.max(0, Math.ceil(health))}`;
    ammoEl.textContent = `Ammo: ${ammo}`;
    partsEl.textContent = `Parts: ${partsFound}/3`;
    scoreEl.textContent = `Score: ${score}`;
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
    if (keys.Space && Math.abs(playerBody.velocity.y) < 0.1) {
        playerBody.velocity.y = 8;
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
// World Building
function buildWorld() {
    // placeholder buildings for the moment
    createBox(12, 6, 10, 30, -20, 0x6b5b4b); // gas station
    createBox(8, 5, 8, -35, 15, 0x5a4a3a); // collapsed house
    createBox(3, 2.5, 10, 10, 30, 0x4a5a5a); // crashed bus
    createBox(3, 25, 3, 0, -50, 0x333333); // radio tower

    // Rocks (visual only)
    for (let i = 0; i < 80; i++) {
        const rock = new THREE.Mesh(
            new THREE.DodecahedronGeometry(Math.random() * 1.2 + 0.3),
            new THREE.MeshStandardMaterial({ color: 0x6e5a48, flatShading: true })
        );
        rock.position.set((Math.random() - 0.5) * 300, 0.2, (Math.random() - 0.5) * 300);
        rock.castShadow = true;
        scene.add(rock);
    }

    // Crates + barrels
    for (let i = 0; i < 4; i++) spawnCrate(-5 + i * 1.5, -8);
    spawnBarrel(18, -5);
    spawnBarrel(19, -6.2);
    spawnBarrel(-22, 8);

    // Husks
    createHusk(20, -10);
    createHusk(-25, 5);
    createHusk(35, 25);
    createHusk(-30, -30);

    // One radio part at each location
    spawnPickup('battery', 30, -13); // in front of gas station
    spawnPickup('coil', -35, 21); // by the house
    spawnPickup('transmitter', 14, 30); // beside the bus

    // Supplies
    spawnPickup('medkit', -10, 0);
    spawnPickup('medkit', 20, 15);
    spawnPickup('ammo', 5, -3);
    spawnPickup('ammo', -20, -25);
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
    new THREE.MeshStandardMaterial({ color: 0x4a3a2a })
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
            f.mesh.geometry.dispose();
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
        new THREE.MeshBasicMaterial({ color: oxffe08a, transparent: true })
    );

    // place it half way between start and end
    tracer.position.copy(start).add(end).multiplyScalar(0.5);
    // rotate it to point from start to end
    const direction = new THREE.Vector3().addVectors(end, start).normalize();
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
    spawnImpact(hit.point, obj && obj.userData.husk ? 0x66ff44 : 0x8a878);

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
            const away = other.body.position.vsub(center);
            away.normalize();
            const push = (1 - d / RADIUS) * other.body.mass * 15;
            other.body.applyImpulse(new CANNON.Vec3(away.x * push, push, away.z * push));
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
        overlayText.textContent = 'The Bloom claims another.';
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
    buildWorld();
    ready = true;
    overlayText.textContent = 'Click to Start';
    animate();
} catch (err) {
    console.error(err);
    overlayText.textContent = "Couldn't load models. Press F12 and check the console."
}

