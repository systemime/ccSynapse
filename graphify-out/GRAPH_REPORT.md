# Graph Report - ccSynapse  (2026-09-26)

## Corpus Check
- Corpus is ~25,575 words - fits in a single context window. You may not need a graph.

## Summary
- 299 nodes · 655 edges · 19 communities (18 shown, 1 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 22 edges (avg confidence: 0.81)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- WorkspaceStore & Server Logic
- Bridge & Node Integration
- Test Infrastructure
- Canvas Rendering Engine
- Card & Draft UI
- Session & Workspace State
- User Interaction Controls
- Project Metadata
- Security / Trust Fence
- Graph Layout & Connectors
- Thread Data Access
- Plugin Manifest
- Fork Detection & Lineage
- RPC & Draft Submission
- Architecture Debt / Persistence
- Expansion Roadmap
- UX Shell
- Plugin & Session Entry
- Archive Recovery

## God Nodes (most connected - your core abstractions)
1. `WorkspaceStore` - 36 edges
2. `render()` - 25 edges
3. `handleApi()` - 16 edges
4. `handleHostMessage()` - 16 edges
5. `escapeHtml()` - 13 edges
6. `openDshWorkspace()` - 13 edges
7. `submitDraft()` - 11 edges
8. `renderCanvas()` - 11 edges
9. `setError()` - 10 edges
10. `handleRpc()` - 9 edges

## Surprising Connections (you probably didn't know these)
- `parentUuid Session-internal DAG (G4)` --semantically_similar_to--> `Fork Detection (外部分支识别)`  [INFERRED] [semantically similar]
  plan.md → README.md
- `Theme Pre-paint Script (flash prevention)` --conceptually_related_to--> `Canvas Visualization Engine`  [INFERRED]
  web/index.html → README.md
- `P1-1: Sub-agent Projection` --conceptually_related_to--> `Transcript Parsing (internal jsonl format)`  [INFERRED]
  plan.md → README.md
- `Fork Detection (外部分支识别)` --references--> `Content Fingerprint Algorithm (current heuristic)`  [EXTRACTED]
  README.md → plan.md
- `/synapse Skill Entry Point` --implements--> `Claude Code Plugin System`  [EXTRACTED]
  skills/synapse/SKILL.md → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Fork Detection Pipeline (fingerprint to UUID to DAG)** — plan_content_fingerprint, plan_p0_uuid_lineage, plan_parentuuid_dag [INFERRED 0.85]
- **P0 Correctness Fixes** — plan_p0_uuid_lineage, plan_p0_split_persistence, plan_p0_unarchive [EXTRACTED 1.00]

## Communities (19 total, 1 thin omitted)

### Community 0 - "WorkspaceStore & Server Logic"
Cohesion: 0.10
Nodes (19): handleApi(), readJson(), contentText(), errorText(), foldLegacyToolCards(), InputError, isRuntimeContextMessage(), isRuntimeContextText() (+11 more)

### Community 1 - "Bridge & Node Integration"
Cohesion: 0.09
Nodes (39): ref_node_child_process, ref_node_crypto, ref_node_http, ref_node_url, claudeBinary(), continueSession(), createSession(), executableAt() (+31 more)

### Community 2 - "Test Infrastructure"
Cohesion: 0.09
Nodes (20): ref_node_assert, ref_node_fs, ref_node_os, ref_node_path, ref_node_test, ref_node_vm, AssistantGroup, clampTool() (+12 more)

### Community 3 - "Canvas Rendering Engine"
Cohesion: 0.09
Nodes (27): app, applyCanvasTransform(), bindDragHandle(), connectorPathsByCard, DEFAULT_QUICK_PHRASES, deferCanvasRefresh(), focusActiveCard(), hideSelectionFollowup() (+19 more)

### Community 4 - "Card & Draft UI"
Cohesion: 0.14
Nodes (21): applyLiveReplyToCard(), conversationCard(), draftActions(), draftCard(), draftQuickPhrases(), escapeHtml(), formatTime(), inlineMarkdown() (+13 more)

### Community 5 - "Session & Workspace State"
Cohesion: 0.19
Nodes (20): api(), archiveThread(), canReplaceView(), currentDshThread(), currentDshWorkspace(), handleHostMessage(), openCurrentWorkspace(), openDshWorkspace() (+12 more)

### Community 6 - "User Interaction Controls"
Cohesion: 0.17
Nodes (15): addQuickPhrase(), cacheCardConnectors(), closeCardInspector(), focusDraftInput(), insertQuickPhrase(), openBranch(), openContinue(), openNewSession() (+7 more)

### Community 7 - "Project Metadata"
Cohesion: 0.15
Nodes (12): description, engines, node, license, name, private, scripts, build (+4 more)

### Community 8 - "Security / Trust Fence"
Cohesion: 0.33
Nodes (9): hostTrusted(), isJson(), originTrusted(), proxied(), PROXY_TRACE_HEADERS, rejectStatus(), stripPort(), trustSet() (+1 more)

### Community 9 - "Graph Layout & Connectors"
Cohesion: 0.20
Nodes (12): canvasConnectors(), connectorPath(), conversationCards(), conversationGraphView(), draftPlacement(), firstAvailableCardPosition(), initialCanvasCamera(), layoutConversationGraph() (+4 more)

### Community 10 - "Thread Data Access"
Cohesion: 0.24
Nodes (10): answerFor(), currentThread(), latestMessage(), messagesFor(), pendingUserIndex(), persistedMessagesFor(), questionFor(), renderThread() (+2 more)

### Community 11 - "Plugin Manifest"
Cohesion: 0.29
Nodes (6): description, name, owner, name, plugins, $schema

### Community 12 - "Fork Detection & Lineage"
Cohesion: 0.40
Nodes (5): Content Fingerprint Algorithm (current heuristic), P0-1: UUID Intersection Fork Detection, parentUuid Session-internal DAG (G4), P1-2: Server/RPC Test Coverage, Fork Detection (外部分支识别)

### Community 13 - "RPC & Draft Submission"
Cohesion: 0.60
Nodes (5): dshRpc(), loadThreadHistory(), rememberBranchAnchor(), sendMessage(), submitDraft()

### Community 14 - "Architecture Debt / Persistence"
Cohesion: 0.67
Nodes (3): P0-2: Split Persistence (user-state vs projection cache), Projection/Layout Lifecycle Coupling Bug, WorkspaceStore Architecture Evaluation

### Community 15 - "Expansion Roadmap"
Cohesion: 0.67
Nodes (3): P1-1: Sub-agent Projection, Transcript Parsing (internal jsonl format), Trust Fence / Security Model

### Community 16 - "UX Shell"
Cohesion: 0.67
Nodes (3): Canvas Visualization Engine, Session Map (会话地图), Theme Pre-paint Script (flash prevention)

### Community 17 - "Plugin & Session Entry"
Cohesion: 0.67
Nodes (3): Claude Code Plugin System, Background Fork Session (claude --bg --fork-session), /synapse Skill Entry Point

## Knowledge Gaps
- **44 isolated node(s):** `$schema`, `name`, `description`, `name`, `plugins` (+39 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 69 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `WorkspaceStore` connect `WorkspaceStore & Server Logic` to `Bridge & Node Integration`, `Test Infrastructure`?**
  _High betweenness centrality (0.071) - this node is a cross-community bridge._
- **Why does `TranscriptSource` connect `Test Infrastructure` to `Bridge & Node Integration`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **Why does `handleApi()` connect `WorkspaceStore & Server Logic` to `Bridge & Node Integration`?**
  _High betweenness centrality (0.011) - this node is a cross-community bridge._
- **Are the 9 inferred relationships involving `handleApi()` (e.g. with `.addMessage()` and `.branch()`) actually correct?**
  _`handleApi()` has 9 INFERRED edges - model-reasoned connections that need verification._
- **What connects `$schema`, `name`, `description` to the rest of the system?**
  _44 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `WorkspaceStore & Server Logic` be split into smaller, more focused modules?**
  _Cohesion score 0.09796806966618288 - nodes in this community are weakly interconnected._
- **Should `Bridge & Node Integration` be split into smaller, more focused modules?**
  _Cohesion score 0.08902439024390243 - nodes in this community are weakly interconnected._