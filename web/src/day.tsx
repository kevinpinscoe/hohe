// The daily page: the Prioritized Daily Task List for one planner day.

import { useState } from 'preact/hooks';
import {
  addDays,
  makeDay,
  monthLong,
  monthShape,
  monthShort,
  parts,
  relativeLabel,
  shortLabel,
  weekdayLong,
  weekdayShort,
  type Day,
} from './dates';
import type { Ctx } from './ctx';
import { intents } from './intents';
import { carriedCount, carrySpan, liveSuggestion, placementsOn, sortForDay, taskById, type Designation, type Placement } from './model';
import { PendingBadge } from './status';

export function DayPage(props: { ctx: Ctx }) {
  const { ctx } = props;
  const { s, viewDay } = ctx;
  const [reorder, setReorder] = useState(false);
  const [draft, setDraft] = useState('');
  // Completed and deleted entries are left off the list: a checked-off task disappears (POE-85).
  const list = sortForDay(placementsOn(s, viewDay).filter((p) => p.outcome !== 'deleted' && p.outcome !== 'completed'));
  const aCount = list.filter((p) => p.letter === 'A' && p.outcome === null).length;
  const isToday = viewDay === s.today;
  const isPast = viewDay < s.today;
  const suggestion = isToday ? liveSuggestion(s, 'card') : null;
  const rolloverWaiting = isToday && s.serverDay < s.today;

  const add = async () => {
    if (!draft.trim()) return;
    if (await ctx.act(intents.addToDay(draft, viewDay), `Added to ${relativeLabel(viewDay, s.today)}`)) setDraft('');
  };

  return (
    <div class="spread">
      <section class="page left-page">
        <DayHeader ctx={ctx} />
        <MonthCalendar ctx={ctx} />
        <DayMark ctx={ctx} />
        <Legend />
      </section>
      <section class="page right-page">
        <div class="list-head">
          <h2>
            <span class="abc">ABC</span> Prioritized Daily Task List
          </h2>
          {!isPast && (
            <button class={`btn small ${reorder ? 'primary' : ''}`} onClick={() => setReorder(!reorder)}>
              {reorder ? 'Done reordering' : 'Reorder'}
            </button>
          )}
        </div>
        {isPast && <p class="note">A past day. Closed entries stay exactly as they ended; completed ones are not shown.</p>}
        {rolloverWaiting && (
          <p class="note">
            The server has not rolled over to today yet (it is still on {shortLabel(s.serverDay)}). Unfinished tasks carry over
            when it is reachable.
          </p>
        )}
        {reorder && (
          <p class="note">
            Move open tasks within their letter. Numbers held by completed (hidden) or closed entries stay put, so nothing is numbered
            twice.
          </p>
        )}
        {aCount > (s.settings.aWarning || 4) && (
          <p class="note warn">
            {aCount} A tasks today. If everything is vital, nothing is. Could one wait or become a B?
          </p>
        )}
        <ol class="pdtl">
          {list.length === 0 && <li class="empty">Nothing planned for this day.</li>}
          {list.map((pl) => (
            <TaskRow key={pl.id} ctx={ctx} pl={pl} reorder={reorder && pl.outcome === null} />
          ))}
        </ol>
        {!isPast && (
          <form
            class="add-row"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <input
              value={draft}
              aria-label={`Add a task to ${relativeLabel(viewDay, s.today)}`}
              placeholder={`Add to ${relativeLabel(viewDay, s.today).toLowerCase()}… (try "B2 Call the bank")`}
              onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
            />
            <button class="btn" type="submit">
              Add
            </button>
          </form>
        )}
        {suggestion && <SuggestionCard ctx={ctx} taskId={suggestion.taskId} day={suggestion.day} reason={suggestion.reason} />}
      </section>
    </div>
  );
}

function DayHeader(props: { ctx: Ctx }) {
  const { s, viewDay, go } = props.ctx;
  const { y, m, d } = parts(viewDay);
  return (
    <div class="day-header">
      <div class="big-date">{d}</div>
      <div>
        <div class="weekday">{weekdayLong(viewDay)}</div>
        <div class="month-year">
          {monthLong(m)} {y}
        </div>
        <div class="day-nav">
          <button class="btn small" aria-label="Previous day" onClick={() => go('today', addDays(viewDay, -1))}>
            ‹
          </button>
          {viewDay !== s.today && (
            <button class="btn small" onClick={() => go('today', s.today)}>
              Today
            </button>
          )}
          <button class="btn small" aria-label="Next day" onClick={() => go('today', addDays(viewDay, 1))}>
            ›
          </button>
        </div>
      </div>
    </div>
  );
}

function MonthCalendar(props: { ctx: Ctx }) {
  const { s, viewDay, go } = props.ctx;
  const { y, m } = parts(viewDay);
  const { firstWeekday, length } = monthShape(y, m);
  const cells: (number | null)[] = [...Array(firstWeekday).fill(null), ...Array.from({ length }, (_, i) => i + 1)];
  const busy = new Set(s.placements.filter((p) => p.outcome !== 'deleted' && p.outcome !== 'completed').map((p) => p.day));
  const tabMonth = (mm: number) => (mm === parts(s.today).m && y === parts(s.today).y ? s.today : makeDay(y, mm, 1));
  return (
    <div class="calendar-block">
      <nav class="month-tabs" aria-label="Months">
        <button class="year-btn" aria-label="Previous year" onClick={() => go('today', makeDay(y - 1, m, 1))}>
          ‹ {y - 1}
        </button>
        {Array.from({ length: 12 }, (_, i) => i + 1).map((mm) => (
          <button key={mm} class={`month-tab ${mm === m ? 'on' : ''}`} onClick={() => go('today', tabMonth(mm))}>
            {monthShort(mm)}
          </button>
        ))}
        <button class="year-btn" aria-label="Next year" onClick={() => go('today', makeDay(y + 1, m, 1))}>
          {y + 1} ›
        </button>
      </nav>
      <table class="month">
        <caption>
          {monthLong(m)} {y}
        </caption>
        <thead>
          <tr>
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w, i) => (
              <th key={i} scope="col">
                {w}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: Math.ceil(cells.length / 7) }, (_, row) => (
            <tr key={row}>
              {cells.slice(row * 7, row * 7 + 7).map((c, i) => {
                if (c === null) return <td key={i} />;
                const day = makeDay(y, m, c);
                const cls = [day === viewDay ? 'sel' : '', day === s.today ? 'today' : '', busy.has(day) ? 'busy' : ''].join(' ');
                return (
                  <td key={i}>
                    <button class={`cal-day ${cls}`} aria-label={shortLabel(day)} onClick={() => go('today', day)}>
                      {c}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DayMark(props: { ctx: Ctx }) {
  const { ctx } = props;
  const { s, viewDay } = ctx;
  if (viewDay < s.today) return null;
  const cur = s.designations[viewDay] ?? null;
  const opt = (d: Designation | null, label: string) => (
    <button
      class={`chip ${cur === d ? 'on' : ''}`}
      onClick={() => ctx.act(intents.designate(viewDay, d ?? ''), d ? `Marked ${label.toLowerCase()}` : 'Mark cleared', { keepOpen: true })}
    >
      {label}
    </button>
  );
  return (
    <div class="designation">
      <span class="muted">This day:</span>
      {opt('room', 'Room available')}
      {opt('full', 'Full')}
      {opt('rest', 'Rest')}
      {opt(null, 'Unmarked')}
    </div>
  );
}

function Legend() {
  return (
    <ul class="legend" aria-label="Marks">
      <li>
        <span>→</span> Forwarded or carried
      </li>
      <li>
        <span>G✓</span> Delegated
      </li>
      <li>
        <span>●</span> In progress
      </li>
    </ul>
  );
}

function TaskRow(props: { ctx: Ctx; pl: Placement; reorder: boolean }) {
  const { ctx, pl } = props;
  const { s } = ctx;
  const t = taskById(s, pl.taskId);
  const closed = pl.outcome !== null;
  const span = carrySpan(s, pl);
  const carried = pl.outcome === null ? carriedCount(s, t.id) : 0;
  const rank = pl.letter ? `${pl.letter}${pl.rank ?? ''}` : '—';
  const editable = !closed && pl.day >= s.today;

  let status = '';
  if (pl.outcome === 'carried') status = `→ carried to ${weekdayShort(pl.target!)}`;
  if (pl.outcome === 'forwarded') status = `→ forwarded to ${shortLabel(pl.target!)}`;
  if (pl.outcome === 'delegated') status = `G✓ ${t.delegate} · check ${relativeLabel(pl.target!, s.today).toLowerCase()}`;
  if (pl.outcome === 'returned') status = '↩ back to the Dump';

  return (
    <li class={`row ${closed ? 'closed' : ''} outcome-${pl.outcome ?? 'open'}`}>
      {/* Completed rows are not rendered (POE-85); the toast's Undo is the way back. */}
      <button
        class="check"
        role="checkbox"
        aria-checked={false}
        aria-label={`Complete: ${t.title}`}
        disabled={closed}
        onClick={() => {
          if (!closed) ctx.act(intents.complete(t.id), `Done: ${t.title}`, { undo: intents.reopen(t.id) });
        }}
      ></button>
      <button
        class={`rank letter-${pl.letter ?? 'none'}`}
        aria-label={`Priority ${rank}. Change priority or number`}
        disabled={!editable}
        onClick={() => ctx.open({ kind: 'rank', placementId: pl.id })}
      >
        {rank}
      </button>
      <div class="title-cell">
        <span class="title">
          {pl.inProgress && <span class="dot" aria-label="In progress" />}
          {t.title}
        </span>
        <span class="badges">
          {status && <span class="badge status">{status}</span>}
          {span && <span class="badge span">carried {weekdayShort(span.from)} → {weekdayShort(span.to)}</span>}
          {carried > 0 && <span class="badge carried">carried ×{carried}</span>}
          {t.deadline && !closed && <span class="badge deadline">due {relativeLabel(t.deadline, s.today).toLowerCase()}</span>}
          {t.effort && !closed && <span class="badge effort">{t.effort === 'S' ? 'small' : t.effort === 'M' ? 'medium' : 'large'}</span>}
          <PendingBadge ctx={ctx} taskId={t.id} />
        </span>
      </div>
      {props.reorder && pl.letter ? (
        <span class="move">
          <button class="icon-btn" aria-label="Move up" onClick={() => ctx.act(intents.move(pl.id, -1), undefined, { keepOpen: true })}>
            ↑
          </button>
          <button class="icon-btn" aria-label="Move down" onClick={() => ctx.act(intents.move(pl.id, 1), undefined, { keepOpen: true })}>
            ↓
          </button>
        </span>
      ) : (
        <button class="icon-btn more" aria-label={`Actions for ${t.title}`} disabled={!editable} onClick={() => ctx.open({ kind: 'actions', taskId: t.id })}>
          ⋯
        </button>
      )}
    </li>
  );
}

export function SuggestionCard(props: { ctx: Ctx; taskId: string; day: Day; reason: string; inline?: boolean }) {
  const { ctx, taskId, day, reason } = props;
  const t = taskById(ctx.s, taskId);
  const when = relativeLabel(day, ctx.s.today);
  return (
    <aside class="suggestion" aria-label="Suggestion">
      <p>
        <strong>{when}</strong> has room. Want to plan <em>{t.title}</em> for then? <span class="muted">({reason}, stays C)</span>
      </p>
      <div class="suggestion-actions">
        <button class="btn primary" onClick={() => ctx.open({ kind: 'plan', taskId, suggestedDay: day })}>
          Plan it
        </button>
        <button class="btn" onClick={() => ctx.act(intents.snooze(taskId), 'Snoozed this task')}>
          Snooze this task
        </button>
        <button class="btn" onClick={() => ctx.act(intents.pauseSuggestions(), 'All suggestions paused')}>
          Pause all suggestions
        </button>
        {!props.inline && (
          <button class="btn quiet" onClick={() => ctx.act(intents.dismissCard(), 'Hidden for today')}>
            Dismiss
          </button>
        )}
      </div>
    </aside>
  );
}
