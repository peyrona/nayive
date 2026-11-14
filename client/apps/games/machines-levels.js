/* machines-levels.js - the levels of Machines, as plain JSON data (no code).

   Each level is one object. Design mode's "Level code" writes this very shape,
   so a board made there can be pasted in here as it is.

     id         a short unique name, letters only
     name       the level's name in the five languages
     w, h       the board, in grid cells (24 x 15 so far)
     ball       where the ball starts: [x, y], its centre (radius 0.45)
     basket     { x, y, w, h }: the ball must rest inside it for half a second
     blocks     fixed walls and shelves: [x, y, w, h] each
     pulleys    fixed points a rope can run over: [x, y] each, on the grid
     inventory  the pieces the player gets: { beam: 2, gear: 3, ... }
     solution   one machine that solves it, built only from the inventory;
                tools/machines-test/test.js runs it and it must win

   The pieces (machines-sim.js, THE MODEL, says how each one behaves):
     { "type": "beam",   "a": [x, y], "b": [x, y] }
     { "type": "wheel",  "at": [x, y], "r": 1 | 2 | 3 }
     { "type": "gear",   "at": [x, y], "r": 1 | 2 | 3 }
     { "type": "rope",   "a": [x, y], "b": [x, y] }
     { "type": "spring", "a": [x, y], "b": [x, y], "mode": "push" | "pull" }   (no mode: relaxed)
     { "type": "axle",   "at": [x, y] }
     { "type": "pin",    "at": [x, y] }
     { "type": "bolt",   "at": [x, y] }
     { "type": "motor",  "at": [x, y], "dir": 1 | -1 }

   These five are the proof-of-concept rooms, one mechanism each: they stand in
   until the real levels are designed. */
( typeof window !== 'undefined' ? window : globalThis ).MachinesLevels =
[
    {
        "id": "gears",
        "name": { "en": "Gears", "es": "Engranajes", "pt": "Engrenagens", "fr": "Engrenages", "de": "Zahnräder" },
        "w": 24,
        "h": 15,
        "ball": [8.5, 9.05],
        "basket": { "x": 12, "y": 12, "w": 3.5, "h": 2.25 },
        "blocks": [[2, 9.5, 9, 0.5]],
        "pulleys": [],
        "inventory": { "beam": 2, "gear": 3, "axle": 3, "bolt": 2, "motor": 1 },
        "solution": [
            { "type": "gear", "at": [4, 6], "r": 1 },
            { "type": "gear", "at": [7, 6], "r": 2 },
            { "type": "axle", "at": [4, 6] },
            { "type": "axle", "at": [7, 6] },
            { "type": "motor", "at": [4, 6], "dir": 1 },
            { "type": "beam", "a": [7, 6], "b": [7, 9] },
            { "type": "bolt", "at": [7, 8] }
        ]
    },
    {
        "id": "car",
        "name": { "en": "Car", "es": "Coche", "pt": "Carro", "fr": "Voiture", "de": "Auto" },
        "w": 24,
        "h": 15,
        "ball": [10.5, 7.55],
        "basket": { "x": 16.5, "y": 12, "w": 3.5, "h": 2.25 },
        "blocks": [[0, 8, 15, 0.5]],
        "pulleys": [],
        "inventory": { "beam": 2, "wheel": 3, "pin": 3, "bolt": 2, "motor": 2 },
        "solution": [
            { "type": "wheel", "at": [3, 7], "r": 1 },
            { "type": "wheel", "at": [7, 7], "r": 1 },
            { "type": "beam", "a": [3, 7], "b": [7, 7] },
            { "type": "pin", "at": [3, 7] },
            { "type": "pin", "at": [7, 7] },
            { "type": "motor", "at": [3, 7], "dir": 1 }
        ]
    },
    {
        "id": "hoist",
        "name": { "en": "Winch", "es": "Torno", "pt": "Guincho", "fr": "Treuil", "de": "Winde" },
        "w": 24,
        "h": 15,
        "ball": [8.5, 9.4],
        "basket": { "x": 15, "y": 12, "w": 3.5, "h": 2.25 },
        "blocks": [[4, 10.2, 3, 0.5]],
        "pulleys": [[6, 3]],
        "inventory": { "beam": 2, "wheel": 2, "axle": 3, "rope": 3, "motor": 1 },
        "solution": [
            { "type": "beam", "a": [6, 10], "b": [14, 10] },
            { "type": "axle", "at": [14, 10] },
            { "type": "wheel", "at": [2, 3], "r": 1 },
            { "type": "axle", "at": [2, 3] },
            { "type": "motor", "at": [2, 3], "dir": 1 },
            { "type": "rope", "a": [2, 3], "b": [6, 3] },
            { "type": "rope", "a": [6, 3], "b": [6, 10] }
        ]
    },
    {
        "id": "weight",
        "name": { "en": "Counterweight", "es": "Contrapeso", "pt": "Contrapeso", "fr": "Contrepoids", "de": "Gegengewicht" },
        "w": 24,
        "h": 15,
        "ball": [8.5, 9.4],
        "basket": { "x": 15, "y": 12, "w": 3.5, "h": 2.25 },
        "blocks": [[4, 10.2, 3, 0.5]],
        "pulleys": [[6, 3]],
        "inventory": { "beam": 2, "wheel": 2, "axle": 2, "rope": 2 },
        "solution": [
            { "type": "beam", "a": [6, 10], "b": [14, 10] },
            { "type": "axle", "at": [14, 10] },
            { "type": "wheel", "at": [3, 6], "r": 1 },
            { "type": "rope", "a": [3, 6], "b": [6, 3] },
            { "type": "rope", "a": [6, 3], "b": [6, 10] }
        ]
    },
    {
        "id": "spring",
        "name": { "en": "Spring", "es": "Muelle", "pt": "Mola", "fr": "Ressort", "de": "Feder" },
        "w": 24,
        "h": 15,
        "ball": [10.5, 11.4],
        "basket": { "x": 17, "y": 12, "w": 4, "h": 2.25 },
        "blocks": [[15, 8, 0.5, 6.5], [11.5, 9, 1, 0.5]],
        "pulleys": [],
        "inventory": { "beam": 2, "spring": 2, "axle": 2, "bolt": 1 },
        "solution": [
            { "type": "beam", "a": [7, 12], "b": [14, 12] },
            { "type": "axle", "at": [14, 12] },
            { "type": "spring", "a": [10, 14], "b": [10, 12], "mode": "push" }
        ]
    }
];
