# Integration Tests

Manual integration tests for sentinel-bridge that exercise real engines and orchestration features.

These tests are **not** part of CI. They must be run manually when actual engine backends are available.

## Prerequisites

### For tests that need real engines (Claude)

- **Claude CLI** must be installed and authenticated (`claude` command available on PATH).
- A valid Anthropic API key / active Claude subscription so the CLI can make requests.
- No special environment variables are required beyond what the Claude CLI itself needs.

### For tests that do NOT need real engines

The following tests work entirely in-process and have no external requirements:

- `test-circuit-breaker.ts`
- `test-context-blackboard.ts`

### Runtime

- Node.js 22+
- `npx tsx` (ships with the project dev dependencies or install globally: `npm i -g tsx`)

## How to run

### Run a single test

```bash
npx tsx tests/integration/test-context-blackboard.ts
npx tsx tests/integration/test-circuit-breaker.ts
npx tsx tests/integration/test-claude-session.ts
npx tsx tests/integration/test-workflow-pipeline.ts
npx tsx tests/integration/test-relay.ts
```

### Run all tests

```bash
npx tsx tests/integration/run-all.ts
```

## Expected results

Each test prints a clear `PASS` or `FAIL` line with details.

| Test | Needs real engine? | Expected outcome |
|------|-------------------|-----------------|
| `test-context-blackboard.ts` | No | PASS always |
| `test-circuit-breaker.ts` | No | PASS always |
| `test-claude-session.ts` | Yes (Claude CLI) | PASS if Claude CLI is installed and authenticated |
| `test-workflow-pipeline.ts` | Yes (Claude CLI) | PASS if Claude CLI is installed and authenticated |
| `test-relay.ts` | Yes (Claude CLI) | PASS if Claude CLI is installed and authenticated |

Tests that require a real engine will detect its absence and print `SKIP` with an explanation instead of failing.

## Notes

- Each test is self-contained and cleans up after itself (stops sessions, clears context).
- Tests that talk to real LLMs may take 10-60 seconds each depending on response times.
- Cost is minimal: each test sends 1-3 short prompts.
- The `run-all.ts` runner executes tests sequentially and prints a summary at the end.
