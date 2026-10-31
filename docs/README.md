# Acme Credit — Secured Card Service: Specification

This folder holds the spec for the service. We use spec-driven development (SDD):
the spec comes first, the code follows the spec, and a code change that changes
behaviour updates the spec in the same commit.

## Documents

| File | Content |
|---|---|
| [requirements.md](requirements.md) | What the service must do. Each requirement has an ID (for example `SPEND-03`). |
| [architecture.md](architecture.md) | How the service does it: modules, data model, ledger, state machines, concurrency, security. |
| [tasks.md](tasks.md) | Milestones and tasks. Each task names the requirement IDs it covers. |
| [decisions.md](decisions.md) | The decision log (Q1–Q32) with the reason for each decision. |
| [open-questions.md](open-questions.md) | Questions that still need an answer. A task that depends on one stays blocked. |

## SDD rules

1. A new behaviour starts as a requirement in `requirements.md`.
2. The design for it goes in `architecture.md` before the code.
3. Every test names the requirement ID it proves, for example `it("SPEND-03: ...")`.
4. A commit that changes behaviour updates the spec in the same commit.
5. When a task is done, mark it in `tasks.md` and link the commit.
6. An answer to an open question moves to `decisions.md` with its reason.
