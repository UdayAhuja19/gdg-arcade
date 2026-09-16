# GDG on Campus UOBD — Design Rules

These rules come from the club's `<HIRING>` post. The arcade follows them, and so can slides, event screens and future posts.
The live version is the design sheet at **http://localhost:3000/design-sheet**. It uses the real CSS from `public/css/`, so what it shows is what ships.

---

## 1. Colour

| Name | Hex | Used for |
|---|---|---|
| Paper | `#FFFFFF` | Every background and pill fill |
| Grid line | `#ECECEC` | 1px graph-paper lines, 32px squares |
| Ink | `#111111` | Text, outlines, hard shadows |
| Muted | `#BDBDBD` | Placeholders, empty slots, marquee fades |
| Red | `#EA4335` | Memory Match, rank 3, errors |
| Blue | `#4285F4` | Snake, rank 2, focus rings |
| Yellow | `#FBBC04` | Flappy Byte, rank 1, main buttons |
| Green | `#34A853` | Dino Run |

- **How much of each:** about 70% paper, 20% ink and 10% brand colour.
- Brand colours are **always flat**: no gradients, tints or transparency.
- **One colour per game:** Dino = green, Flappy = yellow, Snake = blue, Memory = red, Stack = ink.
- **Rank colours:** #1 yellow, #2 blue, #3 red.

## 2. Background
Every page and every game screen sits on white graph paper: 1px `#ECECEC` lines on a 32px grid.

## 3. Type
One typeface: **Archivo** (free on Google Fonts and in Canva). Fallbacks: Helvetica Neue, Arial. **Everything is in capitals.**

| Role | Weight | Tracking | Size | Notes |
|---|---|---|---|---|
| Display | 900 | −4% | 64–180px | Line height 0.9. Always in code brackets: `<HIRING>`, `<ARCADE>` |
| Heading 1 | 900 | −4% | 40–72px | |
| Heading 2 | 800 | −2% | 26–36px | |
| Pill label | 700 | +1% | 14–28px | |
| Body | 500 | +2% | 14–16px | Max 78 characters a line |
| Scores | 900 | −2% | any | Tabular numbers so digits don't jump |

## 4. Components

**Sticker pill (our signature).** Fully rounded, white fill, **3px black outline** and a **hard 5px shadow straight down with no blur**.
- In decoration, tilt it anywhere from −14° to +12°.
- When people need to read or click it, keep it straight.
- XL pills use a 4px outline and a 7px shadow.

**Header pill.** A straight sticker pill that says `GOOGLE DEVELOPERS GROUP ON CAMPUS UOBD`, centred at the top. The bracket mark (`public/assets/logo-mark.svg`) goes top-right.

**Thin pill / marquee.** 2px outline with no shadow. It scrolls sideways and fades out at both edges.

**Buttons**
- Primary: brand-colour fill + outline + hard shadow.
- Secondary: a white sticker pill.
- Hover: lifts 2px and the shadow grows to 7px.
- Press: pushes 5px down into its shadow (the shadow goes to 0).
- Keyboard focus: 3px blue outline, 4px away from the button.
- Disabled: everything goes muted grey.

**Name field.** A pill-shaped input with a 3px outline, bold capitals and a muted placeholder. Errors turn the outline red and show a short red line underneath.

**Card / game tile.** 28px corners, 3px outline and a hard shadow. One brand shape in the game's colour peeks out from behind a corner. Everything inside a card stays straight.

**Leaderboard row.** A pill with a 2px outline:
- a round rank badge in the rank colour on the left
- the name
- the score on the right in tabular numbers

Empty slots are dashed and muted. The current player's row gets a hard shadow.

**Badges.** `NEW BEST!`, `PERFECT`, `+10`: small tilted sticker pills that pop in with a spring.

## 5. Shapes
Seven flat shapes (sprite: `public/assets/shapes.svg`):
- triangle
- flower
- blob
- capsule
- bar
- circle
- half circle

- Use flat brand colour only, **never outlined**.
- Scatter 2–6 of them near the edges and let them overlap pill corners.
- Never put two shapes of the same colour side by side.

## 6. Layout
- Lots of white space and a big centred bracketed headline.
- A playful collage of tilted pills and shapes, usually at the bottom.
- Anything people need to use (inputs, game screens, scores) stays straight and easy to read.

## 7. Motion
- **Spring easing:** `cubic-bezier(.34, 1.56, .64, 1)`. Fast = 150ms, default = 220ms.
- Buttons push down in 60ms and bounce back.
- Shapes drift slowly in 8–10s loops.
- If someone has reduced motion turned on, **everything stays still.**

## 8. Voice
Short, loud and friendly. Headings and actions go in code brackets. Buttons say exactly what happens next.

| Say | Skip |
|---|---|
| `<PLAY AGAIN>` | Submit |
| YOU'RE #2! 140 POINTS TO BEAT AHMED R | Oops! Something went wrong :( |
| `SPACE` = JUMP | Press the spacebar key in order to make your character jump |
| USE 2 TO 16 LETTERS OR NUMBERS. | Invalid input |

## 9. Games
Games look like the posts:
- graph-paper background
- flat brand colours
- rounded shapes with a **3px black outline**

No pixel art, no gradients. Brand shapes double as game pieces:

| Game | Look |
|---|---|
| Dino Run | Green rounded dino. Red capsules are cacti. Blue flowers fly. |
| Flappy Byte | A yellow dot bird with a red beak. Pipes are green rounded bars. |
| Snake | A blue snake with an ink outline. Red circle food. A yellow blob bonus. |
| Memory Match | Card backs are red with white `< >`. The fronts show brand shapes and code symbols. |
| Stack Tower | Pill blocks cycling through red, yellow, green and blue, each with an outline and hard shadow. |

Reference art: `public/assets/art/*.svg`.

## 10. Don'ts
- No blurry drop shadows. Shadows are hard and point straight down.
- No gradients.
- No lowercase or light-weight headings.
- No thin or grey outlines on sticker pills.
- No more than 2 brand colours inside one component.
- No tilted inputs, scores or leaderboards.
- No outlines on decorative shapes.

---

**Files**
- `public/css/tokens.css`: the colour, type, spacing and motion variables
- `public/css/base.css`: reset, graph paper and type scale
- `public/css/components.css`: all the pieces above
