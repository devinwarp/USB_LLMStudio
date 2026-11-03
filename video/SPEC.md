# SPEC — "The USB drive" · USB LLM Studio promo

1920×1080 · 30 fps · ~40 s · narrated (en-US-AndrewNeural via edge-tts, per-scene mp3s)

## BANNED by default

No dark-void-floating-cards opener (the drive is the world), no glow/particle fields, no cream-paper serif, no three-cards-in-a-row end beat, no bullet slides, no logo docked in a corner, no everything-fades-up motion, no "Introducing/Meet/unlock/supercharge".

## Palette / type

- ground #0a0a0b · panel #141417 · hairline #2a2a2e · ink #f5f5f7 · dim #8e8e93 · accent #ff6a3d (LED, callouts, end mark only)
- Titles: Inter 800, tight tracking (-0.03em). Labels/terminal: JetBrains Mono.
- Screens are the real PNG captures at 1920×1080, in a framed card (radius 18, 1px hairline, 12 px device bar with 3 dots).

## Voice (the clock)

Per-scene mp3 in assets/, each lands 0.4 s into its scene; scene length = audio + ~1.6 s tail.

## Scenes

1. `plug` — dark desk field; a drawn USB connector slides in from the left into a port slot (0.4–1.4 s); the orange LED tile lights (1.4 s) — that tile IS the brand mark's corner, so the logo is born from the hardware. Title line "No install. No account." types on after the LED.
2. `setup` — terminal card (center, ~70% width): `> ./mac.sh` types, then three check rows tick in (portable runtime / GPU backend / drivers) on a 0.45 s stagger; OS chips mac / linux / windows at top.
3. `chat` — chat.png framed card scales 0.92→1 with a left-side callout chip "local GGUF models"; a cursor-dot taps the composer.
4. `images` — images.png framed card; callout "Stable Diffusion on your GPU".
5. `voice` — transcribe.png slides left half, voice.png slides right half (split-screen collapse to one row); callout "speech → text → speech".
6. `models` — models.png framed card; callout "one click from Hugging Face"; a small pop badge lands on the download icon area.
7. `endcard`: mark.svg wipes in center (the LED tile resolves back into the full mark), "USB LLM Studio" in Inter 800, sub "Your AI studio, on a stick" + "Noncommercial · offline · portable".

## Motion rules

Screens: ease power3.out scale/opacity only, one move each, hold steady after landing (no breathing loops). Callouts: slide in 140 ms after the screen lands, same ease. Cuts are hard cuts between scenes — the VO carries continuity.
