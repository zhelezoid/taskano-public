# Task review — one at a time, five steps

Starts when the user says "let's go through my tasks", "task review", "let's review what's on my plate" or similar,
in any language. The goal is not to retell the list but to bring each task to a recorded decision.

## Preparation (once, at the start)

1. Collect the tasks. Without `org`, `find_task` searches the personal space and every company at once, and says
   where each task was found: `find_task(person: <the user>)` — the open tasks **on** them (`person` is only the
   one doing it), and `find_task(mine_only: true)` — what they set themselves, on anyone. Merge the two; waitings
   ("waiting on others") come with them.
2. Show them as **one short list** in two blocks — **Personal** and **Company <name>** — titles only, one line
   each. Review order: ★ important first, then "decide", then the ones that have been sitting longest.
3. Ask one thing: "Start with <first task>, or pick another?" — then go one by one.

## One task — five steps, strictly one step per message

Do not give all the steps at once. Each step is a short message with one question; the next step comes after the
answer.

1. **Discuss.** Recall the gist in 2–3 lines (from the description, comments, attachments) and ask what has changed
   since it was recorded. Listen; clarify with facts, not opinions. Check where the item lives: ask not "who does
   it" but **"whose item is this"** — an item that serves the company is the company's, even when the user does it
   themselves; personal is what would remain if the company closed. If it sits in the wrong space — say so and
   offer to move it; the move itself happens at the commit step.
2. **Reflect.** Help the user see the task honestly: what is really in the way, what they are avoiding, what "doing
   nothing for another month" would cost. One or two observations, no judgement and no pep talk.
3. **Record the decision.** Put the decision in one sentence ("no second location until orders double") and ask
   "right?". After a "yes" — `comment_task(text: "Decision: …")`.
4. **Strategy.** How exactly it gets done: 2–4 steps, who, by when, what could go wrong. Once agreed —
   `comment_task(text: "Strategy: …")`.
5. **Commit.** Bring the system in line with the decision. Offer only what their role in that company allows
   (SKILL.md → "Which company, which role"), and say what you did in one line — **only after the call came back
   without an error**; a refusal is reported as it came, not as "recorded":
   - done → `submit_task`. Their own task (they set it for themselves, no agent leads it) becomes done at once;
     a task someone else set goes to that person to accept;
   - no longer needed → `cancel_task` — for a task they set, or as the owner or an admin. A task someone else set
     on a member → `ask_about_task(kind: "decline")` with the reason: it closes the task and tells the author. Never `cancel_task`
     for work that was done: it would count as not needed;
   - the kind, importance or wording changes → `update_task` (`category`, `priority`, `due_date`) — the author,
     the owner or an admin; the person doing it changes only `due_date`;
   - waiting on someone → `update_task(waiting_for, next_check_at)`;
   - strategy steps done by another person → company tasks (`create_task` with `why`, `done_criteria`,
     `due_date`) — not for a guest; the user's own steps → `create_task` with `org: "personal"`;
   - the item belongs in the other space → `move_to_org(task, org)`, one item at a time and only after an explicit
     "yes". Into a company it needs `why`, `done_criteria` and `due_date` — collect what is missing in this same
     conversation, that is what the move is for. Only the user can move an item; an agent cannot.

Then: "Next — <title>?". The user can say "stop" at any time — then give a short summary: how many tasks were
reviewed and which decisions were recorded.

## Rules

- One task at a time, one step per message. Do not move to the next task until the commit step is done.
- Decisions and strategies are recorded only after an explicit "yes".
- Delete nothing without an explicit "yes".
- Personal and company never mix — and the line between them is "whose item is this", not "who does it": work for
  the company goes to the company even when the user does it themselves; personal is what would remain if the
  company closed.
