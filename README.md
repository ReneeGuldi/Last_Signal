# The Last Signal

A low-poly, first-person survival shooter built with **Three.js** and **cannon-es**.

The Bloom has overrun the wasteland, turning people into *husks*. You're one of the last survivors, and your only way out is a dead radio tower. Find the parts to repair it, send the signal, and survive until the evac chopper arrives.

**Play in your browser:** `https://reneeguldi.github.io/Last_Signal/`

> This is a single-player version (Project 2). The multiplayer expansion, with more enemies, a bigger map, an evac route, and additional game lore, is here: **`https://github.com/ReneeGuldi/Last_Signal_Multiplayer`**

---

## How to Play
1. **Find the three radio parts:** the battery, the antenna coil, and the transmitter. Each one glows yellow so you're able to spot them through the fog.
2. **Bring them to the radio tower** to send the distress signal. The beacon will start flashing red.
3. **Survive for 60 seconds** while waves of husks close in, until the evacuation chopper arrives.

If your health hits zero, the Bloom claims your life. Press `R` to try again.

### Controls

| Action | Key |
| --- | --- |
| Move | `W` `A` `S` `D` |
| Sprint | `Shift` |
| Jump | `Space` |
| Look Around | `Mouse` |
| Shoot | `Left Click` |
| Restart | `R` |
| Pause / Release Mouse | `Esc` |

---

## Scoring

| Action | Points | 
| --- | --- |
| Radio Part Found | +100 | 
| Husk killed | +100 |
| Secret Found | +50 |
| Surviving the evac | +5 for every point of health you have left |

## Tips

- **Radio parts glow yellow**, so you can spot them through the fog.
- **Medkits restore 35 health.**
- **Ammo boxes give you 15 extra bullets.** You start with 30, so don't waste them.
- **Husks take three hits.** Each hit staggers them for a moment, which gives you room to back away and make distance.
- **Shoot barrels to make them explode.** Explosions kill nearby husks, set off other barrels, and can blow the wrecked school bus loose. Don't stand too close, they can hurt you too!
- **There are a few barrels around the tower**, so save them for the final wave.
- **There are a few hidden secrets around the map.**

---

## Features

- **Physics** with cannon-es: crates tumble when shot, explosive barrels chain-react, and the bus wakes up and goes flying when caught in a blast.
- **First-person shooting** with a box-built gun, recoil, muzzle flash, bullet tracers, and impact effects (dust, or green Bloom splatter on husks).
- **Husks** that chase you, flash red when hit, and ragdoll when they die.
- **Detailed box-built locations**: a gas station, a collapsed house, a crashed school bus, and the radio tower.
- **Custom Blockbench models** for the husks, radio parts, pickups, crates, and barrels.
- **A radio tower finale** with a flashing beacon, timed husk waves, and a win screen.
- **Hidden easter eggs** with a bit of story.
- **Instant restart** with `R`: husks, props, and pickups all respawn.

---

## Running the game locally.

The game uses JavaScript modules, so it has to be served over `http://`; double-clicking `index.html` won't work. Any simple local server is fine, for example:

```
bash
# with Python
python -m http.server 8000

# or with Node.js
npx serve .
```

Then open **`http://localhost:8000`** (or the address `serve` prints).

In VS Code, the **Live Server** extension also works: right-click `index.html` and chose **Open with Live Server**

---

## Project Structure

```
|-- index.html     Page, HUD, overlay, and import map (Three.js and cannon-es from CDN)
|-- main.js        The whole game: world, physics, husks, pickups, shooting, tower finale
|-- models/        Blockbench models exported as .gltf
```


## Built with
- [Three.js](https://threejs.org/) r160: rendering
- [cannon-es](https://pmdrs.github.io/cannon-es) 0.20: physics
- [Blockbench](https://www.blockbench.net/): 3D Models

## Credits
- Game design, programming, and models: Renee Guldi
- Course: CSCI 310, GUI and Game Development, Project 2
- Building geometry was generated with the help of ChatGPT, then reviewed and adjusted by me.
