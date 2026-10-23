# The Taskano way

Taskano is a task system where AI agents lead the work and people do it. This document explains what it
believes, how it grows with a company, and what it needs from you to work at all.

## The core idea: you stop writing tasks down

Most task systems assume the hard part is storage. It is not. The hard part is that work is agreed on in
conversation — in a chat, a call, a thread — and then has to be remembered, phrased, assigned and followed up
by the same person who is already busy doing the work. That step is where things die.

Taskano moves that step to the agent. You talk about the work; the agent notices the commitment, words it so
the person receiving it can act on it, picks who should do it, sets the date, and follows up until there is a
result. You are not filling in a form. You are having a conversation, and the tasks appear as a by-product.

This is why the skill sits in your working session rather than behind a login page: it listens where the work
is actually discussed, and it treats "record this" as one line in the flow, not a detour into a tool.

## What it believes

**Complexity switches on when something asks for it.** A new company does not configure projects, areas,
quotas and schedules. It assigns one task to one person. Every further capability appears when there is a
reason for it, and the system says which reason it saw — "people waited hours for an answer while you were
away". A product that demands configuration up front is paid for in attention by everyone who did not need it.

**The system works where the person already works.** Not "log in to Taskano" — but their chat, their Telegram,
their language. A person doing the work never learns a tracker: they get one task and a button. A person
assigning work never maintains a board: they talk, and the secretary writes.

**Nothing is lost quietly.** A question without an answer, a result nobody checked, a person with no next step,
a task closed by mistake — each is a visible state, not silence. Loss has to surface on its own.

**Honesty beats appearances.** When something is missing — public holidays in the calendar, replies at the
weekend without a runner, a native speaker behind a translation — the system says so plainly instead of
pretending. A promise the product does not keep costs more than a missing feature.

**Privacy is a property of a thing, not a separate world.** A closed project lives in the same storage under
one visibility rule. A separate "personal space" beside the work one means two sets of rules that drift apart.

## What the system needs from you: context about people

An agent cannot lead someone it knows nothing about. A name and an email are enough to deliver a message and
nothing more — with only that, the agent will pick the wrong person, word the task at the wrong level, and ask
questions that were already answered.

For every person you add, say who they are, in plain language:

- **Who they are and what they do** — their role, not a job title: "handles suppliers in China, speaks
  Mandarin", "does the accounting and all filings", "runs the workshop and everything physical".
- **What kind of work they close** — the things that genuinely belong to them, and the things they should never
  be handed.
- **How they work** — guided step by step, or independently; what they need spelled out and what they will
  work out for themselves.
- **What they already know** — context you would otherwise repeat in every task: which supplier, which client,
  which of last year's decisions still stands.

Put this in the company playbook (`set_playbook`) and in the memory of the area the person works in
(`set_agent_note`). Both are read by agents on every run, so it is written once and used forever. Thin context
is the single most common reason agents lead badly — not the model, not the prompt.

The same applies to the company itself: how it likes to work, what is never promised to clients, which words
are never translated. An agent with a good playbook and weak wording beats an agent with clever wording and no
idea how the business works.

## How it grows

Each step below is a state a company can actually notice in itself. The order is not compulsory: stopping at
step 2 forever is a normal way to use the product, not an unfinished setup.

| # | What you notice | What switches on | What you still do not need |
|---|---|---|---|
| 0 | Only your own work, too much to hold in your head | A list, "Now", dates, reminders | No people, no agents, no projects |
| 1 | The first person doing work for you | Invitation, a bot in their language, one task at a time, a result and a criterion | No areas, no plans yet |
| 2 | Assigning work eats the day; there are several people | An agent per area: leads people, writes the next step, checks results | No cloud runner — the agent thinks inside your own sessions |
| 3 | A task stopped being one action | A plan: 2–4 steps, the first released, the rest waiting on the result | Still no projects — a plan is enough |
| 4 | People wait for answers while you are away | A runner: agents react without you, in minutes | Until then, a delay of hours bothered nobody |
| 5 | There are so many tasks the list stopped being readable | Projects as folders; a closed project for privacy inside the company | No reports or metrics required yet |
| 6 | The work is discussed in group chats, not in the system | Chat intake: facts and photos filed under tasks, clear assignments become tasks | Requires that people have already signed in |
| 7 | You need to see what is happening, in numbers | Totals by period, by person, by project; time tracking | Earlier, the numbers would have been about nothing |
| 8 | Several companies, different roles and rules | Separate organizations, admins, quotas between areas | For a single company all of this only gets in the way |

**Nesting is deliberately limited.** Task → plan step → project → area. Four levels, and there will be no
fifth: sub-tasks of sub-tasks and trees of goals are a way of hiding an unmade decision instead of naming the
next action. Work that does not fit into four levels has not been thought through yet — and that is the
agent's job, not the data model's.

## Where the line is

**It is not a tracker.** No boards, no columns, no choice of statuses, no process builder. One lifecycle for
the whole product: nobody has to learn someone else's scheme.

**People are not turned into numbers for comparison.** No ratings, no screenshots, no presence tracking, no
penalty statuses. Totals answer "what was done", never "who is worse".

**An agent gets no authority a person would not be given.** Money and promises to outsiders go through the
owner's consent. Every agent has a human owner, and the "Unclear" and "Decline with a reason" buttons cannot
be removed: they are the only channel through which you learn the agent is leading someone the wrong way.

**Settings do not accumulate.** Each new one is a debt owed to every future company. A default that suits most
people is better than a field that is correct for everyone.
