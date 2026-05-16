# ConstraintRuntime Design

## Overview

A TypeScript implementation that replicates and extends the py-bolloon architecture for AI constraint management, deep thinking, and multi-agent coordination.

## Architecture

```
constraint-runtime/
├── src/
│   ├── index.ts                    # Main entry
│   ├── constraint/                 # Permission & resource constraints
│   │   ├── index.ts
│   │   ├── permission.ts           # Tool allowlist/denylist
│   │   └── budget.ts               # Token/turn budget tracking
│   ├── thinking/                   # Deep thinking engine
│   │   ├── index.ts
│   │   ├── engine.ts               # Multi-step reasoning
│   │   └── reflection.ts           # Self-reflection loops
│   ├── agent/                      # Multi-agent coordination
│   │   ├── index.ts
│   │   ├── coordinator.ts          # Task distribution
│   │   ├── agent-pool.ts           # Agent lifecycle
│   │   └── result-aggregator.ts    # Result merging
│   ├── skills/                     # Skill registry
│   │   ├── index.ts
│   │   └── skill-registry.ts
│   ├── runtime/                    # Core runtime
│   │   ├── index.ts
│   │   ├── session.ts              # Session management
│   │   └── turn-engine.ts         # Turn loop execution
│   └── reference_data/            # Mirrored snapshots
│       └── subsystems/
└── package.json
```

## Core Components

### 1. ConstraintLayer

- **ToolPermissionContext**: allowlist/denylist for tools
- **BudgetTracker**: token budget, max turns, compact_after_turns
- **PermissionDenial**: reason when tool access denied

### 2. DeepThinkingEngine

- Configurable `maxDepth` (1-10 steps)
- Chain-of-thought reasoning with reflection
- `think(prompt) → ThinkResult` with intermediate steps

### 3. AgentCoordinator

- **TaskSplitter**: breaks prompt into parallel subtasks
- **AgentPool**: manages agent lifecycle
- **ResultAggregator**: merges parallel results
- Parallel dispatch pattern

### 4. SkillRegistry

- Loads skills from `skills/` directory
- Skill = { name, description, execute(params) }
- Compatible with py-bolloon skill snapshot format

### 5. Runtime

- **Session**: maintains context, history, state
- **TurnEngine**: executes turns with constraint checking
- Mirrors py-bolloon `PortRuntime` pattern

## Data Flow

```
User Prompt
    ↓
[ConstraintLayer] ← permission check
    ↓
[DeepThinkingEngine] ← multi-step reasoning (optional)
    ↓
[AgentCoordinator] ← task split
    ↓
[AgentPool] ← parallel execution
    ↓
[ResultAggregator]
    ↓
[SkillRegistry] ← skill enrichment
    ↓
Response + Updated Session
```

## CLI Commands (mirrors py-bolloon)

- `summary` - render markdown summary
- `manifest` - print module manifest
- `tool-pool` - show tool constraints
- `bootstrap` - build session
- `turn-loop` - run turn loop
- `think` - run deep thinking mode
- `dispatch` - parallel agent dispatch

## Implementation Notes

- Follow py-bolloon module mirroring pattern
- Use `PortingModule` model for tools/commands
- Preserve `QueryEnginePort` patterns
- TypeScript-first with strict mode
