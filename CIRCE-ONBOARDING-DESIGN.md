# Circe Onboarding — Design Spec

**Audience:** whoever builds the Circe fork of `hermes desktop` (Sara + one
coding agent). This is a design doc — the shape of the onboarding
experience, decision flow, and where responsibility for each part lives.
Not a build plan. Not code.

**Relationship to `hermes desktop`:** Circe is a fork of
`apps/desktop/` from the upstream Hermes repo. We inherit the Electron
shell, the managed Hermes-runtime install flow, the `hermes serve`
backend protocol, the shared client in `apps/shared/`, the design system,
i18n, and auto-update. We add fleet-tile behavior, profile management,
character theming, and orchestrator handoff on top.

**Relationship to MCPs:** MCPs are NOT part of this onboarding. The
wizard's last screen hands the user off to their first tile — an
orchestrator agent, running as a normal Hermes conversation — which owns
the "what do you want to do → wire the right MCPs" flow from there.

---

## What already exists upstream (won't rebuild)

From reading `apps/desktop/src/store/onboarding.ts` and README/DESIGN:

- **Provider picker** — OAuth or API-key entry. Curated OAuth providers
  discovered via `listOAuthProviders()`. Fallback to API-key form when
  no OAuth is available. **Nous Portal** covers a model + Tool Gateway
  (web, browser, image_gen, tts, video_gen) in one OAuth.
- **OAuth flow states** — PKCE, device code, external browser, polling,
  submission. Full state machine already in `onboarding.ts`.
- **Model confirmation** — after credential success, show the just-
  authenticated provider's recommended model, allow change via
  `ModelPickerDialog`.
- **"Choose later" skip** — persisted in localStorage
  (`hermes-onboarding-skipped-v1`), never re-nags. App runs but chat
  requires provider before it works.
- **Managed Hermes install** — on first launch with no runtime present,
  the app installs the Hermes Agent runtime into `HERMES_HOME`
  (`~/.hermes` on Unix, `%LOCALAPPDATA%\hermes` on Windows). This solves
  the "Hermes isn't installed" branch entirely — we don't build a
  separate installer, we inherit this one.
- **Boot overlay + error/loading primitives** — `Loader`, `ErrorState`,
  `BrandMark`, plus the onboarding overlay's staggered "matrix" fade-down
  animation.
- **Design system** — button/control/segment primitives, tokens, i18n
  across en/ja/zh/zh-hant.

**What's absent upstream** (Circe's new work):

- Multi-profile fleet layout. Desktop is one profile, one chat.
- Profile-management flows (create, rename, re-skin).
- Character theming — palettes, avatars, SOUL.md heading conventions.
- Orchestrator-handoff — the "you're set up, now let's figure out what
  you want to do" conversational surface.

---

## Design principles for the Circe additions

1. **Wizard shell, conversational payoff.** The onboarding is a
   traditional multi-screen wizard (welcome → detect → pick → configure
   → skin → done). The moment it ends, the user lands in a chat with an
   orchestrator agent that continues the setup conversationally (MCPs,
   integrations, workflows). Wizard for the deterministic parts;
   conversation for the "what do you want to do" parts.

2. **Inherit `hermes desktop`'s screens verbatim where they exist.**
   Don't reinvent the provider picker, model confirm, or OAuth flow.
   Insert Circe's new screens *around* them, not in place of them.

3. **Progressive disclosure.** A user who wants defaults for every
   choice should reach a working tile in under 90 seconds. A user who
   wants to customize every profile, character, palette, and avatar can,
   but it's opt-in. Every screen has a "use defaults, take me to the
   next step" button.

4. **Character theming is Circe's identity.** The default install
   creates a single "main operator" profile with a suggested character
   name (e.g. "Picard" for Star Trek, "Arthur" for Hitchhiker's, or
   generic "Assistant"). The user can accept, pick from suggested casts,
   or type their own. Adding more profiles is a post-onboarding action,
   not a wizard step — the wizard produces exactly one working profile.

5. **Never rename profiles the user didn't create in this session.**
   If existing profiles are detected, Circe *offers* to rename or skin
   them, but only with an explicit confirm-per-profile step. Never
   surprise-rename. Never surprise-delete.

6. **The wizard's terminal state is a running tile, not a "success"
   screen.** The last screen fades into the first tile, whose
   orchestrator agent opens with a scripted first message (see §7).
   No "onboarding complete!" dead-end.

---

## Screen flow

```
   ┌─────────────────────────────────────────────────────────┐
   │                    Screen 1: Welcome                    │
   │        (Circe brand mark, "Set up your agents")         │
   └──────────────────────────┬──────────────────────────────┘
                              │
                              ▼
   ┌─────────────────────────────────────────────────────────┐
   │             Screen 2: Runtime detection                 │
   │                                                         │
   │   Is Hermes runtime installed at HERMES_HOME?           │
   │                                                         │
   │   • YES → skip to Screen 3                              │
   │   • NO  → managed install (upstream flow, unchanged)    │
   │           progress bar + logs, ~30-60s                  │
   └──────────────────────────┬──────────────────────────────┘
                              │
                              ▼
   ┌─────────────────────────────────────────────────────────┐
   │             Screen 3: Profile detection                 │
   │                                                         │
   │   `hermes profile list` returns N profiles.             │
   │                                                         │
   │   • N == 0                                              │
   │       → Screen 4a (create first profile)                │
   │   • N >= 1                                              │
   │       → Screen 4b (existing profiles: use / rename /    │
   │          skin / add)                                    │
   └──────────────────────────┬──────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
   ┌────────────────────┐         ┌──────────────────────────┐
   │ Screen 4a: Create  │         │ Screen 4b: Existing      │
   │ your first agent   │         │ profiles found           │
   │                    │         │                          │
   │ Character theme    │         │ List of profiles with    │
   │ picker (casts +    │         │ per-row actions:         │
   │ custom).           │         │  • Use as-is             │
   │ Suggested names +  │         │  • Rename & re-skin      │
   │ palette preview.   │         │    (→ Screen 5)          │
   └──────────┬─────────┘         │  • Re-skin only          │
              │                   │    (palette + avatar,    │
              │                   │     name preserved)      │
              │                   │  • Leave alone           │
              │                   │ Plus:                    │
              │                   │  • Add another agent     │
              │                   │    (→ Screen 5)          │
              │                   └────────────┬─────────────┘
              │                                │
              │                                ▼
              │                     ┌──────────────────────────┐
              │                     │ Screen 5: Character      │
              │                     │ walkthrough (per profile │
              │                     │ being renamed / added)   │
              └────────────────────►│                          │
                                    │ Cast → character → name  │
                                    │ → palette → avatar       │
                                    │ → SOUL.md heading        │
                                    └────────────┬─────────────┘
                                                 │
                                                 ▼
   ┌─────────────────────────────────────────────────────────┐
   │       Screen 6: Provider + model (upstream flow)        │
   │                                                         │
   │   For each profile being newly created or that has no   │
   │   provider set: run the upstream OAuth/API-key +        │
   │   model-confirm flow. Batches profiles with the same    │
   │   provider (usually all through Nous Portal).           │
   └──────────────────────────┬──────────────────────────────┘
                              │
                              ▼
   ┌─────────────────────────────────────────────────────────┐
   │        Screen 7: Ready — launching your tiles           │
   │                                                         │
   │   Brief fade — no dead-end "success" screen.            │
   │   Tiles spawn one per profile. The main operator's tile │
   │   opens with the orchestrator's first message (§7).     │
   └─────────────────────────────────────────────────────────┘
```

---

## Screen-by-screen detail

### Screen 1 — Welcome

Purpose: brand moment, single primary action. Copy: "Set up your agents"
or similar. Primary button: "Get started." Secondary link: "I already
have Hermes running" (jumps to Screen 3 and skips the runtime install
even if detection would trigger it — power-user escape hatch).

Motion: use the design system's "matrix" fade-down (already implemented
for the upstream onboarding entry).

### Screen 2 — Runtime detection

Purpose: check whether the Hermes runtime is installed. Two paths:

- **Present** — animate a brief "Hermes runtime found (v X.Y.Z)"
  confirmation and advance to Screen 3 within ~1 second. No user action.
- **Absent** — run the upstream managed install (`electron/main.ts`
  install path). Show progress with `Loader` (`lemniscate-bloom`
  variant), stream install logs into a collapsible `LogView`. On
  failure, use `ErrorState` with retry + link to
  `HERMES_HOME/logs/desktop.log`.

Under the hood: reuse `evaluateRuntimeReadiness()` and the existing
managed-install code paths. No new logic.

### Screen 3 — Profile detection

Purpose: decide whether we're creating the user's first profile or
managing existing ones.

Run `hermes profile list` (or the JSON-RPC equivalent through
`hermes serve`) and count profiles that aren't the boilerplate default.

- **Zero profiles OR only the untouched default profile:** advance
  automatically to Screen 4a. Do not require a click.
- **Any real profiles present:** show Screen 4b.

Definition of "untouched default": SOUL.md still starts with the
scaffold string `You are Hermes Agent`, no `avatar.*` file present, and
no user-set display name in the profile's config. This heuristic keeps
a fresh install from showing "you already have a profile called
'default'" on Screen 4b, which would be confusing.

### Screen 4a — Create your first agent

Purpose: get the user from "no profiles" to "one working, themed
profile" as fast as possible.

**Layout:**

- Header: "Meet your first agent."
- **Character-theme picker** as a horizontal `SegmentedControl` row of
  casts. Suggested casts:
  - **Star Trek: TNG** (Picard, Data, Troi, Geordi, Wesley, Locutus)
  - **Hitchhiker's Guide** (Arthur, Ford, Zaphod, Trillian, Marvin,
    Slartibartfast, Deep Thought, Vogon)
  - **Greek mythology** (Athena, Hermes, Circe, Prometheus, Hecate)
  - **Neutral** (Alpha, Beta, Gamma, Delta — no fictional persona for
    users who want a professional-looking tile)
  - **Custom** (type-in — user provides their own name and picks a
    palette manually)
- Default selection: **Neutral**. Users who want personality opt in; the
  wizard doesn't push a fandom on them.
- Below the cast picker: **suggested character card** with:
  - Character name (e.g. "Picard")
  - Suggested tagline (e.g. "the diplomat")
  - Preview swatch of the palette (accent, tile background)
  - Sample avatar (either a stock brand-safe illustration Circe ships,
    or the default `BrandMark`)
- Two primary actions: **"Start with this agent"** (accepts the
  suggested character + palette + name) and **"Customize this agent"**
  (goes to Screen 5 for full walkthrough).

**Rationale:** the average user picks a cast, sees a sensible default,
clicks "Start." The user who wants control gets it via "Customize."

### Screen 4b — Existing profiles found

Purpose: show the user what already exists on their machine and offer
non-destructive actions.

**Layout:** a list of `ListRow`s, one per existing profile. Each row
shows current display name (from SOUL.md), current avatar (or initial
fallback), current model, and per-row action buttons:

- **"Use as-is"** — no changes to this profile. Default action.
- **"Re-skin"** — opens an inline mini-editor: palette + avatar only.
  Preserves the profile's name and SOUL.md content.
- **"Rename & re-skin"** — goes to Screen 5 for the full character
  walkthrough on this profile.
- **"Leave alone (don't tile)"** — profile stays configured but Circe
  won't spawn a tile for it. Useful for headless / cron / gateway
  profiles.

Above the list: an "Add another agent" button that jumps to Screen 5
for a new (not-yet-existing) profile.

Below the list: a "Continue" primary button that accepts the current
per-row selections and advances.

**Constraint:** Circe never renames or re-skins without an explicit
per-profile confirm. Default per-row action is "Use as-is." A user who
clicks "Continue" without touching anything ends this screen with zero
changes to existing profiles.

### Screen 5 — Character walkthrough

Purpose: one profile at a time, walk the user from "I want to add /
rename this agent" to a fully themed profile. Reused for both new
profiles (from 4a "Customize" or 4b "Add another") and renames (from
4b "Rename & re-skin").

**Sub-steps within Screen 5** (all on one screen, not sub-navigated —
`SegmentedControl` or similar to switch panels; state persists as the
user moves between panels):

1. **Cast + character** — same picker as Screen 4a, plus a character
   selector for the chosen cast.
2. **Name** — pre-filled with the character's canonical name, editable.
   Real-time validation: alphanumeric + hyphen/underscore, unique
   across existing profiles, ≤ 32 chars.
3. **Palette** — accent color + tile background swatch. Auto-generated
   from the character's cast/role, editable via color pickers. Preview
   applied to a mock tile beside the picker.
4. **Avatar** — two sources (no stock library — see §Non-goals):
   - **Upload** (drag-drop or file picker; auto-crop to circle). The
     user provides their own image from wherever they like.
   - **Generate** (calls the image-gen model the user just
     authenticated — Nous Portal's Tool Gateway covers this, or a
     provider-native image model if configured). Prompt is composed
     from the character's name, cast, and tagline. Takes ~10–30s;
     show `Loader` and allow retry / regenerate. If the user doesn't
     like the result, they can regenerate up to N times (suggested
     limit: 5 per character to prevent runaway cost) or fall back to
     upload / initial-letter.
   - **Skip** (initial-letter fallback — the current default). One-tap
     out; the tile shows a colored circle with the character's first
     letter. Legally cleanest, zero-latency.
5. **SOUL.md heading + tagline** — pre-filled `# <Name> — <tagline>` line
   that becomes the first line of the profile's SOUL.md. This drives the
   tile display name via Circe's existing `readDisplayName` logic. Below
   the heading field, a small text area for the user to add a
   role/instruction line (optional; if left blank, Circe writes a
   sensible default like "You are <Name>, a <cast> character running as
   an assistant.").

**Bottom of screen:** "Save" (advances to next profile in the queue if
any, else to Screen 6) and "Back" (returns to Screen 4a/4b without
saving this profile's edits).

### Screen 6 — Provider + model

Purpose: attach a working model provider to every profile that doesn't
have one yet.

**This screen is almost entirely the upstream `hermes desktop`
onboarding.** Reuse:

- The OAuth provider picker (`listOAuthProviders`)
- The Nous Portal recommendation
- The API-key fallback form
- The model confirm step (`fetchProviderDefaultModel` +
  `ModelPickerDialog`)
- The "choose a provider later" escape hatch

**Circe's additions:**

- **Batching** — if the wizard created N profiles in Screen 4a/5, run
  the provider OAuth once and offer to apply it to all N profiles. The
  common case is "Nous Portal for everyone" and re-doing OAuth per
  profile is friction the upstream doesn't have because it's
  single-profile.
- **Per-profile provider override** — small "Configure this profile
  differently" link on each profile row for the user who wants (e.g.)
  Picard on Portal and Locutus on a local model.

### Screen 7 — Ready

Purpose: transition into the running fleet. Not a destination.

Behavior:
- Show the `BrandMark` centered with a short line like "Launching your
  fleet…"
- Spawn one Circe tile per profile the wizard created / configured (not
  profiles marked "leave alone" in Screen 4b).
- Position the wizard window off-screen or animate its dismissal as the
  tiles fade in.
- The **main operator profile's tile** (the first one created in Screen
  4a, or the one the user marked as primary in Screen 4b) is
  foregrounded. Its access-mode gate opens 🔓 by default. All other
  tiles open in the state they persisted to, or 🔓 if fresh.
- The main operator tile's orchestrator agent auto-sends its opening
  message (see §7 below). Other tiles start blank, ready for the user.

---

## §7 Orchestrator handoff

The moment the wizard finishes, the main operator's tile is a normal
Hermes chat. What makes it an "orchestrator" is a **scripted first
message** that the wizard writes into the tile as an agent bubble (not a
user bubble), plus a small pre-loaded skill that primes the agent for
this conversation.

**The scripted first message** (approximate copy, i18n-managed):

> Hi — I'm <Name>. Circe just finished setting up your fleet. You have
> <N> agents ready to go.
>
> Before we start, tell me a bit about what you want to use them for.
> Some things I can help wire up right now:
>
> • **Email** — send, draft, and search Gmail
> • **Calendar** — schedule meetings, look up availability
> • **Docs & Sheets** — create and edit
> • **Coding** — GitHub, filesystem, local shell
> • **Notes** — Obsidian, local files, memory
> • **Chat & communication** — Slack, Discord
> • **Web** — search, read pages
> • **Something else** — tell me what you're trying to do
>
> Pick one to start with, or say "let me look around first" and I'll
> just be here when you're ready.

**Where this lives:**
- A skill named something like `circe-orchestrator-first-run` gets
  written to the profile's skills directory during Screen 7. It's a
  short skill that codifies the "listen for workload → suggest MCP →
  propose wire-up command → hand off to user's terminal for OAuth" flow.
- The first message itself is written by Circe (main process) directly
  into the tile's message list via the ACP session, not typed by the
  user, so it appears the instant the tile opens.

**What the orchestrator does after the user replies** (out of scope for
this doc — this is the skill's job, not the wizard's):
- Maps workload to specific MCP servers.
- Proposes the exact `hermes mcp add` command for the user to run.
- Explains which parts need a browser (OAuth) and which the agent can
  drive.
- Verifies with `hermes mcp test` and reports back.
- Logs the wire-up to the profile's CHANGELOG.

This is where the DJ-specific runbook we wrote earlier
(`DJ-MCP-SETUP.md`) would live for DJ engineers, and where a
generic version would live for everyone else. The wizard doesn't need
to know about specific MCPs; it just launches the tile that does.

---

## What each existing upstream file gets forked into

Not a build plan — just enough pointers to make the design concrete.
Everything in `apps/desktop/` in the Hermes repo has a Circe
counterpart:

| Upstream file | Circe counterpart | What changes |
|---|---|---|
| `src/store/onboarding.ts` | `src/store/onboarding.ts` | Extend state machine with `screen: 'welcome' \| 'runtime' \| 'profiles' \| 'create' \| 'existing' \| 'walkthrough' \| 'provider' \| 'ready'`. Wrap existing OAuth flow in Screen 6. |
| `src/components/onboarding/*.tsx` | `src/components/onboarding/*.tsx` | Add screens 1, 3, 4a, 4b, 5, 7. Screen 2 reuses upstream install component. Screen 6 wraps upstream provider picker. |
| — (doesn't exist) | `src/components/profile-manager/*.tsx` | New: per-profile row, character picker, palette editor, avatar picker, SOUL.md editor. Reused between Screens 4b and 5. |
| — (doesn't exist) | `src/lib/avatar-generator.ts` | New: composes an image-gen prompt from the character's cast/name/tagline, calls the user's authenticated image-gen model (via the gateway client in `apps/shared/`), returns the resulting bytes for the walkthrough step. Handles regenerate + cancel + rate-limit. |
| — | `src/lib/character-casts.ts` | New: cast → character → suggested palette / tagline mapping. Static data, i18n-aware. **No avatar references** — those are generated or uploaded per-user. |
| `electron/main.ts` | `electron/main.ts` | Add IPC handlers for profile create/rename/re-skin (delegating to Hermes CLI or `hermes serve` calls). Add fleet-tile spawn logic (currently Circe's `main.js`). |
| `apps/shared/` | reused as-is | The gateway client. No changes. |

**The character-cast data (`character-casts.ts`)** is the one net-new
data artifact worth calling out. It's small (a few hundred lines of
static TypeScript) but it's what makes Circe feel like Circe. Each cast
entry has:

- Cast display name + tagline
- List of characters, each with: name, tagline, suggested palette
  (accent, tile-bg, tile-border, accent-soft, accent-glow), suggested
  SOUL.md role line, and a **prompt seed** used by
  `avatar-generator.ts` when the user picks "Generate."

The prompt seed is a short descriptive phrase, not a likeness request.
For example, Picard's seed is something like `"a composed diplomatic
starship captain, semi-abstract portrait, no recognizable actor"` — the
seed steers the user's image model toward the character's *vibe*
without asking it to reproduce anyone's face. What the user's model
actually returns is between them and their model; Circe doesn't police
outputs.

---

## Open questions to resolve before build

These aren't blockers for the design; they're decisions to make when the
build starts.

1. **Fork base version.** Which upstream Hermes tag do we fork
   `apps/desktop/` from? Every upstream release adds features; picking
   a specific tag defines the merge base. Recommendation: fork the
   latest release at build-start time and commit-track upstream
   quarterly for cherry-picks (auto-update, security, new provider
   support).

2. **Fleet-tile rendering: separate BrowserWindows (Circe's current
   approach) or one BrowserWindow with a tabbed / tiled layout?**
   Upstream `hermes desktop` is one window. Circe's `main.js` today
   opens N `BrowserWindow`s. Both are viable; separate windows is what
   Circe users are already used to, but a single-window tabbed mode
   would inherit more of the upstream desktop's chrome (titlebar
   actions, menu bar). Suggested default: keep Circe's separate-window
   fleet as the primary layout, add a single-window "cockpit" mode as
   a future option.

3. **First-launch orchestrator skill authoring.** Who writes the
   `circe-orchestrator-first-run` skill and where does it live? Options:
   (a) ship it inside the Circe app bundle and copy it to the profile
   on Screen 7, or (b) generate it dynamically from a template so it can
   be customized per cast (Picard-flavored intro vs Marvin-flavored
   intro). Recommendation: (a) for v1, (b) as an enhancement once the
   flow is stable.

4. **Avatars — no stock library.** Circe ships zero pre-made character
   images. Every avatar is either user-uploaded or generated at
   walkthrough-time by the user's own image-gen model (Tool Gateway
   `image_gen` when the user is on Nous Portal, or a provider-native
   model otherwise). Rationale: (1) legal cleanliness — no risk of
   shipping likenesses that infringe on studio-owned character art,
   (2) every user's fleet feels unique rather than sharing a stock set,
   (3) no runtime dependency on scraping third-party sites like
   Wikipedia or fan wikis (which host copyrighted material under
   fair-use claims that don't extend to a desktop app). The
   initial-letter fallback stays as the zero-config default. See
   §Non-goals for what this rules out.

5. **i18n scope for Circe additions.** Upstream keeps four locales in
   sync (en/ja/zh/zh-hant). Circe should match. Character names
   themselves stay in original scripts (Picard is Picard everywhere);
   taglines and UI copy get translated.

---

## Non-goals (deliberately not in this design)

- **MCP wiring in the wizard.** Handled by the orchestrator agent in
  the first tile, post-wizard. See §7.
- **Company-specific setup (DJ or otherwise).** The orchestrator's skill
  can encode company defaults (e.g. detect DJ email → suggest DJ MCPs),
  but that's the skill's job, not the wizard's. The wizard is
  company-agnostic.
- **Stock character avatars.** Circe ships zero pre-made portraits or
  symbolic marks. Every avatar comes from the user (upload) or the
  user's model (generate). Explicitly rules out: shipping a bundled
  avatar library, scraping Wikipedia infobox images, scraping fan
  wikis (Memory Alpha, Hitchhiker's Wiki, etc.), or pulling from any
  third-party image host at install-time. All three of those paths
  either infringe on studio IP (most character images on those sites
  are studio-owned promotional stills hosted under a fair-use claim
  that doesn't extend to us) or create a runtime dependency the
  installer shouldn't have.
- **Auto-update, code signing, release engineering.** All inherited from
  `apps/desktop/`. No Circe-specific changes needed.
- **Multiple main-operator profiles.** Circe's design assumes exactly
  one profile in the "main operator" role at a time. The user can
  change which profile plays that role from settings later, but the
  wizard produces exactly one.
- **Non-desktop deployment.** Circe is desktop-first. The `hermes
  dashboard` web UI, WhatsApp gateway, and other Hermes surfaces are
  out of scope.
