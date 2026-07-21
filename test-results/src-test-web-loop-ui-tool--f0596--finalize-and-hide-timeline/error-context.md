# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: src/test/web-loop-ui.spec.ts >> tool-call loop SSE events render, finalize, and hide timeline
- Location: src/test/web-loop-ui.spec.ts:168:1

# Error details

```
Error: write EPIPE
```

```
Error: page.goto: Target page, context or browser has been closed
Call log:
  - navigating to "http://127.0.0.1:60792/", waiting until "load"

```

```
Error: browserContext.close: Target page, context or browser has been closed
```