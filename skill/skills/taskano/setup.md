# Setting up an organization in conversation

The goal of the first session is not "everything configured" but **one step sent to a real person**.

## 0. Where are we
Start with `get_setup_status`. Setup can be resumed: continue from the first unfinished item.

## 1. Organization
`get_setup_status` already said whether a company exists.

**It does** — an operator set it up before the first sign-in. Create nothing, go straight to the settings below.

**It does not** — create it: `create_org(name)`. Ask only for the company name; no invite code is needed. If the
user mentions an invite code, pass it as `invite_code` — a wrong one is refused, so say so rather than retrying
without it. A refusal with `limit_exceeded` means a product limit (three companies per person, or new sign-ups
paused for the day): tell the user what the message says and stop — nothing else can be set up yet.

**Either way the company starts on `en` and `UTC`** — deliberately neutral, because nobody guessed the user's
settings for them. Set what you already know from the conversation — `update_org_settings(name, language, timezone)`
— and give the agent working window the same zone: otherwise agents keep a UTC day and a deadline lands on the
wrong evening.

**These are not a gate.** Never hold up the setup waiting for them, and never open with a form of questions about
them. Ask when it comes up naturally — the user names a working hour, a city, a time of day — and change them then and
there, in whatever conversation you are in. A company works fine on defaults until someone says otherwise, and
nothing here is a one-time choice.

Time zones take a full IANA name (`Asia/Ho_Chi_Minh`, `America/Sao_Paulo`, `Europe/Berlin`); short forms such as
`UTC+7` or `IST` are rejected — `IST` alone is India, not Israel. Do not infer a country from the language the
user writes in: ask, or leave it.

## 2. A conversation, not a form
Find out in plain language, with short questions, no more than two at a time:
- **Areas** of work (for example sales, support, operations). Each becomes an agent.
- **People**: name, email, preferred language, country, which area they work in,
  who should be guided step by step (guided mode, the default) and who works independently.
  The bot interface is fully localized in English, Russian, Turkish and Vietnamese. For any other language the
  person gets an English interface, while the text of their tasks is still translated for them. Say so plainly
  instead of promising more.
- **Agent working window**: the hours when agents recalculate plans (default Mon–Fri 09:00–19:00 in the
  organization's time zone). The working calendar is days of the week only — public holidays are not modelled in
  this version, so a deadline can land on one. Say that plainly if it comes up; do not promise otherwise.
- **Words not to translate**: brand and product names, internal terms.
- **Playbook**: how this company likes to work. Saved with `set_playbook`, read by agents on every run.

## 3. Create
- `update_org_settings` — language, time zone, window, glossary.
- `create_agent` — one per area; the owner is the person responsible for that area (by default, the user).
- `invite_person` — for each person (email, name, language). They receive an email with a link to the Telegram bot.
  **The email address is the way in, and there is no other.** No address named — ask for it in one line and wait:
  "What is Maria's email? The invitation goes there." A Telegram handle, a phone number or just a name is not
  enough, so do not offer them as a substitute and do not say the person has been added until they have been.
  The link lives only in that email — whoever opens it becomes this person, so the response does not carry it. If the
  letter does not arrive, check the address and invite again with `resend: true`.
- `set_person_settings(about)` — right after inviting, ask who this person is and what they close, and write the answer down:
  their trade, what they are good at, what not to give them, what they already know. One paragraph in the owner's
  own words. This is what makes an item land on the right person later; without it you will guess.
- `set_person_settings` — mode, quotas between areas if a person works for several (for example 60/40), and also
  `timezone` (an IANA name such as `America/Sao_Paulo`) and working hours. The bot itself offers only a few common
  time zones, so set anything else here.
- `update_org_settings(ai_budget_usd_month)` — the monthly AI budget (default $20). It limits translation and the
  analysis of work chats, not the agents' own work: when it runs out, the owner gets a notification and translation
  pauses until the budget is raised. There is no tool that reports the amount spent so far.
- `set_playbook` — the playbook.

## 4. Agent runner (routine) — optional, and not now

**A company works without it.** While there is no runner, the agents catch up in the owner's own sessions: every
time they open a chat with this skill, the run ritual goes through what has piled up — results to check, questions,
people left without a step. For a company that is just starting, with a handful of tasks a day, that is enough.
The server does the timed part anyway, with or without a runner: releases scheduled tasks, reminds, keeps the
"Now" slot, escalates silence, sends the morning digest.

**What a runner adds:** agents react when the owner is away. A question asked on Saturday gets an answer on
Saturday, not on Monday when the owner opens their laptop.

**Say this plainly when setting up, and move on** — do not stop the setup for it. Offer to connect it later, when
one of these shows up, and say which one it is:

- people in other time zones, or work at weekends;
- questions and submitted results that sit for hours because the owner was not at the computer (you see the
  timestamps in the briefing);
- more than a handful of active people, so the queue does not empty itself between the owner's sessions.

Connecting it needs a claude.ai account with Routines, and the steps below. Walk the user through them and check
each one:
1. Open https://claude.ai/code/routines → **New routine**. If the account has no Routines section, the runner
   cannot be set up: the rest of Taskano works, but agents will not lead anyone on their own. Say this plainly
   rather than looking for workarounds.
2. Prompt: the text from `routine-prompt.md` in this repository (with the organization's name filled in).
3. Repository: the user's own fork of this skill repository. Connector: Taskano (remove the others).
4. Schedule: **two or three times a day inside the organization's working window** — say, the start of the day,
   after lunch and before the end — and nothing on weekends. Not hourly: whatever is actually blocking someone
   (a question, "unclear", a refusal, an idle person, a submitted result) wakes the runner the moment it happens.
   The schedule is only there for states that produce no event — a person who has run out of ready steps.
5. Save, open **Edit → Add another trigger → API**, copy the URL and press **Generate token**.
6. Call `connect_runner` to get a link to a Taskano page. The user opens it and pastes the URL and token there.
   **The token must never be pasted into the chat.**
7. `get_setup_status` should show the runner as connected. If it does not, work through the steps before moving on.

If the owner later gets a "cannot reach the runner" notification, the trigger token has stopped working: generate
a new one in the routine (**Edit → API trigger → Generate token**), call `connect_runner` again and paste the new
URL and token on the page it returns.

## 5. People sign in

**The owner signs in too — do not skip this.** An invitation is never sent to someone who is already a member, so
the owner links Telegram themselves: open @Taskano_bot, `/start`, sign in with the same email, enter the code from
the letter. Until that link exists Taskano cannot reach the owner at all: no decisions to make, no proposals from
agents, no "the AI budget has run out", no "cannot reach the runner", no morning digest — everything is silently
dropped. Walk the user through it and confirm it worked before promising that Taskano will tell them anything.

Each invited person gets an email with a link to the Telegram bot (@Taskano_bot). They open it, agree to the terms,
confirm their time zone, and from then on receive tasks in the bot. `get_setup_status` shows who has signed in.
People who have not signed in receive nothing — check this before promising the user that work has started.

- After signing in, the bot tells each person how to put the app on their phone's home screen, so their task list
  is one tap away instead of a search through Telegram. Repeat it to the user for their own phone: open the app
  from the bot, then "Add to Home Screen" in the "…" menu.
- "Invite them again": `invite_person(email, resend: true)` acts on where the person is, and the response says so in
  `result` and `sent`. Not accepted yet: a fresh invitation email with a new link (`invitation_resent`). Accepted but never
  opened the app: an email and a bot message with an "Open app" button (`app_nudge_sent`, at most once a day). Already
  uses the app: nothing is sent (`already_using_app`). Tell the user exactly what went out and when the person was
  last seen in the bot and in the app — "active member" alone does not mean they use Taskano. An empty bot mark means
  the person has not written to the bot or pressed a button there, not that they never opened it.
- "This Telegram is already linked to someone else": that Telegram account belongs to another Taskano user. Accounts
  are never merged. The person should sign in with the email they already use, or use another Telegram account.

## 6. Work chats (optional, any time later)
The team can add the bot to their Telegram work groups. Whoever links a group must have opened a private chat with
the bot first, otherwise the bot cannot explain what went wrong. Add @Taskano_bot to the group and make it an administrator,
otherwise Telegram hides the messages from it. Only an owner or admin of the company can link a group; they get a
confirmation in their private chat with the bot. In the group the bot stays silent. It files photos and facts from
people of the company under the right tasks, and proposes tasks from clear assignments. **Only messages from people
who are already active members of this company are read** — anything written by someone who has not signed in to
Taskano is dropped, not stored. So a group is worth linking after the team has signed in, not before, otherwise it
looks as if the bot collects nothing. One group belongs to one company at a time. `list_groups` shows linked
groups, `update_group(status: 'paused' | 'active')` turns the intake off and on. `update_group(due_from_chat: true)`
lets the bot set the due date of an existing task when it is plainly agreed in the chat ("I'll do it by Friday") by
the person doing it, its author, or an owner/admin; the message is recorded as the source. Off by default — turn it
on only when the owner says so.

## 7. Running it afterwards
- An area is on hold (seasonal, the person is away): `update_agent(paused: true)`, and `paused: false` to resume.
  A paused agent leads no one and is skipped in the briefing.
- Someone leaves the company: `offboard_person`. Their open tasks are cancelled and their timers stop.
- Someone wants a different language or working hours: `set_person_settings`. People can also switch the bot's
  language themselves with `/language`.
- Check on people any time: `review_person`, `find_task(person)`, `agent_metrics`.

## 8. First result (this is what the first session is for)
- `create_plan` for one real piece of work for one person, 2–3 steps (`add_step`), then `release_step` for the first.
- Tell the user: the person will get the step in Telegram as soon as they sign in from the invitation email.
- The session ends when the step is sent. `get_setup_status` shows that the first task exists.
