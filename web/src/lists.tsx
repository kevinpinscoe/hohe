// Task Dump (page 2), C Review (page 3) and Plan My Day.

import { useState } from 'preact/hooks';
import { addDays, daysBetween, relativeLabel, shortLabel } from './dates';
import type { Ctx } from './ctx';
import { SuggestionCard } from './day';
import { intents } from './intents';
import { ageDays, carriedCount, liveSuggestion, openPlacement, placementsOn, sortForDay, taskById, type Letter, type Task } from './model';
import { PendingBadge } from './status';

type DumpFilter = 'captured' | 'unscheduled' | 'waiting' | 'all' | 'deleted';

export function DumpPage(props: { ctx: Ctx }) {
  const { ctx } = props;
  const { s } = ctx;
  const [filter, setFilter] = useState<DumpFilter>('captured');
  const [letter, setLetter] = useState<Letter | 'any'>('any');

  const unscheduled = (t: Task) => t.state === 'active' && !openPlacement(s, t.id);
  const sets: Record<DumpFilter, Task[]> = {
    captured: s.tasks.filter((t) => unscheduled(t) && t.priority === null),
    unscheduled: s.tasks.filter((t) => unscheduled(t) && t.priority !== null && (letter === 'any' || t.priority === letter)),
    waiting: s.tasks.filter((t) => t.state === 'waiting'),
    all: s.tasks.filter((t) => t.state === 'active' || t.state === 'waiting'),
    deleted: s.tasks.filter((t) => t.state === 'deleted'),
  };
  const counts = (f: DumpFilter) => (f === 'unscheduled' ? s.tasks.filter((t) => unscheduled(t) && t.priority !== null).length : sets[f].length);
  const label: Record<DumpFilter, string> = {
    captured: 'Captured',
    unscheduled: 'Unscheduled',
    waiting: 'Waiting',
    all: 'All open',
    deleted: 'Recently deleted',
  };

  return (
    <section class="page single">
      <h2>Task Dump</h2>
      <p class="muted">
        Everything lands here first, with no letter or day needed. Triaged tasks without a day stay here too.
      </p>
      <div class="filters" role="tablist">
        {(Object.keys(label) as DumpFilter[]).map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} class={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
            {label[f]} <span class="count">{counts(f)}</span>
          </button>
        ))}
      </div>
      {filter === 'unscheduled' && (
        <div class="filters sub">
          {(['any', 'A', 'B', 'C'] as const).map((l) => (
            <button key={l} class={`chip ${letter === l ? 'on' : ''}`} onClick={() => setLetter(l)}>
              {l === 'any' ? 'Any letter' : l}
            </button>
          ))}
        </div>
      )}
      <ul class="dump-list">
        {sets[filter].length === 0 && <li class="empty">Nothing here.</li>}
        {sets[filter].map((t) => (
          <DumpRow key={t.id} ctx={ctx} t={t} deleted={filter === 'deleted'} />
        ))}
      </ul>
    </section>
  );
}

function DumpRow(props: { ctx: Ctx; t: Task; deleted: boolean }) {
  const { ctx, t } = props;
  const { s } = ctx;
  const open = openPlacement(s, t.id);
  return (
    <li class="dump-row">
      <span class={`rank static letter-${t.priority ?? 'none'}`}>{t.priority ?? '—'}</span>
      <div class="title-cell">
        <span class="title">{t.title}</span>
        <span class="badges">
          {open && <span class="badge">on {relativeLabel(open.day, s.today).toLowerCase()}</span>}
          {t.state === 'waiting' && (
            <span class="badge status">
              G✓ {t.delegate} · check {relativeLabel(t.followUp!, s.today).toLowerCase()}
            </span>
          )}
          {t.deadline && <span class="badge deadline">due {relativeLabel(t.deadline, s.today).toLowerCase()}</span>}
          {props.deleted && t.deletedDay && <span class="badge">deleted {relativeLabel(t.deletedDay, s.today).toLowerCase()}</span>}
          <PendingBadge ctx={ctx} taskId={t.id} />
        </span>
      </div>
      {props.deleted ? (
        <button class="btn small" onClick={() => ctx.act(intents.restore(t.id), 'Restored')}>
          Restore
        </button>
      ) : t.state === 'waiting' ? null : (
        <span class="row-actions">
          <button class="btn small primary" onClick={() => ctx.open({ kind: 'assign', taskId: t.id })}>
            Assign
          </button>
          <button class="icon-btn more" aria-label={`Actions for ${t.title}`} onClick={() => ctx.open({ kind: 'actions', taskId: t.id })}>
            ⋯
          </button>
        </span>
      )}
    </li>
  );
}

export function ReviewPage(props: { ctx: Ctx }) {
  const { ctx } = props;
  const { s } = ctx;
  const cTasks = s.tasks.filter((t) => t.priority === 'C' && (t.state === 'active' || t.state === 'waiting'));
  const unscheduled = cTasks.filter((t) => !openPlacement(s, t.id) && t.state === 'active');
  const scheduled = cTasks.filter((t) => openPlacement(s, t.id));
  const suggestion = liveSuggestion(s, 'suggestion');
  const monthStart = s.today.slice(0, 8) + '01';
  const plannedThisMonth = new Set(
    s.placements.filter((p) => p.letter === 'C' && p.by === 'kevin' && p.day >= monthStart).map((p) => p.taskId),
  ).size;
  const doneThisMonth = s.tasks.filter((t) => t.priority === 'C' && t.state === 'completed' && (t.completedDay ?? '') >= monthStart).length;

  return (
    <section class="page single">
      <h2>C Review</h2>
      <p class="muted">
        C means it needs doing, just not vitally or importantly. Planning a C task keeps it C.
      </p>
      <p class="summary">
        This month you planned {plannedThisMonth} C tasks and finished {doneThisMonth}.
      </p>
      {suggestion ? (
        <SuggestionCard ctx={ctx} taskId={suggestion.taskId} day={suggestion.day} reason={suggestion.reason} inline />
      ) : (
        <p class="note">No suggestion right now. Mark a coming day as "Room available" to get one.</p>
      )}
      <h3 class="sub">No day yet ({unscheduled.length})</h3>
      <ul class="dump-list">
        {unscheduled.length === 0 && <li class="empty">Nothing here.</li>}
        {unscheduled
          .sort((a, b) => ageDays(s, b) - ageDays(s, a))
          .map((t) => (
            <ReviewRow key={t.id} ctx={ctx} t={t} />
          ))}
      </ul>
      <h3 class="sub">Planned ({scheduled.length})</h3>
      <ul class="dump-list">
        {scheduled.length === 0 && <li class="empty">Nothing here.</li>}
        {scheduled.map((t) => (
          <ReviewRow key={t.id} ctx={ctx} t={t} />
        ))}
      </ul>
    </section>
  );
}

function ReviewRow(props: { ctx: Ctx; t: Task }) {
  const { ctx, t } = props;
  const { s } = ctx;
  const open = openPlacement(s, t.id);
  const carried = carriedCount(s, t.id);
  const snoozed = s.snoozes[t.id] && s.snoozes[t.id] > s.today;
  return (
    <li class="dump-row">
      <span class="rank static letter-C">C</span>
      <div class="title-cell">
        <span class="title">{t.title}</span>
        <span class="badges">
          <span class="badge">{ageDays(s, t)} days old</span>
          {open && <span class="badge">planned {relativeLabel(open.day, s.today).toLowerCase()}</span>}
          {t.deadline && <span class="badge deadline">due {relativeLabel(t.deadline, s.today).toLowerCase()}</span>}
          {carried > 0 && <span class="badge carried">carried ×{carried}</span>}
          {t.effort && <span class="badge effort">{t.effort === 'S' ? 'small' : t.effort === 'M' ? 'medium' : 'large'}</span>}
          {snoozed && <span class="badge">snoozed to {shortLabel(s.snoozes[t.id])}</span>}
          <PendingBadge ctx={ctx} taskId={t.id} />
        </span>
      </div>
      <span class="row-actions wrap">
        <button class="btn small primary" onClick={() => ctx.open({ kind: 'plan', taskId: t.id })}>
          {open ? 'Re-plan' : 'Plan it'}
        </button>
        <button class="btn small" onClick={() => ctx.act(intents.complete(t.id), `Done: ${t.title}`, { undo: intents.reopen(t.id) })}>
          Done already
        </button>
        <button class="icon-btn more" aria-label={`More actions for ${t.title}`} onClick={() => ctx.open({ kind: 'actions', taskId: t.id })}>
          ⋯
        </button>
        {!open && (
          <button class="btn small quiet" onClick={() => ctx.act(intents.snooze(t.id), 'Snoozed')}>
            Snooze
          </button>
        )}
      </span>
    </li>
  );
}

/** The deliberate daily review. Skippable; never a wall. */
export function PlanMyDay(props: { ctx: Ctx; onFinish: () => void }) {
  const { ctx } = props;
  const { s } = ctx;
  const today = placementsOn(s, s.today);
  const carriedIn = today.filter((p) => p.outcome === null && p.by === 'rollover' && !p.touched);
  const planned = sortForDay(today.filter((p) => p.outcome === null && !(p.by === 'rollover' && !p.touched)));
  const deadlines = s.tasks.filter(
    (t) => t.state === 'active' && !openPlacement(s, t.id) && t.deadline && daysBetween(s.today, t.deadline) <= (s.settings.deadlineWindowDays || 7),
  );
  const suggestion = liveSuggestion(s, 'suggestion');

  return (
    <div class="overlay">
      <div class="sheet wide" role="dialog" aria-modal="true" aria-label="Plan my day">
        <div class="sheet-head">
          <h2>Plan my day · {shortLabel(s.today)}</h2>
          <button class="btn small quiet" onClick={props.onFinish}>
            Skip for now
          </button>
        </div>

        <h3 class="sub">Carried in ({carriedIn.length})</h3>
        {carriedIn.length === 0 && <p class="muted">Nothing carried in. Nice.</p>}
        <ul class="dump-list">
          {carriedIn.map((p) => {
            const t = taskById(s, p.taskId);
            return (
              <li key={p.id} class="dump-row">
                <span class={`rank static letter-${p.letter ?? 'none'}`}>{p.letter ?? '—'}</span>
                <div class="title-cell">
                  <span class="title">{t.title}</span>
                  <span class="badges">
                    <span class="badge carried">carried ×{carriedCount(s, t.id)}</span>
                  </span>
                </div>
                <span class="row-actions wrap">
                  <button class="btn small primary" onClick={() => ctx.act(intents.keepToday(t.id), 'Kept for today', { keepOpen: true })}>
                    Keep today
                  </button>
                  <button class="btn small" onClick={() => ctx.open({ kind: 'forward', taskId: t.id })}>
                    Pick a day
                  </button>
                  <button class="btn small" onClick={() => ctx.act(intents.backToDump(t.id), 'Back in the Dump', { keepOpen: true })}>
                    Back to Dump
                  </button>
                  <button class="btn small" onClick={() => ctx.open({ kind: 'delegate', taskId: t.id })}>
                    Delegate
                  </button>
                  <button class="btn small quiet" onClick={() => ctx.act(intents.delete(t.id), 'Deleted', { keepOpen: true, undo: intents.restore(t.id) })}>
                    Delete
                  </button>
                </span>
              </li>
            );
          })}
        </ul>

        <h3 class="sub">Already planned for today ({planned.length})</h3>
        <p class="muted">{planned.map((p) => `${p.letter ?? '—'}${p.rank ?? ''} ${taskById(s, p.taskId).title}`).slice(0, 6).join(' · ')}{planned.length > 6 ? ' …' : ''}</p>

        {deadlines.length > 0 && (
          <>
            <h3 class="sub">Deadlines coming up, no day yet</h3>
            <ul class="dump-list">
              {deadlines.map((t) => (
                <li key={t.id} class="dump-row">
                  <span class={`rank static letter-${t.priority ?? 'none'}`}>{t.priority ?? '—'}</span>
                  <div class="title-cell">
                    <span class="title">{t.title}</span>
                    <span class="badges">
                      <span class="badge deadline">due {relativeLabel(t.deadline!, s.today).toLowerCase()}</span>
                    </span>
                  </div>
                  <button class="btn small" onClick={() => ctx.open({ kind: 'plan', taskId: t.id, suggestedDay: addDays(s.today, 0) })}>
                    Plan it
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {suggestion && <SuggestionCard ctx={ctx} taskId={suggestion.taskId} day={suggestion.day} reason={suggestion.reason} inline />}

        <div class="sheet-actions">
          <button class="btn primary" onClick={props.onFinish}>
            Go to my day
          </button>
        </div>
      </div>
    </div>
  );
}
