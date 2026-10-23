import { DEMO_PEOPLE_DOMAIN } from '../email/send.js';
import { setActor, withGlobal, type Db } from '../db/pool.js';
import { demoLoginEmail } from '../config/env.js';
import { requireMember } from '../core/access.js';
import { localDate } from '../core/calendar.js';
import { addHumanComment } from '../core/comments.js';
import { invitePerson } from '../core/invitations.js';
import { transition } from '../core/lifecycle.js';
import { addMember, ensureUserByEmail, findUserByEmail, provisionClient, setPersonAbout } from '../core/people.js';
import { addProjectMember, createProject, ensureDefaultProject } from '../core/projects.js';
import { stopTask, takeTask } from '../core/queue.js';
import { addSource } from '../core/sources.js';
import {
  cancelTask, createPlan, createTask, logDecision, releaseStep, requireAuthor, resolveWaiting, type TaskInput,
} from '../core/tasks.js';
import { addManual, startTimer, stopTimer } from '../core/time.js';
import type { Actor, Task } from '../core/types.js';
import { addComment } from '../mcp/tools/tasks.js';

// Демо-компания для ревьюера каталога и для показа (спека demo-access). Сносится и заводится заново
// одной транзакцией: упади наполнение на середине — остаётся прежнее демо, а не половина нового.
//
// Наполнение идёт только функциями ядра, теми же, что зовут инструменты MCP, бот и приложение: демо
// обязано быть тем, что продукт умеет сделать сам. Сырая вставка в слой организации показала бы
// ревьюеру состояние, до которого живой пользователь дойти не может. Где своей функции в ядре нет
// (агент, заметка агента), повторяется запрос самого инструмента.

export const DEMO_OWNER_EMAIL = 'demo@taskano.app';
/** Домен вымышленных людей: по нему их находит сброс и глушит почта (src/email/send.ts). */
export { DEMO_PEOPLE_DOMAIN };
export const DEMO_COMPANY = 'Northwind Studio';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export interface DemoSummary {
  org_id: string;
  company: string;
  owner: { email: string; user_id: string };
  people: { name: string; email: string; language: string; role: string; status: string }[];
  projects: { key: string; name: string; private: boolean }[];
  tasks: { total: number; by_status: Record<string, number> };
  wiped: { companies: number; people: number; people_kept: number; other_companies_kept: number };
}

/**
 * Снести демо-компанию и завести заново с датами относительно `now`. Сроки считаются от момента
 * запуска («сегодня», «просрочено на день»), поэтому демо не протухает, пока лежит в очереди ревью.
 */
export async function demoReset(opts: { now?: Date } = {}): Promise<DemoSummary> {
  // Глушение писем демо-владельцу держится на DEMO_LOGIN_EMAIL (src/email/send.ts): без него каждое
  // наполнение слало бы приветствие на demo@taskano.app через Resend. Проверка здесь, а не у
  // вызывающего, — чтобы её не забыл следующий вызывающий (ревью диффа).
  if (demoLoginEmail() !== DEMO_OWNER_EMAIL) {
    throw new Error(`demo-reset: сначала DEMO_LOGIN_EMAIL=${DEMO_OWNER_EMAIL} и DEMO_LOGIN_CODE_SHA256 в окружении`);
  }
  const now = opts.now ?? new Date();
  return withGlobal(async (db) => {
    // Два сброса одновременно завели бы две демо-компании: снос каждого не видит незакоммиченную чужую.
    await db.query(`select pg_advisory_xact_lock(hashtext('taskano:demo-reset'))`);
    const wiped = await wipeDemo(db);
    const summary = await seedDemo(db, now, wiped);
    await db.query(`insert into admin_audit(actor, action, payload) values ('admin-cli', 'demo_reset', $1)`,
      [{ org_id: summary.org_id, tasks: summary.tasks, wiped }]);
    return summary;
  });
}

/**
 * Снос. Организация удаляется целиком: весь её слой висит на `orgs` через `on delete cascade`, а
 * каскад внешних ключей идёт правами владельца таблиц и RLS не упирается. Пользователь
 * demo@taskano.app остаётся — на нём держатся токены коннектора ревьюера. Настоящие люди, которых
 * ревьюер пригласил в демо, теряют только членство: оно уходит вместе с организацией.
 */
async function wipeDemo(db: Db): Promise<DemoSummary['wiped']> {
  const owner = await findUserByEmail(db, DEMO_OWNER_EMAIL);
  // Только компания с демо-названием: окажись под этим адресом другая компания (опечатка в
  // provision-client, проект ревьюера) — сброс её не сносит, а называет в сводке (ревью диффа).
  const owned = owner
    ? (await db.query(`select id, name from orgs where owner_user_id = $1 and kind = 'company'`, [owner.id])).rows as { id: string; name: string }[]
    : [];
  const orgIds = owned.filter((o) => o.name === DEMO_COMPANY).map((o) => o.id);
  const otherCompanies = owned.length - orgIds.length;
  for (const orgId of orgIds) {
    // Единственная ссылка на организацию без каскада — состав закрытых проектов (миграция 013): его
    // строки уходят с проектом, но проверка ключа на `orgs` срабатывает раньше. Снимаем состав сами,
    // в контексте самой организации — таблица под RLS.
    await db.query(`select set_config('app.org_id', $1, true)`, [orgId]);
    await db.query('delete from project_members');
  }
  await db.query(`select set_config('app.org_id', '', true)`);
  const companies = orgIds.length
    ? (await db.query('delete from orgs where id = any($1::uuid[])', [orgIds])).rowCount ?? 0
    : 0;

  // Вымышленный — только тот, у кого нет ни одной почты вне демо-домена: человек, добавивший себе
  // демо-адрес второй почтой, настоящий, и его не трогаем. И только тот, кто после сноса демо не
  // состоит ни в одной компании: удаление человека каскадом унесло бы его членство в чужой (ревью
  // диффа — без дел там ошибки ключа нет, и членство пропадало молча).
  const candidates = (await db.query(
    `select u.id, exists (select 1 from memberships m join orgs o on o.id = m.org_id
                           where m.user_id = u.id and o.kind = 'company') as elsewhere
       from users u
      where exists (select 1 from user_emails e where e.user_id = u.id and lower(e.email::text) like $1)
        and not exists (select 1 from user_emails e where e.user_id = u.id and lower(e.email::text) not like $1)`,
    [`%@${DEMO_PEOPLE_DOMAIN}`])).rows as { id: string; elsewhere: boolean }[];
  const fictional = candidates.filter((c) => !c.elsewhere);
  let people = 0;
  let kept = candidates.length - fictional.length;
  for (const { id } of fictional) {
    // Вымышленного человека могли позвать и в чужую компанию — тогда на него ссылаются её дела, и
    // удалить его нельзя. Такой остаётся как есть: следующее наполнение найдёт его по почте.
    await db.query('savepoint demo_person');
    try {
      await db.query(`delete from orgs where owner_user_id = $1 and kind = 'personal'`, [id]);
      await db.query('delete from users where id = $1', [id]);
      await db.query('release savepoint demo_person');
      people += 1;
    } catch (e) {
      if ((e as { code?: string }).code !== '23503') throw e;
      await db.query('rollback to savepoint demo_person');
      kept += 1;
    }
  }
  return { companies, people, people_kept: kept, other_companies_kept: otherCompanies };
}

interface PersonSpec {
  email: string; name: string; language: string; timezone: string; country: string;
  role: 'admin' | 'member' | 'guest'; status: 'active' | 'invited'; about: string;
}

const PEOPLE = {
  emma: {
    email: `emma.clarke@${DEMO_PEOPLE_DOMAIN}`, name: 'Emma Clarke', language: 'en', timezone: 'Europe/London', country: 'GB',
    role: 'admin', status: 'active',
    about: 'Studio manager. Runs content, hiring and client comms. Knows every case study by heart; do not give her DNS or server work.',
  },
  mehmet: {
    email: `mehmet.yilmaz@${DEMO_PEOPLE_DOMAIN}`, name: 'Mehmet Yılmaz', language: 'tr', timezone: 'Europe/Istanbul', country: 'TR',
    role: 'member', status: 'active',
    about: 'Front-end and infrastructure developer. Owns hosting, DNS, redirects and performance. Writes in Turkish; reads English fine.',
  },
  linh: {
    email: `linh.nguyen@${DEMO_PEOPLE_DOMAIN}`, name: 'Linh Nguyễn', language: 'vi', timezone: 'Asia/Ho_Chi_Minh', country: 'VN',
    role: 'member', status: 'active',
    about: 'Designer and part-time recruiter. Screens candidates for the Q4 hiring round and keeps the salary benchmarks.',
  },
  dmitry: {
    email: `dmitry.sokolov@${DEMO_PEOPLE_DOMAIN}`, name: 'Dmitry Sokolov', language: 'ru', timezone: 'Europe/Moscow', country: 'RU',
    role: 'guest', status: 'invited',
    about: 'External accessibility consultant, invited for the audit of the new templates. Has not accepted the invitation yet.',
  },
} satisfies Record<string, PersonSpec>;

type PersonKey = keyof typeof PEOPLE;

async function seedDemo(db: Db, now: Date, wiped: DemoSummary['wiped']): Promise<DemoSummary> {
  const at = (days: number, hours = 0): Date => new Date(now.getTime() + days * DAY + hours * HOUR);
  /** Срок дела — локальная дата исполнителя, как у `due_date` любого дела. */
  const due = (days: number, who: PersonKey | 'owner'): string =>
    localDate(at(days), who === 'owner' ? 'Europe/London' : PEOPLE[who].timezone);

  // Компания заводится тем же путём, что `provision-client`: владелец и его личное пространство
  // находятся по почте или создаются — id владельца между сбросами не меняется.
  const { userId: ownerId, orgId } = await provisionClient(db, DEMO_OWNER_EMAIL, DEMO_COMPANY,
    { language: 'en', timezone: 'Europe/London', name: 'Alex Morgan' });
  await db.query(`select set_config('app.org_id', $1, true)`, [orgId]);
  // Рабочий календарь владельца — тот, что у компании: иначе его сроки считались бы по чужому поясу.
  // Тот же запрос, что у `set_person_settings`.
  await db.query('update users set timezone = $2, country = $3 where id = $1', [ownerId, 'Europe/London', 'GB']);

  const owner: Actor = { kind: 'user', userId: ownerId };
  const user = (userId: string): Actor => ({ kind: 'user', userId });
  // Действующее лицо сессии — как у инструментов MCP: человек, действующий сам, видит свои закрытые
  // проекты; за агентом человека нет.
  const by = async <T>(actor: Actor, fn: () => Promise<T>): Promise<T> => {
    await setActor(db, actor.kind === 'user' ? actor.userId : null);
    return fn();
  };

  // ---------------------------------------------------------------- люди
  const ids = {} as Record<PersonKey, string>;
  for (const [key, p] of Object.entries(PEOPLE) as [PersonKey, PersonSpec][]) {
    if (p.status === 'invited') {
      // Приглашённый — настоящим приглашением: письмо на демо-домен глушит транспорт почты.
      ids[key] = (await by(owner, () => invitePerson(db, { email: p.email, name: p.name, role: p.role, language: p.language }, owner, now))).userId;
    } else {
      // Принять приглашение можно только из Telegram, которого у вымышленных людей нет, — поэтому
      // действующее членство ставится напрямую, как это делает подписание клиента.
      ids[key] = (await ensureUserByEmail(db, p.email, { name: p.name, language: p.language })).user.id;
      await addMember(db, orgId, ids[key], p.role, 'active');
    }
    await db.query('update users set timezone = $2, country = $3 where id = $1', [ids[key], p.timezone, p.country]);
    await by(owner, () => setPersonAbout(db, ids[key], p.about, owner));
  }
  const emma = user(ids.emma);
  const mehmet = user(ids.mehmet);
  const linh = user(ids.linh);

  // ---------------------------------------------------------------- проекты
  // Личная доска владельца — единственный его собственный закрытый проект: «личное» коннектор ищет
  // как самый ранний закрытый проект человека, а время создания в одной транзакции у всех одно.
  const notes = await by(owner, () => createProject(db, { name: 'My notes', private: true }, owner));
  // «Без проекта» в продукте значит «в проекте по умолчанию» (General). Дела туда кладутся явно: проект
  // по умолчанию — самый ранний открытый, а у всех проектов этой транзакции время создания одно, и
  // выбор между General и Website relaunch решал бы случайный id.
  const general = await by(owner, () => ensureDefaultProject(db, orgId));
  const web = await by(owner, () => createProject(db, {
    name: 'Website relaunch',
    description: 'New northwind.studio: faster, case studies first, live before the end of the quarter.',
  }, owner));
  // Поэтому закрытый проект найма ведёт Эмма: будь его хозяином владелец, «личное» в коннекторе могло
  // бы попасть сюда. В составе — двое: владелец и Линь.
  const hiring = await by(emma, () => createProject(db, {
    name: 'Q4 hiring', private: true, description: 'Hiring one front-end developer before December. Salaries and names stay here.',
  }, emma));
  await by(emma, () => addProjectMember(db, hiring.id, ownerId, emma));
  await by(emma, () => addProjectMember(db, hiring.id, ids.linh, emma));

  // ---------------------------------------------------------------- агент и его план
  // `create_agent`: своей функции в ядре нет — тот же запрос, что у инструмента, с той же проверкой роли.
  await requireMember(db, ownerId, ['owner', 'admin']);
  const agentId = (await db.query(
    `insert into agents(org_id, name, description, owner_user_id) values (current_setting('app.org_id')::uuid, $1, $2, $3) returning id`,
    ['Relaunch lead', 'Leads the website relaunch: plans the steps, follows people up, accepts the results.', ownerId],
  )).rows[0].id as string;
  const agent: Actor = { kind: 'agent', agentId, userId: ownerId };

  // ---------------------------------------------------------------- действия
  const put = async (actor: Actor, input: TaskInput, when: Date, source: { title: string; quote: string }): Promise<Task> =>
    by(actor, async () => {
      const t = await createTask(db, input, actor, when);
      // Источник дела — тем же вызовом, что у `create_task`: без него человек видит голое название.
      await addSource(db, { taskId: t.id, kind: 'chat', title: source.title, quote: source.quote }, actor, when);
      return t;
    });
  const take = (actor: Actor, t: Task, when: Date) => by(actor, () => takeTask(db, t.id, actor, { now: when }));
  const submit = (actor: Actor, t: Task, when: Date, result?: string) =>
    by(actor, () => transition(db, t.id, 'submit', actor, { now: when, result: result ? { text: result } : undefined }));
  // `review_result`: судить работу может только автор дела, и проверка та же.
  const review = (actor: Actor, t: Task, when: Date, verdict: 'accept' | 'rework', text?: string) => by(actor, async () => {
    await requireAuthor(db, t.id, actor);
    return transition(db, t.id, verdict, actor, { now: when, text });
  });
  // `log_work`: минуты за день работы — дата в поясе самого человека.
  const logTime = (who: 'emma' | 'mehmet' | 'linh', t: Task, minutes: number, when: Date) =>
    by(user(ids[who]), () => addManual(db, ids[who], t.id, minutes, localDate(when, PEOPLE[who].timezone)));
  const comment = (userId: string, t: Task, text: string, when: Date) =>
    by(user(userId), () => addHumanComment(db, t.id, userId, text, when));
  const chat = (days: number) => `Conversation with Alex, ${localDate(at(days), 'Europe/London')}`;

  // Порядок ниже — порядок жизни: очередь человека выдаёт «Сейчас» по тому, что уже есть, поэтому
  // дела каждого заводятся и двигаются в той последовательности, в какой это случилось бы на деле.

  // ---- Эмма: два закрытых дела, шаги плана, дело на доработке, очередь
  const speed = await put(owner, {
    title: 'Audit the page speed of the current site', assigneeUserId: ids.emma, project: general.id, dueDate: due(-11, 'emma'),
    description: 'Run Lighthouse (mobile) on the home page and the three most visited case studies. List the five heaviest things on each page and what they weigh.',
    why: 'We need a baseline before the relaunch — otherwise nobody can say the new site is faster.',
    doneCriteria: 'A table in the shared drive: page, score, top five offenders with sizes.',
    expectedResult: { type: 'text', required: true },
  }, at(-13), { title: chat(-13), quote: 'Before we rebuild anything, let us know how slow we actually are.' });
  await take(emma, speed, at(-13, 1));
  await submit(emma, speed, at(-12, 3), 'Mobile score 41. Worst offenders: hero video (8.2 MB), three web fonts, unminified JS bundle. Table is in /Relaunch/Audit.');
  await logTime('emma', speed, 150, at(-12));
  await review(owner, speed, at(-11), 'accept');

  const jobPost = await put(owner, {
    title: 'Publish the front-end developer job post', assigneeUserId: ids.emma, dueDate: due(-8, 'emma'), project: hiring.id,
    description: 'Use the draft in /Hiring/JD. Post it on LinkedIn and We Work Remotely; salary range from Linh\'s benchmarks.',
    why: 'Hiring takes six weeks on average — the post has to be live now to have someone by December.',
    doneCriteria: 'Both listings are live; links are in the result.',
    expectedResult: { type: 'text', required: true },
  }, at(-10), { title: chat(-10), quote: 'Let us get the job post out this week.' });
  await take(emma, jobPost, at(-10, 1));
  await submit(emma, jobPost, at(-9), 'Live on LinkedIn and We Work Remotely. 38 applications in the first two days.');
  await logTime('emma', jobPost, 60, at(-9));
  await review(owner, jobPost, at(-9, 3), 'accept');

  const plan = await by(agent, () => createPlan(db, agentId,
    `Launch the new northwind.studio by ${localDate(at(14), 'Europe/London')}, case studies first`, agent));
  const planSource = { title: 'Relaunch kick-off call', quote: 'Case studies bring most of our leads — move them first, the blog can wait.' };
  const step = (input: Omit<TaskInput, 'planId' | 'project'>, when: Date) =>
    put(agent, { ...input, planId: plan.id, project: web.id }, when, planSource);
  const collect = await step({
    title: 'Collect the case study copy from the project leads', assigneeUserId: ids.emma, dueDate: due(-6, 'emma'), release: true,
    description: 'Ask each project lead for the final copy and three images of their case study. Twelve case studies in total; the list is in /Relaunch/Case studies.',
    why: 'The CMS migration cannot start until the copy is final.',
    doneCriteria: 'All twelve case studies have final copy and images in the shared folder.',
  }, at(-8));
  const migrate = await step({
    title: 'Move the case studies into the new CMS', assigneeUserId: ids.emma, dueDate: due(1, 'emma'),
    description: 'One entry per case study in the new CMS: copy, images, client logo, tags. Follow the field guide in /Relaunch/CMS.',
    why: 'Case studies bring most of the inbound leads — they go live first.',
    doneCriteria: 'All twelve case studies are published on staging and look right on mobile.',
  }, at(-8));
  // Черновик плана, который агент ещё не выпустил: шаг зависит от результата миграции.
  await step({
    title: 'Proofread the migrated case studies', assigneeUserId: ids.emma, dueDate: due(3, 'emma'),
    description: 'Read every case study on staging against the source copy. Fix typos directly in the CMS; list anything bigger.',
    why: 'Copy-paste into a new CMS breaks formatting and loses words — clients will notice.',
    doneCriteria: 'Every case study read once; the list of bigger issues is in the result.',
  }, at(-8));
  const qa = await step({
    title: 'Run the pre-launch QA pass on staging', assigneeUserId: ids.mehmet, dueDate: due(5, 'mehmet'),
    activateAt: at(3).toISOString(),
    description: 'Go through the QA checklist in /Relaunch/QA: forms, redirects, mobile layout, page speed on the three key pages.',
    why: 'Launch day is not the day to find a broken contact form.',
    doneCriteria: 'The checklist is filled in; anything failing has its own task.',
  }, at(-8));
  // Выпуск с отложенной датой: шаг ждёт своего дня в `scheduled`.
  await by(agent, () => releaseStep(db, qa.id, agent, at(-8)));

  await take(emma, collect, at(-8, 2));
  await submit(emma, collect, at(-6), 'All twelve are in /Relaunch/Case studies. Two leads sent new images; the rest reused the old ones.');
  await logTime('emma', collect, 210, at(-6));
  await review(agent, collect, at(-5), 'accept');
  await by(agent, () => releaseStep(db, migrate.id, agent, at(-5, 1)));
  await by(agent, () => logDecision(db, plan.id, agentId,
    'Migrate the case studies before the blog: they bring most of the inbound leads, the blog brings almost none.',
    'Migrate the blog first (more pages, less value); migrate everything at once (too much for one person in two weeks).'));

  const hero = await put(owner, {
    title: 'Draft the homepage hero copy', assigneeUserId: ids.emma, dueDate: due(-2, 'emma'), project: web.id,
    description: 'A headline and one sentence under it for the new home page. Three options; say which one you would pick.',
    why: 'The hero is the first thing a prospect reads — the current one says "digital solutions" and means nothing.',
    doneCriteria: 'Three options in the result, one marked as your pick.',
    expectedResult: { type: 'text', required: true },
  }, at(-4), { title: chat(-4), quote: 'Our homepage says nothing. Can Emma try a few headlines?' });
  // «Взял» на деле из очереди снимает с «Сейчас» шаг плана — он возвращается в очередь.
  await take(emma, hero, at(-4, 1));
  await submit(emma, hero, at(-3), '1) Websites that win you better clients. 2) Design that sells, built to last. 3) Your next client is already looking. My pick: 1.');
  await logTime('emma', hero, 90, at(-3));
  await review(owner, hero, at(-2), 'rework', 'Close. Option 1 works but keep the headline under eight words and drop "better" — say what kind of clients.');

  await take(emma, migrate, at(0, -3));
  await by(emma, () => startTimer(db, ids.emma, migrate.id, at(0, -3)));
  await by(emma, () => stopTimer(db, ids.emma, at(0, -1)));
  await logTime('emma', migrate, 150, at(-1));
  await comment(ids.emma, migrate, 'Seven of twelve are done. The Harbour & Co one has no client logo — asked their marketing team.', at(0, -1));
  await by(agent, () => addComment(db, migrate.id, agent, 'Thanks. If the logo is not there by Thursday, publish without it and add a follow-up step.'));

  await put(owner, {
    title: 'Write alt text for the 24 homepage images', assigneeUserId: ids.emma, dueDate: due(3, 'emma'), project: web.id,
    description: 'One short sentence per image describing what is in it; the image list is in /Relaunch/Home. Skip decorative images, mark them "decorative".',
    why: 'Screen reader users get nothing from the current home page, and the accessibility audit will check it.',
    doneCriteria: 'Every homepage image has alt text or is marked decorative in the CMS.',
  }, at(0), { title: chat(0), quote: 'Alt text is still missing everywhere on the home page.' });

  // ---- Мехмет: закрытое дело, ожидание внешнего, сдача на приёмку, вопрос без ответа, отказ
  const dns = await put(owner, {
    title: 'Move DNS for northwind.studio to Cloudflare', assigneeUserId: ids.mehmet, project: general.id, dueDate: due(-10, 'mehmet'),
    description: 'Copy every record from the current registrar to Cloudflare, lower TTLs to 300 first, then switch the nameservers.',
    why: 'We need Cloudflare in front of the new site for caching and for painless redirects.',
    doneCriteria: 'Nameservers point to Cloudflare; mail and the old site still work.',
  }, at(-12), { title: chat(-12), quote: 'Let us put Cloudflare in front of everything before the relaunch.' });
  await take(mehmet, dns, at(-12, 1));
  await submit(mehmet, dns, at(-11), 'Nameserver değişikliği tamamlandı. E-posta ve eski site sorunsuz çalışıyor, TTL 300.');
  await logTime('mehmet', dns, 45, at(-11));
  await review(owner, dns, at(-11, 2), 'accept');

  const ssl = await put(owner, {
    title: 'Get the SSL certificate for the staging domain', assigneeUserId: ids.mehmet, dueDate: due(-4, 'mehmet'), project: web.id,
    description: 'staging.northwind.studio needs a certificate; our host issues it through a support ticket, not automatically.',
    why: 'Clients will review the new site on staging — a browser warning there kills the demo.',
    doneCriteria: 'https://staging.northwind.studio opens without a warning.',
  }, at(-6), { title: chat(-6), quote: 'Staging shows a certificate warning — fix before we send it to anyone.' });
  await take(mehmet, ssl, at(-6, 1));
  await by(mehmet, () => transition(db, ssl.id, 'wait_external', mehmet, {
    now: at(-5), waitingFor: 'Hosting support, ticket #48213', checkAt: at(1),
  }));

  const video = await put(owner, {
    title: 'Compress the hero video under 5 MB', assigneeUserId: ids.mehmet, dueDate: due(-1, 'mehmet'), project: web.id,
    description: 'The hero video is 8.2 MB. Re-encode it (H.265 + WebM fallback), keep it 1080p and under 5 MB; the source is in /Relaunch/Video.',
    why: 'It is the heaviest thing on the home page and the main reason the mobile score is 41.',
    doneCriteria: 'Both files are under 5 MB and uploaded to staging; the size of each is in the result.',
    expectedResult: { type: 'text', required: true },
  }, at(-4), { title: chat(-4), quote: 'The video alone is eight megabytes. Get it under five.' });
  await take(mehmet, video, at(-4, 1));

  const redirects = await put(owner, {
    title: 'Set up 301 redirects from the old URLs', assigneeUserId: ids.mehmet, dueDate: due(-1, 'mehmet'), project: web.id,
    description: 'Map every old URL from the sitemap export (/Relaunch/SEO/old-urls.csv) to its new address and add the redirects in Cloudflare.',
    why: 'Old links from clients and Google must not end in a 404 on launch day.',
    doneCriteria: 'Every URL in the export redirects with 301 to a live page.',
  }, at(-3), { title: chat(-3), quote: 'Do not lose the Google traffic — every old link has to land somewhere.' });
  const german = await put(owner, {
    title: 'Translate the pricing page into German', assigneeUserId: ids.mehmet, project: general.id, dueDate: due(2, 'mehmet'),
    description: 'The pricing page copy is in /Relaunch/Copy/pricing.md. Translate it for the new German version of the site.',
    why: 'Two leads from Munich asked for prices in German last month.',
    doneCriteria: 'German copy is in /Relaunch/Copy/pricing.de.md.',
  }, at(-3), { title: chat(-3), quote: 'Maybe Mehmet can do the German pricing page?' });
  await by(mehmet, () => transition(db, german.id, 'decline', mehmet, {
    now: at(-3, 2), text: 'Almanca bilmiyorum, çeviri kalitesini garanti edemem. Profesyonel bir çevirmen daha doğru olur.',
  }));

  await submit(mehmet, video, at(-2), 'MP4 (H.265): 3,9 MB, WebM: 4,4 MB. İkisi de staging\'e yüklendi, 1080p korundu.');
  await logTime('mehmet', video, 200, at(-2));
  // Сдал видео — очередь выдала редиректы; вопрос по ним ждёт ответа владельца.
  await take(mehmet, redirects, at(-2, 1));
  await by(mehmet, () => transition(db, redirects.id, 'question', mehmet, {
    now: at(-2, 3),
    text: 'Eski /blog adresleri nereye yönlenmeli: blog.northwind.studio mu, yoksa yeni /journal sayfası mı?',
  }));

  // ---- Линь: закрытый проект найма, отменённое дело, «Сейчас» и очередь
  const salaries = await put(owner, {
    title: 'Collect salary benchmarks for front-end roles', assigneeUserId: ids.linh, dueDate: due(-5, 'linh'), project: hiring.id,
    description: 'Mid-level front-end developer, remote: ranges for the UK, Turkey and Vietnam from at least two sources each.',
    why: 'The job post needs a salary range, and we hire remotely.',
    doneCriteria: 'A table with a range per country and the sources.',
    expectedResult: { type: 'text', required: true },
  }, at(-7), { title: chat(-7), quote: 'What do we have to pay a mid-level front-end dev in each country?' });
  await take(linh, salaries, at(-7, 1));
  await submit(linh, salaries, at(-6), 'Bảng đã có trong /Hiring/Salaries: Anh £45–55k, Thổ Nhĩ Kỳ $24–32k, Việt Nam $18–26k. Nguồn: Glassdoor, Levels.fyi, ITviec.');
  await logTime('linh', salaries, 120, at(-6));
  await review(owner, salaries, at(-5), 'accept');

  const booth = await put(owner, {
    title: 'Book a booth at Web Summit', assigneeUserId: ids.linh, project: general.id, dueDate: due(10, 'linh'),
    description: 'Get a quote for the smallest startup booth and hold a slot. Do not pay anything yet.',
    why: 'Web Summit brought us two clients last year.',
    doneCriteria: 'A quote and a held slot, both in the result.',
  }, at(-4), { title: chat(-4), quote: 'Should we go to Web Summit again?' });
  await by(owner, () => cancelTask(db, booth.id, owner, 'The budget moved to the relaunch; we skip events this quarter.', at(-3)));

  const screen = await put(owner, {
    title: 'Screen the 14 front-end applications', assigneeUserId: ids.linh, dueDate: due(0, 'linh'), project: hiring.id,
    description: 'Applications are in /Hiring/Applicants. Mark each yes / maybe / no with one line why; look at the portfolio first, the CV second.',
    why: 'We want first interviews next week, and Alex has time for five at most.',
    doneCriteria: 'All fourteen marked; the five strongest are listed in the result.',
  }, at(-2), { title: chat(-2), quote: 'Fourteen applications so far — Linh, can you do the first pass?' });
  await comment(ownerId, screen, 'Prioritise people with Next.js experience — that is what the relaunch runs on.', at(-2, 1));
  await comment(ids.linh, screen, 'Mình đã xem 6 hồ sơ, có 2 bạn rất tốt về Next.js. Chiều mai mình gửi danh sách đầy đủ.', at(-1, 2));
  // Реплика исполнителя начала дело сама (спека auto-start); на сегодня Линь его остановила, и
  // очередь вернула его в «Сейчас» — с отметкой «начата автоматически».
  await by(linh, () => stopTask(db, screen.id, ids.linh, { now: at(-1, 3) }));
  await put(owner, {
    title: 'Prepare the take-home assignment', assigneeUserId: ids.linh, dueDate: due(4, 'linh'), project: hiring.id,
    description: 'A two-hour task: build one case study page from our Figma file. Write the brief and the scoring sheet.',
    why: 'Portfolios do not show how someone works with a real design and a deadline.',
    doneCriteria: 'Brief and scoring sheet are in /Hiring/Assignment, reviewed by Emma.',
  }, at(-1), { title: chat(-1), quote: 'We need a small test task for the shortlisted people.' });

  // ---- Дмитрий: приглашён, дело ждёт своей даты
  await put(owner, {
    title: 'Review the accessibility of the new templates', assigneeUserId: ids.dmitry, dueDate: due(4, 'dmitry'), project: web.id,
    activateAt: at(2).toISOString(),
    description: 'Check the home, case study and contact templates on staging against WCAG 2.2 AA. Screen reader and keyboard only.',
    why: 'Two of our clients are public bodies — accessibility is in their contracts.',
    doneCriteria: 'A list of issues per template, each with its WCAG criterion.',
  }, at(0), { title: chat(0), quote: 'Dmitry can audit the templates once staging is stable.' });

  // ---- владелец: ожидания и личное дело
  const logos = await by(owner, () => createTask(db, {
    kind: 'waiting', title: 'Final logo files from the brand designer', assigneeUserId: ownerId, project: web.id,
    why: 'The new header and favicon use the new logo.',
    waiting: { waitingFor: 'Sara Lind, brand designer', expectedAt: at(-3).toISOString(), contact: 'sara@lindstudio.example' },
  }, owner, at(-6)));
  await by(owner, () => resolveWaiting(db, logos.id, owner, at(-3)));
  await by(owner, () => createTask(db, {
    kind: 'waiting', title: 'Signed contract from Brightline Coffee', assigneeUserId: ownerId, project: general.id,
    why: 'The Brightline rebrand starts only after the contract is signed — it books Emma and Mehmet for November.',
    waiting: { waitingFor: 'Brightline Coffee, legal team', expectedAt: at(5).toISOString(), onArrival: 'Tell Emma to schedule the kick-off.' },
  }, owner, at(-2)));
  await by(owner, () => createTask(db, {
    title: 'Renew the northwind.studio and northwind.co.uk domains', assigneeUserId: ownerId, project: notes.id,
    dueDate: due(6, 'owner'), priority: 'urgent',
  }, owner, at(-1)));

  // `set_agent_note`: своей функции в ядре нет — тот же запрос, что у инструмента.
  await db.query(
    `insert into agent_notes(org_id, agent_id, key, value, updated_at) values (current_setting('app.org_id')::uuid, $1, $2, $3, now())
     on conflict (org_id, agent_id, key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [agentId, 'people', 'Emma answers within the hour; Mehmet prefers one clear question at a time and writes in Turkish.'],
  );

  // Таймеры наполнения — от «Взять» до «Сдать», а между ними в сценарии дни: отчёт по времени
  // показывал ревьюеру по 23–47 часов на дело (каталог ChatGPT, 02.10.2026), а открытый таймер дела
  // в работе рос бы всё время рецензии. Часы людей демо несут записи `log_work` (addManual выше).
  await db.query(`delete from time_entries where org_id = current_setting('app.org_id')::uuid and source = 'timer'`);

  // ---------------------------------------------------------------- сводка
  await setActor(db, ownerId);
  const byStatus = Object.fromEntries((await db.query(
    `select status, count(*)::int as n from tasks group by status order by status`)).rows.map((r) => [r.status, r.n])) as Record<string, number>;
  const people = (await db.query(
    `select u.display_name as name, e.email::text as email, u.language, m.role, m.status
       from memberships m join users u on u.id = m.user_id join user_emails e on e.user_id = u.id and e.is_primary
      where m.org_id = $1 and m.user_id <> $2 order by u.display_name`, [orgId, ownerId])).rows as DemoSummary['people'];
  const projects = (await db.query(`select key, name, private from projects order by created_at, key`)).rows as DemoSummary['projects'];
  return {
    org_id: orgId,
    company: DEMO_COMPANY,
    owner: { email: DEMO_OWNER_EMAIL, user_id: ownerId },
    people,
    projects,
    tasks: { total: Object.values(byStatus).reduce((s, n) => s + n, 0), by_status: byStatus },
    wiped,
  };
}
