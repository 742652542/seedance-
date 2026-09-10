# Image Project Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create and mount one long-lived Dramart `image` Canvas project at service startup, then execute all image-generation requests concurrently against that shared project without ratio-based project selection.

**Architecture:** Extract the authenticated Dramart image API operations into a focused `image-session.js` module owned by `task-server.js`. The module serializes only shared-session initialization through one promise; task uploads, submissions, and resource-specific polling remain independent asynchronous operations with no concurrency cap. Video generation keeps its current child-process workflow.

**Tech Stack:** Node.js 20 ESM, Express, Puppeteer Core, Node built-in test runner, mocked browser pages and `fetch`.

---

## File Structure

- Create `nodejs/image-session.js`: own the long-lived Canvas page, project creation, authenticated API calls, image upload/materialization, generation submission, polling, cleanup, and shared recovery state.
- Create `nodejs/image-session.test.js`: unit tests for one-time initialization, project-independent ratios, concurrent submissions, resource isolation, cleanup, and recovery.
- Modify `nodejs/task-server.js`: initialize the image session at startup, route image tasks to it in-process, retain the video child-process path, and preserve result persistence/API responses.
- Modify `package.json`: expose the Node test command.
- Modify `docs/task-api.md`: document the mounted `image` project and unconstrained concurrent image execution.

### Task 1: Shared Image Session Initialization

**Files:**
- Create: `nodejs/image-session.js`
- Create: `nodejs/image-session.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing initialization tests**

Test that concurrent `ensureReady()` calls share one project creation, that the project is named `image`, and that the dedicated page navigates to the created project's `/canvas` URL.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test nodejs/image-session.test.js`

Expected: FAIL because `image-session.js` does not exist.

- [ ] **Step 3: Implement the minimal session state and initialization**

Export `createImageSession(options)`. Keep `browser`, `page`, `project`, and `initializationPromise` private. Implement `ensureReady()` so all concurrent callers share one promise, create a new manual `9:16` project, rename it to `image`, confirm resources, navigate to `/canvas`, and retain the page.

- [ ] **Step 4: Run the focused tests**

Run: `node --test nodejs/image-session.test.js`

Expected: PASS for initialization tests.

- [ ] **Step 5: Commit when Git is available**

Run: `git add nodejs/image-session.js nodejs/image-session.test.js package.json && git commit -m "feat: add persistent image project session"`

Current workspace note: skip this step because the directory is not a Git repository.

### Task 2: Concurrent Image Execution

**Files:**
- Modify: `nodejs/image-session.js`
- Modify: `nodejs/image-session.test.js`

- [ ] **Step 1: Write failing task-execution tests**

Test that two requests with different ratios use the same project, submit before either polling loop completes, send their own ratios, and poll only their own generated resource IDs.

- [ ] **Step 2: Run the tests and verify failure**

Run: `node --test nodejs/image-session.test.js`

Expected: FAIL because `runTask()` is not implemented.

- [ ] **Step 3: Implement task-scoped image processing**

Implement `runTask(taskId, request)` using task-specific temporary directories. Materialize URL, Data URL, Base64, and local-file images; upload and register references; create one generated resource; submit generation immediately; then poll by exact `resourceId`. Keep ratio only in generation payload fields.

- [ ] **Step 4: Implement independent cleanup**

Remove only the current task's temporary directory in `finally`. Log cleanup errors without replacing a successful result.

- [ ] **Step 5: Run focused tests**

Run: `node --test nodejs/image-session.test.js`

Expected: PASS, including proof that no serial queue exists.

- [ ] **Step 6: Commit when Git is available**

Run: `git add nodejs/image-session.js nodejs/image-session.test.js && git commit -m "feat: run image tasks concurrently"`

Current workspace note: skip this step because the directory is not a Git repository.

### Task 3: Session Failure Isolation And Recovery

**Files:**
- Modify: `nodejs/image-session.js`
- Modify: `nodejs/image-session.test.js`

- [ ] **Step 1: Write failing recovery tests**

Test that an ordinary generation failure does not close the shared page, a closed page causes one shared re attempt, and browser disconnection clears session state without creating duplicate projects for concurrent recovery callers.

- [ ] **Step 2: Run the tests and verify failure**

Run: `node --test nodejs/image-session.test.js`

Expected: FAIL on recovery behavior.

- [ ] **Step 3: Implement invalidation and shared recovery**

Invalidate only on browser/page/authentication-context failures. Clear the old page-close listener before intentional replacement, clear the session state, and make the next `ensureReady()` create a fresh `image` project through one shared promise. Never retry ambiguous generation submissions.

- [ ] **Step 4: Run focused tests**

Run: `node --test nodejs/image-session.test.js`

Expected: PASS.

- [ ] **Step 5: Commit when Git is available**

Run: `git add nodejs/image-session.js nodejs/image-session.test.js && git commit -m "fix: recover persistent image sessions safely"`

Current workspace note: skip this step because the directory is not a Git repository.

### Task 4: Integrate With Task Server

**Files:**
- Modify: `nodejs/task-server.js:39-42,141-155,446-519,524-579,636-641`
- Modify: `nodejs/image-session.test.js`

- [ ] **Step 1: Add failing integration-boundary tests**

Test the exported task-runner decision: image actions call the in-process session while video actions still spawn `prepare-video-workflow.js`. Verify image result objects remain compatible with `normalizeCompletedResult()`.

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test nodejs/image-session.test.js`

Expected: FAIL because the server is not wired to the session.

- [ ] **Step 3: Route image tasks to the shared session**

Instantiate the session with browser resolution and logging dependencies. Split `runDramartTask()` so image actions call `imageSession.runTask()` and video actions retain the current child process. Convert the image result into the existing `generationResult` shape before persistence.

- [ ] **Step 4: Start initialization with the server**

Replace the startup-only project-list standby behavior for image readiness with `imageSession.ensureReady()`. Keep failures logged and retryable by later requests.

- [ ] **Step 5: Preserve immediate and synchronous response modes**

Keep the existing running record, immediate `processing` response, `wait_for_completion`, `/api/result`, and `/api/files` behavior unchanged.

- [ ] **Step 6: Run syntax and unit tests**

Run: `node --check nodejs/task-server.js`

Run: `node --check nodejs/image-session.js`

Run: `node --test nodejs/image-session.test.js`

Expected: all commands pass.

- [ ] **Step 7: Commit when Git is available**

Run: `git add nodejs/task-server.js nodejs/image-session.js nodejs/image-session.test.js && git commit -m "feat: use shared image session in task server"`

Current workspace note: skip this step because the directory is not a Git repository.

### Task 5: Documentation And Regression Verification

**Files:**
- Modify: `docs/task-api.md:193-214,634-645`
- Modify: `package.json`

- [ ] **Step 1: Document runtime behavior**

State that startup creates a fresh project named `image`, keeps its Canvas page mounted, ignores ratio for project selection, and starts all image jobs concurrently without a local cap.

- [ ] **Step 2: Add the package test script**

Set `test` to `node --test nodejs/*.test.js` while preserving existing start scripts.

- [ ] **Step 3: Run complete local verification**

Run: `npm test`

Run: `node --check nodejs/task-server.js`

Run: `node --check nodejs/image-session.js`

Expected: all tests and syntax checks pass.

- [ ] **Step 4: Perform manual browser integration when the profile service is available**

Run: `npm run start:node-task`

Expected: the browser opens a newly created `image` project at `/canvas`; simultaneous image requests receive distinct local task IDs and are submitted without waiting for previous generation completion.

- [ ] **Step 5: Commit when Git is available**

Run: `git add package.json docs/task-api.md && git commit -m "docs: describe concurrent image project workflow"`

Current workspace note: skip this step because the directory is not a Git repository.
