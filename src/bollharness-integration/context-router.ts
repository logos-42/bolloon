/**
 * Context Router - Port of Bollharness context-fragments to Bolloon
 *
 * Implements path-based automatic context injection.
 * When editing certain files, relevant context fragments are automatically injected.
 *
 * Loads fragments from src/bollharness/scripts/context-fragments/
 */

import * as fs from 'fs';
import * as path from 'path';

export const BOLLHARNESS_CONTEXT_DIR = path.join('src', 'bollharness', 'scripts', 'context-fragments');
export const FRAGMENTS_DIR = BOLLHARNESS_CONTEXT_DIR;

/**
 * Context Map - Maps file paths to relevant context fragments
 * Adapted from bollharness's context_router.ts
 */
export const CONTEXT_MAP: Record<string, string[]> = {
  'src/agents/': ['agent-architecture', 'multi-agent-patterns'],
  'src/documents/': ['document-processing', 'parser-patterns'],
  'src/network/': ['p2p-protocols', 'connection-patterns'],
  'src/constraints/': ['constraint-design', 'validation-patterns'],
  'src/social/': ['social-protocols', 'agent-discovery'],
  'src/test/': ['testing-patterns', 'quality-standards'],
  'src/workflows/': ['workflow-patterns', 'orchestration-patterns'],
  'src/bollharness-integration/': ['harness-integration', 'skill-adapter-patterns'],
  'docs/': ['documentation-standards'],
  'docs/decisions/': ['decision-tracking', 'adr-patterns'],
  'CLAUDE.md': ['project-governance', 'truth-source-hierarchy'],
  'README.md': ['project-intro', 'getting-started'],
};

/**
 * Default fragments to inject when no specific match
 */
export const FALLBACK_FRAGMENTS = ['general-dev-principles', 'code-quality'];

/**
 * Load a context fragment by name
 */
export function loadFragment(name: string): string {
  if (!name) return '';

  const candidate = path.join(FRAGMENTS_DIR, `${name}.md`);
  try {
    const resolved = path.resolve(candidate);
    const fragmentsDirResolved = path.resolve(FRAGMENTS_DIR);

    if (!resolved.startsWith(fragmentsDirResolved)) return '';

    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return fs.readFileSync(resolved, 'utf-8').trim();
    }
  } catch {}

  return '';
}

/**
 * Match file path to context fragments
 * Adapted from bollharness's match() function
 */
export function match(filePath: string): string[] {
  if (!filePath) return [];
  if (path.isAbsolute(filePath)) return [];

  const normalized = path.normalize(filePath).replace(/\\/g, '/');
  if (normalized.startsWith('../') || normalized === '..' || normalized.includes('/../')) {
    return [];
  }

  const matched: string[] = [];
  const sortedPatterns = Object.keys(CONTEXT_MAP).sort((a, b) => b.length - a.length);

  for (const pattern of sortedPatterns) {
    if (normalized.startsWith(pattern) || normalized.endsWith(pattern)) {
      matched.push(...CONTEXT_MAP[pattern]);
    }
  }

  return [...new Set(matched)];
}

/**
 * Get all fragments for a file
 */
export function getFragments(filePath: string): string[] {
  let fragments = match(filePath);
  if (!fragments.length) {
    fragments = Array.isArray(FALLBACK_FRAGMENTS) ? FALLBACK_FRAGMENTS : [FALLBACK_FRAGMENTS];
  }
  return fragments;
}

/**
 * Load all fragments for a file
 */
export function loadFragments(filePath: string): string[] {
  const fragmentNames = getFragments(filePath);
  const contentParts: string[] = [];

  for (const name of fragmentNames) {
    const text = loadFragment(name);
    if (text) contentParts.push(text);
  }

  return contentParts;
}

/**
 * ContextRouter class for integration with Bolloon
 */
export class ContextRouter {
  private fragmentsDir: string;
  private injectedFile: string;
  private injectedTTL = 3600; // 1 hour

  constructor(fragmentsDir?: string) {
    this.fragmentsDir = fragmentsDir || FRAGMENTS_DIR;
    this.injectedFile = path.join('.boll', 'guard', 'injected.json');
  }

  /**
   * Get fragments for a file path
   */
  match(filePath: string): string[] {
    return match(filePath);
  }

  /**
   * Load fragment content
   */
  loadFragment(name: string): string {
    return loadFragment.call({ FRAGMENTS_DIR: this.fragmentsDir }, name);
  }

  /**
   * Get all context for a file
   */
  getContext(filePath: string): string {
    const fragments = this.match(filePath);
    const contentParts: string[] = [];

    for (const name of fragments) {
      const text = loadFragment(name);
      if (text) contentParts.push(text);
    }

    return contentParts.join('\n\n---\n\n');
  }

  /**
   * Check if fragment was recently injected
   */
  wasRecentlyInjected(fragmentName: string): boolean {
    if (!fs.existsSync(this.injectedFile)) return false;
    try {
      const data = JSON.parse(fs.readFileSync(this.injectedFile, 'utf-8'));
      if (Date.now() / 1000 - data.timestamp > this.injectedTTL) return false;
      return (data.fragments || []).includes(fragmentName);
    } catch {
      return false;
    }
  }

  /**
   * Mark fragments as injected
   */
  markInjected(fragmentNames: string[]): void {
    const guardDir = path.dirname(this.injectedFile);
    if (!fs.existsSync(guardDir)) {
      fs.mkdirSync(guardDir, { recursive: true });
    }

    let existing: string[] = [];
    if (fs.existsSync(this.injectedFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.injectedFile, 'utf-8'));
        existing = data.fragments || [];
      } catch {}
    }

    const allFragments = [...new Set([...existing, ...fragmentNames])];
    const data = { timestamp: Date.now() / 1000, fragments: allFragments };
    fs.writeFileSync(this.injectedFile, JSON.stringify(data, null, 2), 'utf-8');
  }
}

/**
 * Context fragments content
 * These can be stored in context-fragments/ directory
 */
export const CONTEXT_FRAGMENTS = {
  'general-dev-principles': `# General Development Principles

## Core Values
- **Code over Convention**: Write code that works correctly, not just conventionally
- **Explicit over Implicit**: Make dependencies and side effects visible
- **Composition over Inheritance**: Prefer composing behavior to inheriting it
- **Fail Fast**: Detect errors early and fail loudly

## Code Quality
- Write self-documenting code with clear intent
- Keep functions small and focused (single responsibility)
- Avoid premature optimization
- Test at boundaries

## Collaboration
- Commit early and often
- Write meaningful commit messages
- Review code for clarity, not just correctness
- Leave code better than you found it`,

  'code-quality': `# Code Quality Guidelines

## Readability
- Use meaningful variable and function names
- Add comments that explain *why*, not *what*
- Keep lines under 100 characters
- Use consistent formatting

## Maintainability
- DRY (Don't Repeat Yourself)
- SOLID principles
- Keep modules loosely coupled
- Make side effects explicit

## Testing
- Test behavior, not implementation
- Cover edge cases
- Write tests before debugging
- Aim for meaningful assertions`,

  'agent-architecture': `# Agent Architecture Patterns

## Multi-Agent Design
- Define clear agent responsibilities
- Use message passing for inter-agent communication
- Maintain agent isolation
- Implement graceful degradation

## Skill System
- Skills should be composable
- Each skill has single responsibility
- Skills communicate via structured interfaces
- Version skills for compatibility`,

  'multi-agent-patterns': `# Multi-Agent Collaboration Patterns

## Task Delegation
- Match tasks to agent capabilities
- Track task state across agents
- Handle partial failures gracefully
- Aggregate results appropriately

## Communication
- Use structured message formats
- Implement acknowledgment protocols
- Handle timeouts and retries
- Log for debugging`,

  'documentation-standards': `# Documentation Standards

## When to Document
- Document *why*, not *what*
- Keep docs close to code
- Update docs with code changes
- Delete outdated documentation

## Types of Documentation
- README: Project overview and setup
- API docs: Usage examples
- Architecture docs: Design decisions
- Inline comments: Complex logic explanation`,

  'decision-tracking': `# Decision Tracking with ADRs

## ADR Format
- Title and status
- Context and problem statement
- Decision and rationale
- Consequences (positive and negative)

## When to Create ADR
- Architectural changes
- Technology choices
- Process changes
- Cross-cutting concerns`,

  'adr-patterns': `# Architecture Decision Records

## Structure
1. **Title**: Brief descriptive title
2. **Status**: Proposed, Accepted, Deprecated
3. **Context**: Background and constraints
4. **Decision**: What we decided
5. **Consequences**: What changed

## Review Process
- Propose with clear rationale
- Solicit feedback from stakeholders
- Document dissenting opinions
- Update status as decisions evolve`,

  'project-governance': `# Project Governance

## Truth Sources
- CLAUDE.md: Project overview and norms
- docs/: Architecture and decisions
- code/: Implementation
- issues/: Tracking and discussions

## Decision Making
- Small changes: Direct implementation
- Medium changes: Discuss first
- Large changes: ADR required`,

  'truth-source-hierarchy': `# Truth Source Hierarchy

## Priority Order
1. **Code**: Ground truth for behavior
2. **Tests**: Verification of behavior
3. **Docs**: Explanation of behavior
4. **Comments**: Intent and caveats
5. **Commits**: History and rationale

## Conflict Resolution
- Code vs docs: Code wins
- Comments vs code: Code wins
- Multiple docs: Newest wins
- Stale info: Delete or update`,

  'testing-patterns': `# Testing Patterns

## Test Structure
- Arrange: Set up test data
- Act: Execute the behavior
- Assert: Verify the outcomes

## Test Types
- Unit tests: Single function/class
- Integration tests: Component interaction
- E2E tests: Full system flow

## Best Practices
- Test one thing per test
- Use descriptive test names
- Keep tests independent
- Mock external dependencies`,

  'quality-standards': `# Quality Standards

## Code Review Checklist
- [ ] Does it work correctly?
- [ ] Is it readable?
- [ ] Are there tests?
- [ ] Is it documented?
- [ ] Are there security concerns?
- [ ] Performance implications?

## Definition of Done
- Code complete
- Tests passing
- Documentation updated
- No known issues`,

  'workflow-patterns': `# Workflow Patterns

## Pipeline Design
- Input validation
- Transformation steps
- Output generation
- Error handling

## State Management
- Track workflow progress
- Handle partial completion
- Support retry logic
- Log state changes`,

  'orchestration-patterns': `# Orchestration Patterns

## Task Coordination
- Define task dependencies
- Execute in correct order
- Handle parallel execution
- Aggregate results

## Error Recovery
- Identify failure points
- Implement retry strategies
- Rollback when needed
- Notify stakeholders`,

  'document-processing': `# Document Processing

## Supported Formats
- Markdown: Primary format
- PDF: Via external parser
- DOCX: Via external parser
- Plain text: Direct reading

## Processing Pipeline
- Load document
- Extract text
- Chunk content
- Process chunks
- Aggregate results`,

  'parser-patterns': `# Parser Patterns

## Design Principles
- Single responsibility per parser
- Consistent error handling
- Graceful degradation
- Clear error messages

## Content Extraction
- Strip formatting
- Preserve structure
- Handle encoding
- Validate content`,

  'p2p-protocols': `# P2P Protocols

## Connection Management
- Bootstrap connections
- Maintain peer list
- Handle disconnections
- Reconnect gracefully

## Message Routing
- Direct messages
- Broadcast messages
- Topic subscriptions
- Message queuing`,

  'connection-patterns': `# Connection Patterns

## Lifecycle
- Connect
- Authenticate
- Exchange
- Disconnect

## Reliability
- Heartbeat monitoring
- Timeout handling
- Retry mechanisms
- Graceful degradation`,

  'constraint-design': `# Constraint Design

## Principles
- Constraints should be explicit
- Fail with clear messages
- Allow override when needed
- Document rationale

## Implementation
- Pre-conditions
- Post-conditions
- Invariants
- Error handling`,

  'validation-patterns': `# Validation Patterns

## Input Validation
- Type checking
- Range validation
- Format validation
- Business rule validation

## Error Reporting
- Clear error messages
- Field-level errors
- Actionable suggestions
- Error codes`,

  'social-protocols': `# Social Protocols

## Agent Discovery
- Broadcast presence
- Maintain registry
- Handle joins/leaves
- Cache agent info

## Collaboration
- Task distribution
- Result aggregation
- Conflict resolution
- Consensus building`,

  'agent-discovery': `# Agent Discovery

## Registration
- Announce capabilities
- Update status
- Heartbeat mechanism
- Graceful cleanup

## Lookup
- Search by capability
- Filter by status
- Sort by relevance
- Cache results`,

  'project-intro': `# Project Introduction

## Overview
Bolloon is a P2P AI document processing system with multi-agent collaboration.

## Key Features
- Document processing pipeline
- P2P network communication
- Multi-agent task coordination
- Constraint-based guardrails`,

  'getting-started': `# Getting Started

## Setup
1. Install dependencies
2. Configure environment
3. Initialize P2P identity
4. Start processing

## Basic Usage
- Process documents
- Coordinate with peers
- Monitor performance`,
};
