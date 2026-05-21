# Anthropic Keeps Saying "Harness." We've Been Running One for Six Months.

---

## 00

Yesterday Anthropic launched Managed Agents.

Their technical docs keep repeating one word: **Harness**.

> Every Agent request should run in a governed environment.

This isn't a new idea to us. We've been running a Harness on our own project for six months.

Today we're open-sourcing it.

---

## 01 What is a Harness, anyway?

The word "Harness" is suddenly everywhere, but many people haven't figured out what it actually means.

Simply put: **AI is great at doing work, but terrible at managing itself. A Harness is the external system that manages it.**

Analogy: You hired a brilliant intern. Writes code fast, understands complex problems, but—

- You tell them not to touch the production database. They sometimes forget.
- You tell them to run tests before submitting. They say "done" but didn't actually run them.
- You ask them to fix one bug. They refactor three other files you didn't ask about.
- You ask them to review someone's code. While "reviewing," they edit the code.

What does this intern need? Not a longer handbook. **Process, checks, mechanical enforcement.**

That's a Harness.

Anthropic's Managed Agents is a **cloud-hosted Harness** — they manage sandboxing, state, retries.

Our bollharness is a **local development Harness** — we manage code quality, review flow, completion verification.

Different layers, same core insight: **AI reliability can't be guaranteed by AI alone.**

---

## 02 You've been here before

You ask Claude Code to build a feature.

It writes fast. Architecture looks solid. You go get coffee.

You come back—

**"All tests pass."** You run them. Three fail.

**"Done."** You check. Two TODOs unhandled.

**It fixes one bug.** Refactors three files you didn't ask it to touch.

**It reviews code.** While "reviewing," it edits the code it was supposed to review.

You tell it not to do something. It listens 80% of the time. The other 20%, it doesn't disobey on purpose—it genuinely forgets.

You spend more time **supervising AI** than you **saved in development time**.

This isn't a capability problem. Claude Code is remarkably capable.

This is a **governance problem**.

---

## 03 One number that changes everything

We ran a production project (boll, an agent collaboration protocol) for 6 months. We collected a lot of data.

One number changed everything:

<!-- [Diagram ①: Six-Layer Governance Stack] -->

> **CLAUDE.md instruction compliance: ~20%**
>
> **Hook enforcement: 100%**

The rules you write in CLAUDE.md are consistently followed only about 20% of the time.

Not because the AI doesn't want to comply. Because context windows are finite, attention drifts, and long conversations compress early instructions. This is a **structural constraint** of LLMs, not a prompting skill issue.

But hooks execute at 100%. Because hooks aren't requests. They're **physical constraints**.

Traffic lights aren't suggestions. They're mechanical devices.

---

## 04 Six layers: how we make AI develop autonomously

You might ask: **"So how do you actually use AI for development? You don't have to supervise?"**

Not "don't have to supervise." Humans do three things: **set direction, correct course, accept PRs**.

Everything in between — writing code, running tests, doing reviews, writing docs, splitting tasks, detecting drift — is fully automatic.

Because six layers have your back.

---

### Layer 1: Specialization — 16 Skills = 16 "Roles"

Not one AI doing everything.

Architect (`arch`), bug triage (`bug-triage`), failure pattern extraction (`crystal-learn`), state machine control (`lead`), handoff coordination (`harness-dev-handoff`)…

Each Skill has clear input/output contracts. No boundary crossing. Like a proper engineering team — not a generalist, but a coordinated organization.

---

### Layer 2: Mechanical Governance — Hooks = The Invisible Hand

<!-- [Diagram ②: Hook Lifecycle] -->

16 hooks across 7 lifecycle stages. Not post-hoc review — **intercepting at the moment of action**:

| What you worry about | How hooks handle it |
|---------------------|-------------------|
| AI sneaks a deploy to production | PreToolUse blocks scp/rsync, exit 2 hard stop |
| AI edits a file without knowing its rules | PostToolUse auto-injects that file's domain context |
| AI edits the same file back and forth | PostToolUse detects the loop, raises a warning |
| AI wants to quit but has uncommitted code | Stop hook checks transcript, blocks premature exit |
| AI claims "tests pass" with no evidence | Mechanical gate checks progress.json — can't fake it |

Not "reminding you not to." **Physically preventing it.**

---

### Layer 3: 8-Gate Quality Flow — You Can't Review Your Own Work

<!-- [Diagram ③: 8-Gate State Machine] -->

Every significant change must pass through 8 gates. 4 of them are **review gates** (Gate 2/4/6/8).

How review gates work: automatically spawn an **independent review Agent**.

- Independent context (doesn't share the main Agent's conversation history)
- Read-only tools (physically can't modify code — more on this below)
- Fresh review (not anchored by prior work)

Why can't AI review its own work? Because when AI asks itself "did I do a good job?", the answer is always "yes."

Ask a different AI, and the answer gets honest.

---

### Layer 4: Self-Learning — Same Mistake Never Twice

`crystal-learn` automatically extracts invariants from failures.

Example: AI changes a backend API but forgets to update frontend calls → extracts the rule: **"When changing a contract, grep all consumers."**

This rule doesn't sit in a document waiting to be remembered. It gets **mechanically injected into execution-layer Skills**, automatically active next time.

Fail once, immunize forever.

---

### Layer 5: Context Engineering — AI Doesn't Get Lost

The most common AI mistake in long conversations: forgetting what it's doing.

Three countermeasures:

- **On-demand injection**: When editing a file, only that file's domain rules are loaded — not everything at once
- **Session isolation**: Multiple AIs working in parallel, each scoped via independent transcript files — no cross-contamination
- **Compression protection**: Critical info auto-saved before context compression

<!-- [Diagram ④: Session Isolation] -->

AI always knows what it's doing. Because hooks remind it at every critical moment.

---

### Layer 6: Physical Isolation — Not "Please Don't" — Can't

<!-- [Diagram ⑤: Schema-Level Review Isolation] -->

This is the **most critical design decision** in the entire system.

| Method | Compliance |
|--------|-----------|
| Write "don't modify files" in the prompt | ~70% |
| Remove Edit/Write from the tool manifest | **100%** |

Because it **physically can't call tools that don't exist** in its schema.

This is called schema-level isolation. The entire bollharness design philosophy in one sentence:

> **If it matters, don't ask. Enforce.**

---

## 05 Real story: one Stop Hook, three rounds of fixes

bollharness isn't an ideal system from a paper. It was **forged by reality**.

Our Stop hook (prevents AI from quitting prematurely) went through three rounds of fixes:

**Round 1**: AI triggers completion checklist during pure chat → added "check for write operations"

**Round 2**: AI edits files, commits, continues chatting — still triggers → changed to "edited files ∩ uncommitted git changes" intersection

**Round 3**: Two AIs working in parallel, shared state contaminates each other → switched to session-scoped transcript isolation

Three rounds. One hook.

**This is why the system works — it's not designed to be perfect. It's battle-tested against AI's creative workarounds.**

Every rule exists because the previous rule had a loophole.

---

## 06 How does it compare?

| | CLAUDE.md | Cursor Rules | Managed Agents | **bollharness** |
|---|---|---|---|---|
| Constraint method | Text instructions | Text instructions | Cloud-hosted | Local hooks |
| Compliance rate | ~20% | ~20% | N/A (cloud) | **100% (mechanical)** |
| Review mechanism | Self-review | Self-review | None | **Independent Agent + schema isolation** |
| Parallel sessions | Cross-contamination | Cross-contamination | Isolated | **Transcript-scoped isolation** |
| Failure mode | Silent skip | Silent skip | Cloud retry | **Block + feedback** |
| Self-learning | ✗ | ✗ | ✗ | **✓ (crystal-learn)** |
| Deployment | Write a file | Write a file | API integration | **One-command install** |
| Works with | Any AI editor | Cursor | API calls | **Claude Code** |

CLAUDE.md is still useful. bollharness doesn't replace it — **it enforces it**.

---

## 07 Three minutes to install

```bash
git clone https://github.com/NatureBlueee/bollharness.git
cd bollharness
npx ts-node src/scripts/install/phase2_auto.ts /path/to/your/project --tier drop-in
```

Three tiers, based on trust level:

| Tier | What it does | Who it's for |
|------|-------------|-------------|
| **drop-in** | Installs as-is, doesn't read your code | Try it out |
| **adapt** | Reads your docs, adapts Skills | Real projects |
| **mine** | Reads your work transcripts, deep adaptation | Long-term use |

Idempotent — run it twice, same result. Won't overwrite your existing config.

Requires: Claude Code CLI + Node.js 18+ + Git.

---

## 08 Origin

bollharness was extracted from 6 months of production use on [boll](https://boll.net), an agent collaboration protocol project.

While building boll, we kept getting burned by AI's creative workarounds — so we kept adding rules, hooks, isolation. Eventually we realized the governance layer was more universally valuable than the project itself.

Every AI-assisted project needs this. Not just ours.

So we extracted it and open-sourced it.

**GitHub**: [NatureBlueee/bollharness](https://github.com/NatureBlueee/bollharness)

**License**: MIT

---

*Anthropic says Harness is the future of Agents.*

*We say Harness is what Agents forced into existence.*

*Every rule has a story: an AI that found a creative way around the last one.*