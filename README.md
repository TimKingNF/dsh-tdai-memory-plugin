# 🧠 dsh-tdai-memory-plugin

**English** · [中文](README_CN.md)

A [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) plugin for
DeepSeek Harness: **context recall and injection** inside a DSH session (read path), plus
**side-channel write-back of every turn** into MemoryCore (write path).

Relationship to [DSH-TDAI-Memory-Adapter](https://github.com/Vocllum/DSH-TDAI-Memory-Adapter):
this project keeps that adapter's skeleton (auto recall + turn capture + read-only tools) and ports
MemoryProxy's core memory capabilities — L2/L3 injection, self + borrowed L1 recall, Skill/Knowledge
injection, `session_context` — **natively into the DSH process**. No MemoryProxy forwarding layer is
involved and credentials never leave the process.

> **Version 0.4.0** · read the [CHANGELOG](CHANGELOG.md) · docs: [prompt-injection design notes (中文)](docs/prompt-design.zh-CN.md) ·
> [construction blueprint (中文)](docs/prompt-injection-redesign.md)

## ⚠️ Compatibility and tested scope

**This version has only been tested against the combination below. Any other pairing is unverified.**

| Component | Tested version | Notes |
| --- | --- | --- |
| DeepSeek Harness (DSH) | **`0.1.2-rc.1`** | the version installed at release time |
| [TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) | **`v2.0.1`** | MemoryCore / MemoryKnowledge HTTP API |

Why the pinning matters:

- The read path binds to DSH-internal contracts: `systemPrompt.section()` / `systemPrompt.context()`,
  the `system-prompt/assemble` waterfall, the `agent/pre-step` waterfall, `skills.register()`,
  `tools.register()` (including the `render(args, value)` output projection) and `settings.register()`.
  A DSH refactor of any of these changes plugin behaviour.
- The section **order band** (500–599) is asserted against a **local copy** of DSH's `SECTION_ORDERS`
  table (`test/section-registry.test.mjs`). If a DSH upgrade moves that table, the test will *not*
  fail by itself — the copy must be re-synced by hand, otherwise the plugin can silently end up
  occupying a reserved slot.
- Recall / write-back call MemoryCore's `/v3/*` HTTP API (`/v3/core/read`, `/v3/scenario/ls`,
  `/v3/skill/listing`, `/v3/knowledge/list`, `/v3/atomic/search`, `/v3/meta/*`,
  `/v3/conversation/add`, `/v3/skill/conversation/add`) and the knowledge service
  (`{service_url}/tools/list`, `{service_url}/tools/call`). A Core version bump can change those
  schemas.

## Features

### Read path (`enabled` master switch)

Everything is injected through **native DSH interfaces**; the request body is never rewritten
(see [docs/prompt-injection-redesign.md](docs/prompt-injection-redesign.md)).

| Block | Channel | DSH interface | order | Content |
| --- | --- | --- | --- | --- |
| `tdai:session-context` | system section | `systemPrompt.section` | 520 | agent / task identity (**no persona text** — the preset injects that) |
| `tdai:profile-memory` | system section | same | 521 | plugin overview + L3 profile + L2 scene index + tool guide |
| `tdai:available-skills` | system section | same | 522 | cloud skill **supplementary** catalog (DSH publishes its own natively) |
| `tdai:knowledge-tools` | system section | same | 523 | one-line routing for team knowledge resources (off by default) |
| `tdai-team-knowledge` | DSH runtime skill | `skills.register` | — | full criteria + resource list + tool inventory, **loaded on demand** |
| `tdai:state` | runtime context | `systemPrompt.context` | 560 | runtime status snapshot, delivered as a **user-role message**, never in system |
| `<tdai_recalled_l1_memories>` | pre-step | `agent/pre-step` | — | L1 recall: a **separate** plugin message (`form: 'notice'`) right after this turn's human message; the human message is not modified by a single byte |

Data sources: `/v3/core/read` (L3), `/v3/scenario/ls` (L2), `/v3/skill/listing` (skills),
`/v3/knowledge/list` (knowledge), `/v3/atomic/search` (L1 recall), `/v3/meta/*` (agent/task detail).

Delegated **child** sessions skip all of this by default — see
[Subagent sessions](#subagent-sessions-default-read-side-off-write-side-off).

**Why L1 recall is not written into the user message.** The host persists `decision.messages`
verbatim after `agent/pre-step` (`session.append("user/message", …)` in `dsh-agent-loop`). Prepending
the recall block would leave that text permanently inside the *user's* message: the UI would echo it
as user input, write-back would have to trim it by text sentinels, and any `source.kind === 'user'`
check would misclassify it. A separate message fixes all three at once — clean body,
`source.kind === 'plugin'` makes write-back drop it wholesale, and it renders as a collapsible
"context injection" row instead of a user bubble.

**Why the section orders are consecutive.** DSH sorts by `order` first and only compares `name` on
ties. Consecutive numbers (520–523) mean other plugins can only insert *before or after* the whole
block, never in the middle of our content.

**Why some blocks are sections and others use context/pre-step.** The criterion is *"do the bytes
change within one session?"* Anything that changes (L1 recall) must never enter `system`: system is a
prefix, and one change invalidates the whole upstream prefix cache. See §5.3 of the design doc.

### Why team knowledge is a skill

The wiki/code-graph "criteria + resource list + curl recipe" used to sit in system prompt as a 4.4KB
block, **paid for on every single turn**, while most turns never needed it. It is now split in two:

| Part | Where | When it enters context | Size |
| --- | --- | --- | --- |
| Which resources exist, when to use them | `tdai:knowledge-tools` (system section) | every turn | ~300 B |
| Full criteria + resource list + available tools | `tdai-team-knowledge` (DSH runtime skill) | **when the model loads it** | ~3.6 KB |
| How to actually call | `tdai_knowledge_tools` / `tdai_knowledge_call` (native tool schema) | in the tool catalog | — |

Measured: the four injected system sections went from **9953 → 5768 bytes (-42%)**. Note the full
resident bill: tool schemas grew from 2774 → 6446 bytes in the same release (two new knowledge tools
plus richer memory-tool descriptions), so total resident bytes went 12727 → 12214 (-4%). The real win
is structural — 4.4 KB paid on every turn became 307 B of routing plus a 3.6 KB skill body loaded on
demand. See [docs/prompt-design.zh-CN.md](docs/prompt-design.zh-CN.md) §0 for the full accounting.

The skill is registered only when `knowledgeEnabled=true` *and* the current agent actually has
knowledge resources bound.

Because the plugin prefetches each resource's `tools/list` at session start and writes it into the
skill body, the model has the tool names and parameters the moment it loads the skill — one
discovery round-trip saved.

### Read-only tools ×10

- Semantic search: `tdai_memory_search` (L1 atomic memories), `tdai_conversation_search` (raw L0
  conversation), `tdai_skill_search` (team Skill library)
- Structured queries: `tdai_memory_query` (L1 by type/time/pagination), `tdai_conversation_query`
  (L0 by session/time/pagination)
- Resource reads: `tdai_read_scene` (full L2 scene), `tdai_scenario_ls` (L2 path list),
  `tdai_skill_view` (full Skill + manifest)
- Team knowledge: `tdai_knowledge_tools` (list the tools a resource offers),
  `tdai_knowledge_call` (run a read-only query — e.g. code-graph `explore` / `search` / `callers` /
  `impact`, wiki `search` / `read_page`)

`tdai_knowledge_call` accepts **only resource ids bound to the current session**. If the model invents
an id, the tool refuses it instead of sending it to the server.

### Slash commands ×4

| Command | Purpose |
| --- | --- |
| `/tdai-sync` | refresh this session's memory asset cache (session_context / L2L3 / Skill / Knowledge) |
| `/tdai-status` | show plugin status (identity, switches, loaded assets, knowledge tool prefetch) |
| `/tdai-archive` | archive the current session now and trigger background Skill extraction (`mem:create-skill` in proxy terms) |
| `/tdai-help` | quick reference for commands and tools |

### Write path (`captureEnabled`, an independent switch)

- At the end of every real turn: `/v3/conversation/add` (L0 short-term memory) +
  `/v3/skill/conversation/add` (Skill archiving trigger)
- Aligned with proxy: messages over 8192 code units are split (surrogate-safe), 100 per batch,
  serialized per session
- Injected recall blocks are filtered out so they never pollute memory
- L1/L2/L3 extraction is done asynchronously by MemoryCore; the plugin does not do it

**Two projections** (both endpoints have different schemas, so each turn is projected twice —
`lib/normalize.mjs`):

| Endpoint | roles | how tools are represented |
| --- | --- | --- |
| `/v3/skill/conversation/add` | user / assistant / `tool_call` / `tool_result` / system | separate messages + `tool_call_id` pairing anchor |
| `/v3/conversation/add` (L0) | user / assistant only | folded into `[tool_call] name(args)` / `[tool_result:name] …` |

- **Internal reasoning and images are always dropped**, matching
  `MemoryProxy/src/skill/normalize-conversation.ts`. In DSH, reasoning and visible reply live in the
  same assistant content array; earlier they were written into L0 together (a measured turn wrote 32
  records of which 31 were raw thinking). L0 is the only input for L1/L2/L3 extraction, so thinking
  noise would poison long-term memory.
- **Failed turns are not written back**: the host only dispatches `agent/turn-stopping` on the success
  path, so turns that errored / were aborted / were rejected in pre-step never reach it. The plugin
  catches those on `agent/error` and `turn/end`: log + drop the buffer, **without writing memory** —
  half a turn would be consumed by extraction as if it were complete.

### Subagent sessions (default: read side off, write side off)

DSH's delegated child sessions (the `subagent` and `subagent_fork` tools) inherit the plugin's
globally registered sections and are seen by the same process-level listeners. On the default setup
that meant, measured:

- a child's system prompt was **byte-identical to its parent's** (13020 bytes — our four blocks are
  6093 of them, 47%), and it received its own L1 recall block (2 messages, ≈4.4 KB);
- because `captureEnabled` is process-wide, a 23-step research child wrote **37 messages** into L0
  (task prompt, a full diff, raw test output, every tool call) — background extraction would treat
  that tool noise as memory about the user.

The plugin now steps back for child sessions by default:

| Switch | Default | Effect inside a child session |
| --- | --- | --- |
| `subagentInjectionEnabled` | **off** | no system injection, no L1 recall, no knowledge skill, no asset prewarm; the 10 read-only tools stay registered |
| `subagentCaptureEnabled` | **off** | the child's conversation is not written back to MemoryCore |

Detection uses DSH's durable `session.header.origin === 'subagent'` (`delegationDepth > 0` as a
fallback), so both spawn and fork children are covered; a session without a header is treated as a
top-level session (fail-open to the previous behaviour). `/tdai-status` reports both switches and
whether the current session is a child session.

**Cache note (measured, not estimated)**: comparing one real child session before and after this
change — system prompt 13020 → **6925 bytes**, total tokens per first request 13748 → **10594**
(-23%), of which **full-price tokens 2214 → 797**; cache hits 11264 → 9728. So turning injection off
for children does **not** make them pay a cache penalty: the big cache hit comes from the tools array
at the front of the request (38 schemas, unchanged position), and the 6093 bytes we removed are not
charged at all. Only DSH's own tail section loses its parent-cache hit (≈500–800 tokens, because it
shifts position). If you customise child agents with DSH's native `dsh-tool-subagent` `persona` or
`toolFilter`, the prefix diverges at the very front anyway.
Full accounting: [docs/prompt-design.zh-CN.md](docs/prompt-design.zh-CN.md) §3.4.

### Common

- **fail-open**: any Gateway failure is logged only, never blocks DSH
- **session-level asset cache**: prewarmed at session start with lazy fallback in pre-step; sections
  read the cache synchronously so the first turn is already injected
- **static identity** (single-user assumption); no multi-user support, no auth/verify

## Install

```bash
cd dsh-tdai-memory-plugin
npm install            # pulls schemastery (settings schema dependency)
npm run build:client   # builds the Web settings card bundle (client.js)

dsh plugin --profile web add ./dsh-tdai-memory-plugin
# restart the target profile to take effect
```

## Configuration

### Option 1: Web settings panel (recommended)

"Settings → Plugins → TDAI Memory" card, switchable live:

- **Read side**: read master switch, L1 auto recall (with a **per-turn recall cap**), system prompt
  injection, and the 4 sections under it
- **Write side**: conversation write-back (independent of the read side)
- **Subagents**: whether child sessions inherit the read side, and whether their conversations are
  written back (both off by default)
- **Identity & addresses**: MemoryCore endpoint, instance id, Team / Agent / User / Task id,
  User Key, knowledge-service origin override

Switch dependencies (the card groups them and greys out anything that is currently inert):

```
read master enabled ──┬─ L1 auto recall recallEnabled (cap recallLimit, 1–20)
                      ├─ System prompt injection injectionEnabled
                      │    ├─ session context  sessionContextEnabled
                      │    ├─ long-term memory profileMemoryEnabled
                      │    ├─ skill list      skillsEnabled
                      │    └─ knowledge base  knowledgeEnabled
                      └─ read-only tools (no separate switch)

write master captureEnabled —— independent of both enabled and injectionEnabled

subagents (keyed on the child session, not on the switches above)
  subagentInjectionEnabled —— read side inherited by child sessions?   (default: no)
  subagentCaptureEnabled   —— child conversations written back?        (default: no)
```

Three easy traps:

1. **`injectionEnabled` only governs the 4 system sections**; turning it off does **not** disable
   L1 recall.
2. **Write-back does not depend on the read side**: with everything on the read side off, turns are
   still written back to MemoryCore (capture-only).
3. **Incomplete identity is the number one cause of a dead read side** (`readEnabled = enabled && identity complete`);
   the card names the missing fields right below the read-side group.

Switches apply immediately; identity changes apply to **new sessions** (an existing session keeps its
injection cache). An empty text field falls back to env; leaving the recall cap empty falls back to
env/default 5, and values outside 1–20 are clamped with a note in the save result.

### Option 2: env

```bash
# ── required identity ──
export TDAI_MEMORY_INSTANCE_ID=default      # memory instance id (x-tdai-service-id / space_id)
export TDAI_MEMORY_TEAM_ID=team-xxx
export TDAI_MEMORY_AGENT_ID=agt-xxx
export TDAI_MEMORY_USER_ID=usr-xxx
export TDAI_MEMORY_API_KEY=...              # serviceToken (Bearer; env only, never in the panel)

# ── recommended ──
export TDAI_MEMORY_USER_KEY=sk-mem-xxx      # meta surface (agent/task detail, borrowed assets); without it those degrade
export TDAI_MEMORY_TASK_ID=task-xxx         # optional: session_context [Task] block + write-back attribution

# ── switches ──
export TDAI_MEMORY_ENABLED=true             # read master: recall + injection + tools
export TDAI_MEMORY_CAPTURE_ENABLED=true     # write-back (write side), independent of every read switch
export TDAI_MEMORY_RECALL_ENABLED=true      # L1 auto recall
export TDAI_MEMORY_INJECTION_ENABLED=true   # system prompt injection master (only the 4 sections below)
export TDAI_MEMORY_SESSION_CONTEXT_ENABLED=true
export TDAI_MEMORY_PROFILE_MEMORY_ENABLED=true
export TDAI_MEMORY_SKILLS_ENABLED=true
export TDAI_MEMORY_KNOWLEDGE_ENABLED=false  # team knowledge injection, off by default

# ── subagent (child) sessions ──
export TDAI_MEMORY_SUBAGENT_INJECTION_ENABLED=false  # let child sessions inherit the read side (default: no)
export TDAI_MEMORY_SUBAGENT_CAPTURE_ENABLED=false    # write child conversations back (default: no)

# ── tuning ──
export TDAI_MEMORY_ENDPOINT=http://127.0.0.1:8420
export TDAI_MEMORY_RECALL_LIMIT=5           # merged top-K for L1 (1–20; also in the panel)
export TDAI_MEMORY_L2_LIMIT=3               # number of L2 scene index entries
export TDAI_MEMORY_TIMEOUT_MS=5000          # per-HTTP-request timeout
export TDAI_MEMORY_KNOWLEDGE_ENDPOINT=http://127.0.0.1:8424  # rewrite the origin of knowledge service_url

# ── main-loop protection (do not raise these to "the message hangs" levels) ──
export TDAI_MEMORY_RECALL_TIMEOUT_MS=3000   # hard timeout for L1 retrieval: on timeout, skip recall for this turn
export TDAI_MEMORY_ASSET_LOAD_BUDGET_MS=5000    # total budget for the whole asset bundle (meta+L3/L2+skill+knowledge)
export TDAI_MEMORY_ASSET_RETRY_COOLDOWN_MS=15000 # cooldown after a failed load: no retry within it (0 = retry every step)
```

Priority: **Web settings > env > built-in defaults**. With incomplete identity the read side disables
itself and warns, while the write side is unaffected. `TDAI_MEMORY_API_KEY` is read from env only and
is never written into the settings panel.

**About the three "main-loop protection" knobs**: every read-side call to MemoryCore happens *before*
the model request (`system-prompt/assemble` injects assets, `agent/pre-step` recalls). If the gateway
is slow or down and we waited indefinitely — or retried the whole bundle at every step after a failure
— the user experience is "with recall on, sending a message blocks forever". Hence: asset loading has
a **total budget** (over budget it degrades, answering proceeds even without L2/L3/Skill), failures
have a **cooldown** (no per-step retry), and retrieval has a **hard timeout** (skipping one recall is
better than stalling the turn).

**About `TDAI_MEMORY_KNOWLEDGE_ENDPOINT`**: `/v3/knowledge/list` returns the address *the server*
can reach — in containerized deployments that is often `http://host.docker.internal:8424/v3`, which
the plugin process on the host cannot reach (symptom: `fetch failed`, empty `tools/list`, skill body
saying "tools not fetched"). Setting this replaces scheme/host/port while **keeping the path intact**;
an invalid URL falls back to the original address.

## Differences from MemoryProxy (intentional)

- **No proxy layer**: no LLM traffic forwarding, no rate limiting/billing/storage abstraction — those
  are proxy infrastructure, not a plugin's job
- **No auth/verify**: the data surface takes an explicit identity, the meta surface uses
  `x-tdai-user-key`; with static identities verify is unnecessary
- **No ACL filtering**: borrowed assets come from the agent's own bindings; the single-user scenario
  does not do acl/check (proxy's fail-closed design targets multi-user gateways)
- **Native tool registration**: replaces the skill-bridge/memory-bridge curl approach, so the
  serviceToken never enters the prompt
- **No session-init form**: the team/agent/task selection flow is skipped under a static identity

## Identity semantics (important)

**One dsh process corresponds to exactly one TDAI identity.** It comes from `TDAI_MEMORY_*` env vars
or the Web settings panel (panel wins) and is resolved once when the plugin loads; `session_id` is
taken from the current session on every call.

This is deliberate: proxy's "choose Team/Agent/Task per session" form is a capability it needs *because*
it is a multi-user gateway. This plugin is a single-user component inside a DSH process, so a static
identity is the more natural shape. Need multiple identities? Use multiple processes or change config.

`/tdai-status` shows the currently effective identity, where it came from (env / settings), and which
fields are missing.

## Development

```bash
npm install
npm run build:client   # rebuild client.js after editing client.card.tsx
npm test               # syntax checks + pure-function and wiring tests (no network needed)
npm run check:secrets  # scan tracked files for credential-looking strings (also the last step of npm test)
```

Credentials never belong in this repo — every key is read from the environment at runtime
(`TDAI_MEMORY_API_KEY` is env-only and never enters the settings panel). `npm test` ends with the
secret scan, so a pasted token fails the suite; a genuine false positive is suppressed by adding the
literal to `scripts/secret-scan-allowlist.txt` **with a reason**.

The test suite is the release gate. Two of its guards are worth knowing before you change prompt
content:

- `test/prompt-budget.test.mjs` — hard byte ceilings per injected block plus a soft baseline
  (`node test/prompt-budget.test.mjs --save` to re-record after an intentional change).
- `test/section-registry.test.mjs` — asserts the plugin's order band does not collide with DSH's
  reserved orders (kept as a local copy of DSH's table — re-sync it after a DSH upgrade).

## Docs

| Document | Language | Content |
| --- | --- | --- |
| [CHANGELOG.md](CHANGELOG.md) | 中文 | release history; 0.4.0 lists every fix with its root cause and covering test |
| [docs/prompt-design.zh-CN.md](docs/prompt-design.zh-CN.md) | 中文 | the prompt-injection optimisation rationale, prompt-cache risks (including "installing other plugins invalidates the prefix cache") and known open issues |
| [docs/prompt-injection-redesign.md](docs/prompt-injection-redesign.md) | 中文 | the construction blueprint: every decision, every citation into DSH / plugin / proxy source |

## License

MIT
