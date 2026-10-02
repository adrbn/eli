# Product

## Register

product

## Users
Two audiences, in this order:
1. **Curious non-technical people** who downloaded a cute talking robot for their Mac. They don't know what an API key, an LLM or Navidrome is, and shouldn't need to understand it to get Eli talking.
2. **Tech-curious tinkerers** coming from GitHub, who want to see it alive fast, will happily paste a key or point it at their own local model, and hate being slowed down by explanations they don't need.

Context: first launch of a Mac app, often on a laptop, alone, a bit curious and slightly wary of setup chores.

## Product Purpose
Eli is a talking robot face (green phosphor pixels on black) that gives a voice and a face to an LLM: it listens, answers aloud with lip sync, remembers you, sings songs from your library. Success on first launch: within a minute, Eli speaks to you in a voice you chose, understands you, and you smile.

## Brand Personality
Alive, playful, warm. Eli is a character, not a settings screen: he is present from the very first second, reacts to what you do (looks, blinks, smiles), and the interface speaks in his voice ("he", "his voice", tutoiement in French). Calm and native-Mac in its craft, a little retro in its phosphor glow, never childish.

## Anti-references
- A settings form: stacked preference rows in a card (what the first onboarding was).
- A SaaS wizard: centered card, "Step 2 of 4", progress bar, big generic green CTA.
- A kids' toy: cartoon bounces, confetti, rainbow colors.
- Neon "AI" aesthetics: cyan/violet glow gradients, decorative glassmorphism.

## Design Principles
1. **The face is the interface.** Eli is on screen and reacting during setup; panels serve him, never hide him.
2. **Plain words first, details on demand.** Explain what a step gives you ("so he can hear and answer you") before how; jargon (API key, OpenAI-compatible, Subsonic) lives one level deeper.
3. **Never make him sound worse than he is.** No fallback voice, no half-ready state presented as ready; wait honestly and show progress.
4. **Every step skippable, nothing lost.** Later is always fine; everything stays reachable in Settings.
5. **Local and private by default, said once, plainly.**

## Accessibility & Inclusion
WCAG 2.2 AA contrast on all text (muted text included), full keyboard path through the onboarding (Tab, Enter, Esc never traps), visible focus, `prefers-reduced-motion` respected (Eli's reactions become gentle cross-fades), French and English.
