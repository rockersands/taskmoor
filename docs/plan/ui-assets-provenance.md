# Interface assets: where they came from

Every generated image in the interface is listed here. They are original images, made from the
prompts below, with no reference image uploaded and no brand or named artist asked for.

**Open question for the user:** Taskmoor is AGPL and meant to be public. Before any of these
ships in a release, check that Gemini's terms allow it. The user chose them for the interface on
2026-11-02 (ADR-114); that check is still open. None is a logo or brand mark; those stay the
user's decision.

All were made with the Gemini web app (gemini.google.com, the "Pro" mode shown in its model
picker) in the user's Chrome on 2026-11-02, in one chat. Originals are in `.cache/ui-assets` in
the worktree and are not committed. The files are in `apps/web/src/assets/glass/`, and the build
puts them inside the stylesheet, so the single-file kit keeps them.

| File | Size | Prompt | Processing |
|---|---|---|---|
| `bg-dusk.webp` (dark canvas) | 3 KB | Generate an image: an abstract soft background texture, wide 16:10 landscape. Deep dusk colours, ink blue and plum with a low warm amber glow near the bottom edge, made of smooth overlapping layers of coloured light with very soft edges. No objects, no text, no logos, no people, no hard lines. Very smooth and low in detail, a quiet backdrop for a software interface. | Edges cropped 4 to 5 %, 960x597, WebP q72 |
| `bg-dawn.webp` (light canvas) | 2 KB | Generate an image: the same kind of abstract soft background texture, wide 16:10 landscape, now in pale dawn colours: pearl white, powder blue, soft lilac and a faint peach glow near the bottom edge. Smooth overlapping layers of light with very soft edges, very light overall. No objects, no text, no logos, no people, no hard lines. | Edges cropped 4 to 5 %, 960x597, WebP q78 |
| `empty-cards.webp` (empty states) | 4 KB | Generate an image: a small, simple illustration for an empty list in a work app. Three rounded translucent cards in soft blue, lilac and peach, stacked and slightly fanned, floating with a gentle shadow, with a small check mark shape on the top card. Clean modern vector look, centred, square format, on a plain pure white background. No text, no letters, no logos, no people. | Saved at 1024x1024 from the page. The white around the cards was made transparent and the cards and check mark kept solid, so the check stays light in the dark skin; the grey shadow became soft black. Cropped, 171x224, WebP q78 |

`canvas-samples.json` next to `styles/contrast.test.ts` holds pixels measured from the two canvas
pictures (`node apps/web/build/canvas-samples.mjs`). Replacing a picture without running it fails
that test.

Two more pictures, a saturated teal and violet one and a bright aqua and lilac one, were generated
for the same review and not chosen. They are not in the repository.
