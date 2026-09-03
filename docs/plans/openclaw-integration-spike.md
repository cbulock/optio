# Optio Replacement Spike

Goal: determine whether Optio should fully replace the current code-task orchestration stack.

## Decision

Target outcome: OpenClaw remains the Discord/front-door control plane while Optio becomes the execution backend for code-task orchestration.

This spike should answer one question clearly:

- should we replace the current orchestrator with Optio?

Allowed outcomes:

- adopt
- adopt with explicit gap list
- borrow ideas only
- reject

## Scope

In scope:

- Optio as the lifecycle owner for code tasks
- OpenClaw to Optio intake handoff
- progress and terminal result reporting back to Discord/OpenClaw
- mapping current planner/implementer/reviewer/verifier/finalizer behavior onto Optio
- replacement cost, risks, and cutover shape

Out of scope:

- broad new feature work on the current orchestrator beyond critical fixes
- partial hybrid production cutover without a clear seam
- replacing the OpenClaw front door itself

## Deliverables

- running Optio environment
- one connected repo
- one mapped workflow for the current code-task lane
- one end-to-end low-risk task to branch/PR
- one forced failure/recovery demonstration
- written adopt/borrow/stay recommendation

## Checklist

### 1. Bootstrap Optio

Owner: platform

Tasks:

- deploy Optio in a local or disposable dev environment
- verify API, web UI, queue workers, Postgres, and Redis are healthy
- capture the exact bootstrap path used

Evidence:

- API URL or health output
- web URL
- worker/queue health output

Pass:

- all core services are healthy after clean bootstrap

Fail:

- Optio cannot reach a stable runnable state without manual surgery

Status: done

### 2. Connect One Repo

Owner: platform

Tasks:

- register one low-risk GitHub repo
- verify clone, branch/worktree creation, and push permissions
- verify the repo runtime environment is usable by an agent

Evidence:

- repo registration record
- branch/worktree proof
- successful push proof

Pass:

- Optio can clone the repo, create isolated work, and push a branch

Fail:

- repo auth, git isolation, or agent runtime is broken

Status: in progress

### 3. Map Current Workflow

Owner: orchestration

Tasks:

- map planner
- map implementer
- map reviewer
- map verifier
- map finalizer
- decide which steps stay distinct vs collapse into Optio-native loops

Evidence:

- stage mapping table or bullet list
- list of behavior gaps

Pass:

- the current workflow can be represented without major engine forks

Fail:

- Optio cannot model the required workflow or reporting semantics cleanly

Status: pending

### 4. Port Minimum Prompt/Result Contract

Owner: orchestration

Tasks:

- port the minimum prompt set needed for one code-task lane
- preserve pass/fail semantics and next-step intent
- preserve PR evidence expectations

Evidence:

- workflow definition
- prompt artifacts
- expected result schema

Pass:

- one runnable workflow preserves the needed result contract

Fail:

- outputs are too loose to drive automation safely

Status: pending

### 5. Build OpenClaw Adapter

Owner: integration

Tasks:

- create a small adapter that launches Optio from an OpenClaw code-channel request
- persist returned Optio task/workflow identifiers
- define the minimum request/response contract between the front door and Optio

Evidence:

- adapter entrypoint
- sample launch payload
- resulting Optio ids

Pass:

- OpenClaw can launch Optio work without manual UI steps

Fail:

- the only workable path is manual operator interaction inside Optio

Status: pending

### 6. Add Progress Reporting Back To Discord/OpenClaw

Owner: integration

Tasks:

- map Optio lifecycle events to channel-visible progress updates
- surface blocked state and terminal result
- preserve PR URL and completion evidence in the final update

Evidence:

- sample progress messages
- terminal completion sample

Pass:

- operators can follow task progress without living in the Optio UI

Fail:

- critical status remains trapped inside Optio

Status: pending

### 7. Run One Low-Risk End-To-End Task

Owner: integration + orchestration

Tasks:

- pick one low-risk repo task
- run it from intake to branch/PR
- avoid manual lifecycle repair

Evidence:

- task id
- branch name
- PR URL
- final run summary

Pass:

- task reaches a valid PR with no manual control-plane repair

Fail:

- handoff or lifecycle gets stuck and needs operator surgery

Status: pending

### 8. Force One Failure And Observe Recovery

Owner: orchestration

Tasks:

- trigger one realistic failure path
- examples:
  - CI failure
  - requested review changes
  - merge conflict
  - killed worker
- observe recovery behavior

Evidence:

- failure trigger notes
- recovery logs/history
- final recovered state

Pass:

- Optio recovers without transcript scraping or manual state repair

Fail:

- recovery requires operator repair of workflow state

Status: pending

### 9. Compare Operator Experience

Owner: product + orchestration

Tasks:

- compare current orchestrator vs Optio on observability, control, and intervention burden
- assess whether status/inspect/audit/receipt expectations can be preserved

Evidence:

- short comparison write-up
- list of operator gaps, if any

Pass:

- operator visibility is at least acceptable relative to the current flow

Fail:

- operators lose key control or evidence

Status: pending

### 10. Define Retirement Scope

Owner: architecture

Tasks:

- list components to retire
- list components to adapt
- list components to keep
- define the cutover seam

Evidence:

- retirement map
- adapter boundary

Pass:

- there is a clear path to remove lifecycle ownership from the current orchestrator

Fail:

- Optio still depends on most of the existing control plane to function

Status: pending

### 11. Make Go/No-Go Decision

Owner: Cameron

Tasks:

- review spike evidence
- choose adopt/adopt-with-gaps/borrow/reject

Evidence:

- short decision note

Pass:

- clear next step with explicit rationale

Fail:

- ambiguous no-owner follow-up

Status: pending

## Success Metrics

- one durable authority for lifecycle state
- no transcript parsing required for correctness
- at least one forced failure recovers cleanly
- PR lifecycle is handled end to end
- Discord/OpenClaw reporting is good enough for operators
- total handoff fragility is lower than the current system

## Kill Criteria

- Optio cannot be launched cleanly from OpenClaw
- the workflow mapping requires major custom engine work
- reporting back to Discord/OpenClaw is not good enough
- operational burden is too high for the reliability gain
- the replacement would still require most of the current orchestrator logic

## Current Status

- current orchestrator stabilization checkpoint: PR #68
- recommendation before spike: stop major new architecture on the current orchestrator except critical fixes
- Optio repo cloned locally at `/root/src/optio`
- local bootstrap prerequisites installed on Linux host:
  - `kubectl v1.33.3`
  - `helm v3.18.6`
  - `kind v0.29.0`
- local Kubernetes cluster created successfully as `kind-optio-local`
- host port mappings reserved for Optio local NodePorts:
  - `30310` for web
  - `30400` for API
- `scripts/setup-local.sh` starts cleanly, but its quiet `docker build -q` flow obscures progress
- visible rebuilds confirmed the foundational local image path is viable:
  - `optio-base:latest`
  - `optio-agent:latest`
  - `optio-optio:latest`
  - `optio-api:latest`
  - `optio-web:latest`
- local images had to be loaded explicitly into `kind` with `kind load docker-image`
- first Helm install failed mechanically because the namespace was created mid-install while using `--create-namespace`
- follow-up `helm upgrade --install` succeeded cleanly
- current bootstrap evidence:
  - Helm release `optio` is `deployed` in namespace `optio`
  - API health: `http://127.0.0.1:30400/api/health`
  - web UI: `http://127.0.0.1:30310`
  - healthy pods:
    - `optio-api`
    - `optio-web`
    - `optio-optio`
    - `optio-postgres`
    - `optio-redis`
- first runtime issue observed:
  - `optio-api` can crash-loop briefly if Postgres is not ready yet
  - it recovers cleanly once Postgres becomes available
- noninteractive control-plane path proven so far:
  - `POST /api/secrets` can seed git-provider credentials
  - `POST /api/repos` can register a repo without UI interaction
  - `POST /api/tasks` can queue a repo task without UI interaction
- current local repo registration evidence:
  - repo id: `40d0f724-5d36-4ef0-8394-3928b107872e`
  - repo URL: `https://github.com/cbulock/openclaw-memory-tooling`
- current setup status evidence:
  - `gitToken: done`
  - `anyAgentKey: false`
  - `isSetUp: false`
- current hard blocker for end-to-end task execution:
  - no agent credential is configured in Optio (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_APP_SERVER_URL`, etc.)
  - a repo task can be created and queued, but reliable branch/PR execution cannot be proven until one supported agent credential path is supplied
- notable product/integration finding:
  - local `gh auth token` works directly against GitHub from the host, but Optio's secret upsert response reported `validation.valid=false` with `Bad credentials` on the same token even though the token still enabled successful repo registration afterward
  - this looks like a validation-path defect or mismatch worth tracking during replacement assessment
- next concrete step: either provide one supported Optio agent credential path for a real low-risk task run, or treat missing agent creds as the current blocker and shift the spike to workflow mapping plus adapter design

