# Interface assets: where they came from

Every generated image in the interface is listed here. They are original images, made from the
prompts below, with no reference image uploaded and no brand or named artist asked for.

**Open question for the user:** Taskmoor is AGPL and meant to be public. Before any of these
ships in a release, check that Gemini's terms allow it. Until then they are preview files
(`apps/web/public/glass/`, used only behind the `?canvas=` and `?art=` preview flags). None is a
logo or brand mark; those stay the user's decision.

All were made with the Gemini web app (gemini.google.com, the "Pro" mode shown in its model
picker) in the user's Chrome on 2026-11-02, in one chat. Originals are in `.cache/ui-assets` in
the worktree and are not committed.

| File | Size | Prompt | Processing |
|---|---|---|---|
| `bg-dusk.webp` | 3 KB | Generate an image: an abstract soft background texture, wide 16:10 landscape. Deep dusk colours, ink blue and plum with a low warm amber glow near the bottom edge, made of smooth overlapping layers of coloured light with very soft edges. No objects, no text, no logos, no people, no hard lines. Very smooth and low in detail, a quiet backdrop for a software interface. | Edges cropped 4 to 5 %, 960×597, WebP q72 |
| `bg-dawn.webp` | 2 KB | Generate an image: the same kind of abstract soft background texture, wide 16:10 landscape, now in pale dawn colours: pearl white, powder blue, soft lilac and a faint peach glow near the bottom edge. Smooth overlapping layers of light with very soft edges, very light overall. No objects, no text, no logos, no people, no hard lines. | Edges cropped 4 to 5 %, 960×597, WebP q78 |
| `bg-vivid-dark.webp` | 9 KB | Generate an image: an abstract background texture, wide 16:10 landscape, richer and more saturated: deep teal and violet with flowing bands of aqua and magenta light, smooth and liquid looking with very soft edges, dark overall. No objects, no text, no logos, no people, no hard lines. | Saved at 1024×637 from the page; edges cropped, 960×597, WebP q62 |
| `bg-vivid-light.webp` | 8 KB | Generate an image: an abstract background texture, wide 16:10 landscape, bright and fresh: flowing bands of aqua, sky blue, lilac and soft pink on a near white base, smooth and liquid looking with very soft edges, light overall. No objects, no text, no logos, no people, no hard lines. | Saved at 1024×637 from the page; edges cropped, 960×597, WebP q62 |
| `empty-cards.webp` | 21 KB | Generate an image: a small, simple illustration for an empty list in a work app. Three rounded translucent cards in soft blue, lilac and peach, stacked and slightly fanned, floating with a gentle shadow, with a small check mark shape on the top card. Clean modern vector look, centred, square format, on a plain pure white background. No text, no letters, no logos, no people. | Saved at 1024×1024 from the page; white keyed to transparency, cropped, 211×280, WebP q80 |

`apps/web/public/glass/preview.js` and `apps/web/src/styles/glass-preview.css` are hand-written
for the review and go when the choice is made, along with any of these files not chosen.
