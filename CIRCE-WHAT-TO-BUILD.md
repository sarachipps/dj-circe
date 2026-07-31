# Circe — What to Build

**Purpose:** describe what Circe is, what it does, and what the user
experience is. Not how to build it. An LLM reading this doc decides the
architecture, tech choices, file layout, build order, and implementation
approach on its own. This doc only specifies behavior and intent.

**Underlying runtime:** Circe is a desktop application that runs on top
of **Hermes Agent** (the self-improving AI agent from Nous Research —
`hermes-agent.nousresearch.com`). Hermes provides the agent runtime,
model provider integrations, tool calling, memory, skills, MCP server
support, and multi-profile isolation. Circe is the UI layer that lets a
user run multiple Hermes agents side by side as themed, permissioned
tiles.

Circe does not reimplement anything Hermes already does. Where Hermes
already ships a capability (installing the runtime, OAuth-ing into a
model provider, running an agent conversation, managing MCP servers),
Circe wraps or extends that capability rather than replacing it.

---

## 1. What Circe is

A native desktop app that presents a user's fleet of Hermes agents as a
row of side-by-side chat tiles on their desktop. Each tile:

- Runs one Hermes agent (one "profile" in Hermes terminology).
- Has its own conversation history, persona, avatar, color theme, and
  tool/model configuration.
- Streams responses independently — the user can be in a live
  conversation with three agents at once, watching them all work.
- Has a per-tile permission gate that governs whether the agent can
  take real-world actions (write files, call external APIs, spend
  money) without asking.

The point of the fleet layout is **specialization + concurrency**. The
user designates each agent for a functional role (coding, calendar,
research, writes-to-external-systems, etc.) and can hand off work
between them or run multiple in parallel without context-switching a
single agent between unrelated jobs.

Circe is desktop-first (macOS + Windows + Linux). It is not a web app.
It runs entirely on the user's machine — no Circe-operated servers, no
Circe accounts, no telemetry beyond what Hermes itself does.

---

## 2. First-run experience

The first time a user launches Circe, they see a **wizard** that walks
them from nothing to a working fleet. The wizard is Circe's onboarding —
it's the only place Circe forces a linear flow. After the wizard, Circe
is a running desktop app with no modal steps.

The wizard has seven screens. The user can go back at any time; every
screen has a "use the defaults, take me to the next step" primary
action.

### Screen 1 — Welcome

A brand moment. Circe identifies itself, states its value in one line
("Set up your agents"), and offers one primary action to begin. There
is also an escape hatch for power users: "I already have Hermes running
— skip ahead."

### Screen 2 — Runtime detection

Circe checks whether the Hermes runtime is installed on the machine.

- **Installed:** Circe confirms the version and advances automatically
  within about one second. No user action.
- **Not installed:** Circe installs the Hermes runtime. Progress is
  shown with a live log the user can expand if they want detail. On
  failure, a retry action and a link to the install log. This step
  takes 30-60 seconds on a good network.

Circe does not build its own installer for Hermes. Hermes ships a
managed-install path that Circe reuses.

### Screen 3 — Profile detection

Circe checks whether any Hermes agent profiles already exist on the
machine. Branches:

- **No real profiles** (only the untouched scaffold-default from a
  fresh Hermes install, or truly none): advance to Screen 4a.
- **One or more real profiles exist:** advance to Screen 4b.

"Real" here means a profile the user has configured — one with a
non-boilerplate persona file, an avatar, or a custom display name. A
fresh Hermes install has one scaffold profile that Circe recognizes as
"not really configured" and treats as if it doesn't exist.

### Screen 4a — Create your first agent

Shown when the user has no existing profiles. The goal of this screen
is to get the user from "nothing" to "one working, themed agent" in
under a minute.

The user sees:

- A **cast picker** — a horizontal row of options like:
  - Star Trek: TNG (Picard, Data, Troi, Geordi, Wesley, Locutus)
  - Hitchhiker's Guide (Arthur, Ford, Zaphod, Trillian, Marvin,
    Slartibartfast, Deep Thought, Vogon)
  - Greek mythology (Athena, Hermes, Circe, Prometheus, Hecate)
  - Neutral (Alpha, Beta, Gamma, Delta — no fictional persona)
  - Custom (type in a name, pick your own colors)

  The **default selection is Neutral.** Fans opt in to fandoms; the
  wizard doesn't push a persona on a user who might not want one.

- Below the cast picker, a **suggested character card** showing the
  first character of the selected cast: their name, a one-line tagline
  ("the diplomat"), the palette Circe would apply, and a preview of
  what the tile will look like.

- Two primary actions:
  - **Start with this agent** — accepts the suggested character and
    palette as-is, uses the initial letter of the character's name as
    the avatar, and advances to Screen 6.
  - **Customize this agent** — advances to Screen 5 for the full
    walkthrough (name, palette, avatar, persona text).

### Screen 4b — Existing profiles found

Shown when the user has real profiles. Circe lists what it found and
offers non-destructive actions per profile.

Each profile appears as a row with:

- Its current display name (from its persona file)
- Its current avatar (or initial-letter fallback if none)
- Its current model
- Per-row action buttons:
  - **Use as-is** — no changes. Default.
  - **Re-skin** — inline mini-editor for palette + avatar only. Name
    and persona preserved.
  - **Rename & re-skin** — full walkthrough on this profile (Screen 5).
  - **Leave alone (don't tile)** — the profile stays configured but
    Circe doesn't spawn a tile for it. For headless / cron / gateway
    profiles the user runs but doesn't want a chat window for.

Above the list: an **Add another agent** action that opens Screen 5
for a new profile.

Below the list: a **Continue** action that accepts the current
per-row selections and advances.

**Constraint:** Circe never renames or re-skins a profile without an
explicit per-profile confirm. A user who reaches this screen and clicks
Continue without touching anything ends with zero changes to existing
profiles.

### Screen 5 — Character walkthrough

Shown when the user is adding a new profile or renaming an existing
one. One screen, one profile at a time, walked in five panels the user
can move between:

1. **Cast + character.** The user picks a cast (or "Custom") and then
   a specific character within the cast. Pre-filled from whatever
   context led here (Screen 4a's cast selection, or the profile being
   renamed).

2. **Name.** Pre-filled with the character's canonical name. Editable.
   Validated in real time: alphanumeric with hyphens and underscores,
   unique across existing profiles, at most 32 characters.

3. **Palette.** An accent color and a tile background color. Pre-filled
   from the character's suggested palette. Editable via color pickers.
   A mock tile beside the pickers shows what the tile will look like.

4. **Avatar.** Three options:
   - **Upload** — drag-drop or file picker. Auto-cropped to a circle.
   - **Generate** — Circe calls the user's authenticated image-generation
     model with a prompt composed from the character's cast, name, and
     tagline. Takes 10-30 seconds. Shows a loader. The user can
     regenerate if they don't like the result (limit five per
     character to prevent runaway cost). If no image model is
     available, this option is hidden.
   - **Skip** — the tile shows a colored circle with the character's
     first letter. Fastest, zero cost, no dependencies.

   Circe ships **no stock character images.** Every avatar is either
   user-uploaded or model-generated. This is deliberate.

5. **Persona.** A pre-filled first line for the profile's persona file:
   `# <Name> — <tagline>`. This drives the tile's display name. Below
   that, an optional multi-line text area where the user can add role
   or instruction text ("You are Marvin, the depressed android from
   Hitchhiker's Guide, but you still do the work"). If left blank,
   Circe writes a sensible default.

Bottom of screen: **Save** advances to the next profile in the queue
if there are more to configure, otherwise to Screen 6. **Back** returns
to Screen 4a or 4b without saving this profile's edits.

### Screen 6 — Provider + model

Every profile Circe created or reconfigured needs a working model
provider attached to it.

This screen reuses the Hermes runtime's existing provider setup — OAuth
picker, API-key fallback, model confirmation. Circe doesn't reinvent
that flow.

**Circe's additions on top:**

- **Batching.** If the user created multiple profiles in Screens 4a
  and 5, offer to authenticate a provider once and apply it to all of
  them. The common case is "one provider for everyone." Doing OAuth
  per profile is friction Circe can save the user.

- **Per-profile override.** A small "configure this profile
  differently" affordance on each profile row for users who want (for
  example) one profile on a cloud model and another on a local model.

- **Skip.** The user can defer this and connect a provider later from
  settings. Circe launches the tiles anyway, and chat won't work in
  those tiles until a provider is connected. This matches the
  underlying Hermes onboarding's own escape hatch.

### Screen 7 — Ready

Not a destination. A brief transition into the running fleet.

Circe shows a centered brand mark with a line like "Launching your
fleet…" for one or two seconds, then:

- One tile spawns per profile the wizard configured (excluding any
  profile the user marked "leave alone" in Screen 4b).
- Tiles arrange themselves in a grid across the primary display, or
  restore to their prior positions if they had any.
- The **main operator profile's tile** is foregrounded. This is either
  the profile the user created first in Screen 4a, or the profile
  the user marked as primary in Screen 4b.
- All new tiles' permission gates open in **unlocked** state (see §4).
  Existing tiles restore to whatever gate state they had persisted.

The wizard window fades and closes. The user is now in the app.

---

## 3. The fleet — Circe's steady-state UX

After the wizard, Circe is a set of independent tile windows on the
user's desktop. There is no central "Circe app window" — each tile is
the app, and Circe is what they collectively are.

### 3.1 What a tile looks like

A tile is a small (roughly 500×600 pixel), rounded, translucent chat
window with:

- A **header** showing the profile's display name, its current model
  name in small type, an avatar circle, and a **permission-gate button**
  (see §4).
- A **tab strip** below the header. Each tile can have multiple
  concurrent conversations ("workstreams") with the same agent. Tabs
  can be created, closed, renamed by first-user-message content, and
  visually indicate when the agent is busy or has produced a response
  the user hasn't seen yet.
- A **transcript** area filling most of the tile: user messages,
  agent messages (with streaming and markdown rendering), tool-call
  activity indicators, and inline permission cards (see §4).
- A **composer** at the bottom: text input and send button. While the
  agent is responding, the send button becomes a stop button.

The tile is **draggable** by its top area (macOS titlebar-hidden style,
transparent chrome). Resizable by its edges. Position and size persist
across restarts.

### 3.2 Per-profile theming

Every tile carries the visual identity of its profile: accent color,
tile background color, border, glow. These come from the palette the
user picked in Screen 5 (or the default palette suggested for the
character). Themes are per-profile — three tiles side by side look
distinctly different from each other, and the user can tell at a
glance which one they're looking at.

The avatar shown in the tile header comes from the profile's avatar
file (uploaded or generated during the walkthrough). If none, the tile
shows the character's first initial in a colored circle.

### 3.3 What running multiple tiles feels like

The user can:

- Type in one tile while another is streaming a response.
- Watch multiple tiles work in parallel — each shows its own live
  agent activity, tool calls, streaming text.
- Copy content between tiles (standard OS copy/paste).
- Close and reopen tiles freely. State (tab history, current tab,
  window position, permission-gate mode) persists across restarts.
- Add a new agent to the fleet at any time (see §6).
- Rearrange tiles by dragging them wherever they want on the desktop.

There is no "focus mode," no "hide other tiles," no minimize-all. Each
tile is its own OS-level window, and the OS's window management is
the tile management.

### 3.4 What Circe does when the user quits

Closing the last tile quits Circe. All tiles' Hermes subprocesses shut
down cleanly. State is persisted. Reopening Circe restores the fleet
to the last-saved state (which tiles were open, their positions, their
tab histories, their permission modes).

---

## 4. The permission gate

Each tile has a **permission button** in its header showing one of
three states:

- 🔒 **Locked** — every tool-call permission request the agent makes is
  auto-denied. The tile still renders a small card in the transcript
  showing what was denied, so the user can see the agent tried to do
  something.
- ⛔ **Ask** — permission requests pause the agent and render an
  interactive card inline in the transcript. The card shows what the
  agent wants to do (which tool, what arguments where relevant) and
  offers Allow and Deny buttons. The agent waits until the user clicks.
- 🔓 **Unlocked** — every permission request is auto-approved silently.

Clicking the permission button **cycles** through the three states
(locked → ask → unlocked → locked).

**Default state per profile:**
- New profiles created in the wizard open in **unlocked**.
- One exception: profiles designated as **coding profiles** (a role the
  user picks in the walkthrough or a designation Circe infers from the
  character — e.g. a profile named "Locutus" or one with a persona line
  mentioning "coding") open in **locked**. Coding agents write files and
  run commands; the safer default is to ask.

The permission state persists per profile across restarts.

**Behavior detail:** if the user cycles the button *away* from "ask"
while a permission card is pending in the transcript, Circe resolves
all pending cards with "cancelled" so the underlying agent isn't left
waiting forever on an abandoned prompt.

---

## 5. The orchestrator handoff — Circe's first real conversation

The moment the wizard ends and the main operator's tile opens, Circe
writes a **scripted opening message** into that tile as if the agent
sent it. This is Circe's most important behavior after the wizard,
because it's where the user goes from "the app is set up" to "the app
is useful."

The message looks something like:

> Hi — I'm [Name]. Circe just finished setting up your fleet. You have
> [N] agents ready to go.
>
> Before we start, tell me a bit about what you want to use them for.
> Some things I can help wire up right now:
>
> - **Email** — send, draft, and search Gmail
> - **Calendar** — schedule meetings, look up availability
> - **Docs & Sheets** — create and edit documents
> - **Coding** — GitHub, filesystem, local shell
> - **Notes** — Obsidian, local files, memory
> - **Chat & communication** — Slack, Discord
> - **Web** — search, read pages
> - **Something else** — tell me what you're trying to do
>
> Pick one to start with, or say "let me look around first" and I'll
> just be here when you're ready.

The exact wording is translated per locale. The list of workflows is
suggestive, not exhaustive — the user can name anything.

When the user replies, the main operator agent takes over. It has a
Circe-provided skill loaded that codifies how to:

- Map a user's stated workflow (email, calendar, coding, etc.) to
  specific MCP servers or Hermes integrations.
- Propose the exact commands or config the user (or Circe) needs to
  run to wire that integration up.
- Explain which parts need a browser (OAuth flows) versus which the
  agent can do itself.
- Verify that the integration is working before declaring it done.
- Log the change in a way that's replayable later.

**Critical scope point:** the wizard does **not** wire MCPs itself.
That's the orchestrator agent's job, conversationally, after the
wizard. Circe treats MCP setup as a workflow the user has, not a
step in the installer. This keeps the wizard bounded (finite screens,
predictable duration) and puts the "what tools do I need" conversation
where it belongs — in a real conversation with the agent, not in a
form.

---

## 6. Adding, renaming, re-skinning, and removing agents after onboarding

Circe has a **fleet management** surface reachable from any tile (a
menu item, or a shortcut — Circe picks the affordance). It lets the
user:

- **Add a new agent** — opens Screen 5 (character walkthrough) in a
  focused window, followed by provider setup (Screen 6) if the new
  agent needs a different provider than the fleet's default. On save,
  a new tile spawns.
- **Rename an agent** — opens Screen 5 pre-populated with the current
  agent's identity. Saves changes to the profile's persona file, avatar,
  and palette. The tile re-themes immediately without needing to
  restart the agent.
- **Re-skin an agent** — the palette + avatar mini-editor from Screen
  4b. Same effect, narrower scope.
- **Remove an agent from the fleet** — closes the tile permanently
  and marks the profile "don't tile." The underlying profile still
  exists in Hermes and can be re-tiled later, or fully deleted through
  Hermes's own profile management.
- **Change which profile is the main operator** — a simple picker.
  The chosen profile becomes the one whose tile foregrounds on
  Circe launch and receives the orchestrator opening message on
  first appearance in the future (existing profiles that have already
  been onboarded don't re-run the opening).

Nothing in this surface is behind a modal wizard. It's all normal app
UI the user can dip into any time.

---

## 7. Design tone

Circe's visual and interaction language should feel:

- **Flat, not boxed.** No card-in-card, no nested rounded boxes, no
  divider borders inside a panel. Group with whitespace and single
  hairlines.
- **Translucent, atmospheric.** Tiles have blur-backdrop chrome and
  soft shadows for elevation. Not opaque application windows.
- **Personal.** Every tile looks distinctly like its own agent. The
  palette, the avatar, the character name make the tile feel like
  a person, not a form field.
- **Concise.** No decorative copy, no "Welcome to Circe! We're so
  excited to have you." Get to the primary action.
- **Native.** Feels like a proper Mac / Windows / Linux app, not a web
  page in a chrome. Follow OS conventions (⌘Q, Alt+F4, native window
  controls, standard menu bar).
- **Fast.** The wizard's happy path is under 90 seconds from launch to
  first tile. Tiles stream responses without lag. Nothing about the
  UI blocks on a spinner longer than it needs to.

Circe borrows the design vocabulary and primitives that Hermes's own
desktop app uses (a button component, a search field, segmented
controls, a loader, error and empty states, iconography). Circe does
not fork these — it uses them, so a Circe tile visually matches the
Hermes ecosystem while adding its own character-driven identity on top.

---

## 8. What Circe is not

- **Not a chatbot wrapper.** Circe doesn't talk to any LLM directly.
  Every conversation goes through a Hermes agent runtime, which owns
  the model calls, tool calling, memory, skills, and provider
  integrations.
- **Not a Hermes replacement.** Circe is a UI. If a user prefers the
  Hermes CLI or the single-agent Hermes desktop app, everything they
  do there works the same way with or without Circe installed. Circe
  and the CLI share configuration; a profile configured in one is
  visible in the other.
- **Not a team product.** Circe is single-user, local-only. No
  Circe-operated sync, no team fleets, no Circe accounts. Multiple
  people using Hermes together use whatever collaboration Hermes
  itself supports.
- **Not an MCP manager.** MCP servers are configured by the user's
  agents, conversationally, through the orchestrator handoff — or by
  the user directly through Hermes. Circe surfaces the state of each
  tile's MCPs in settings, but adding, removing, and reconfiguring
  MCPs is not part of the Circe wizard.
- **Not a marketplace.** No agent store, no character-cast store, no
  paid palettes, no plugins. Circe ships with a fixed set of cast
  suggestions, and users can always type in a custom name and pick
  their own colors.

---

## 9. Success criteria

Circe is working correctly when:

1. A new user with no Hermes installed can go from "I ran the Circe
   installer" to "I have one working, themed tile I've had a
   conversation with" in under three minutes on a good network.
2. A user with an existing Hermes install and one or more profiles
   sees those profiles in Screen 4b and can either accept them as-is
   (and reach a working fleet in under 60 seconds) or re-skin them
   (and reach a working fleet in a few minutes of walkthrough time).
3. Every tile in a running fleet shows its agent's live activity —
   streaming responses, tool-call indicators, permission cards — with
   no more than a few hundred milliseconds of lag relative to what the
   Hermes agent itself is doing.
4. Permission gate state changes are honored immediately: setting a
   tile to Locked mid-conversation causes the very next tool call to
   be auto-denied without waiting for a session boundary.
5. Circe survives a full quit and relaunch losing nothing — every
   tile's tab history, position, size, permission mode, and pending
   agent state come back exactly as they were.
6. A user who wants to add a ninth agent to their fleet six months
   after onboarding can do it in one flow without re-running any part
   of the wizard.
7. Circe never renames, deletes, or re-skins a profile the user did
   not explicitly ask it to modify in this session.
8. Every avatar in the running app is either user-uploaded or
   model-generated. There is no way to end up with a Circe fleet
   whose avatars came from a third-party image source Circe fetched.
