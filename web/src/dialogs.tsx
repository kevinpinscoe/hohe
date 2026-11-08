// Small modal sheets for the action menu and pickers. Each closes itself after acting.

import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { addDays, relativeLabel, shortLabel, type Day } from './dates';
import type { Ctx, DialogSpec } from './ctx';
import { intents } from './intents';
import { openPlacement, rankRefusal, reservedRanks, taskById, type Effort, type Letter } from './model';

function Sheet(props: { title: string; onClose: () => void; children: ComponentChildren }) {
  return (
    <div class="overlay" onClick={props.onClose}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={props.title} onClick={(e) => e.stopPropagation()}>
        <div class="sheet-head">
          <h2>{props.title}</h2>
          <button class="icon-btn" aria-label="Close" onClick={props.onClose}>
            ✕
          </button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

/** Quick day choices plus a date field. */
function DayChoice(props: { today: Day; value: Day | null; onChange: (d: Day | null) => void; allowNone?: boolean }) {
  const quick = [0, 1, 2, 3, 7].map((i) => addDays(props.today, i));
  return (
    <div class="day-choice">
      {props.allowNone && (
        <button class={`chip ${props.value === null ? 'on' : ''}`} onClick={() => props.onChange(null)}>
          No day yet
        </button>
      )}
      {quick.map((d) => (
        <button key={d} class={`chip ${props.value === d ? 'on' : ''}`} onClick={() => props.onChange(d)}>
          {relativeLabel(d, props.today)}
        </button>
      ))}
      <input
        type="date"
        aria-label="Pick a date"
        value={props.value ?? ''}
        min={props.today}
        onInput={(e) => props.onChange((e.target as HTMLInputElement).value || null)}
      />
    </div>
  );
}

function LetterChoice(props: { value: Letter | null; onChange: (l: Letter | null) => void; allowNone?: boolean }) {
  const opts: (Letter | null)[] = props.allowNone ? ['A', 'B', 'C', null] : ['A', 'B', 'C'];
  const label = (l: Letter | null) => (l === 'A' ? 'A · vital' : l === 'B' ? 'B · important' : l === 'C' ? 'C · needs doing' : 'No letter');
  return (
    <div class="letter-choice">
      {opts.map((l) => (
        <button key={String(l)} class={`chip letter-${l ?? 'none'} ${props.value === l ? 'on' : ''}`} onClick={() => props.onChange(l)}>
          {label(l)}
        </button>
      ))}
    </div>
  );
}

export function DialogHost(props: { ctx: Ctx; spec: DialogSpec }) {
  const { ctx, spec } = props;
  const { s } = ctx;
  switch (spec.kind) {
    case 'actions':
      return <ActionMenu ctx={ctx} taskId={spec.taskId} />;
    case 'rank':
      return <RankPicker ctx={ctx} placementId={spec.placementId} />;
    case 'edit':
      return <EditSheet ctx={ctx} taskId={spec.taskId} />;
    case 'forward': {
      const t = taskById(s, spec.taskId);
      return (
        <Sheet title="Forward to another day" onClose={ctx.close}>
          <p class="muted">{t.title}</p>
          <PickDayAndGo ctx={ctx} label="Forward" onGo={(d) => ctx.act(intents.forward(t.id, d), `Forwarded to ${shortLabel(d)}`)} />
        </Sheet>
      );
    }
    case 'plan': {
      const t = taskById(s, spec.taskId);
      return (
        <Sheet title="Plan it" onClose={ctx.close}>
          <p class="muted">
            {t.title} stays <strong>{t.priority ?? 'unlettered'}</strong>. Planning never changes the letter.
          </p>
          <PickDayAndGo
            ctx={ctx}
            initial={spec.suggestedDay ?? s.today}
            label="Plan it"
            onGo={(d) => ctx.act(intents.planIt(t.id, d), `Planned for ${relativeLabel(d, st0(ctx))}; still ${t.priority ?? 'unlettered'}`)}
          />
        </Sheet>
      );
    }
    case 'delegate':
      return <DelegateSheet ctx={ctx} taskId={spec.taskId} />;
    case 'assign':
      return <AssignSheet ctx={ctx} taskId={spec.taskId} />;
    case 'priority': {
      const t = taskById(s, spec.taskId);
      return (
        <Sheet title="Change priority" onClose={ctx.close}>
          <p class="muted">{t.title}</p>
          <p class="hint">Changing the letter is a separate, deliberate choice. The task keeps its day.</p>
          <LetterChoice
            value={t.priority}
            allowNone
            onChange={(l) => ctx.act(intents.changePriority(t.id, l), l ? `Now ${l}` : 'Letter removed')}
          />
        </Sheet>
      );
    }
    case 'about':
      return (
        <Sheet title="About HOHE" onClose={ctx.close}>
          <p>
            HOHE (<em>Hoc opus hodie est</em>, "this is the work today") is an ABC123 daily planner. Changes are saved on this
            device first and sent to the server when it is reachable.
          </p>
        </Sheet>
      );
  }
}

const st0 = (ctx: Ctx) => ctx.s.today;

function PickDayAndGo(props: { ctx: Ctx; label: string; initial?: Day; onGo: (d: Day) => void }) {
  const [day, setDay] = useState<Day | null>(props.initial ?? addDays(props.ctx.s.today, 1));
  return (
    <>
      <DayChoice today={props.ctx.s.today} value={day} onChange={setDay} />
      <div class="sheet-actions">
        <button class="btn primary" disabled={!day} onClick={() => day && props.onGo(day)}>
          {props.label}
          {day ? ` · ${relativeLabel(day, props.ctx.s.today)}` : ''}
        </button>
      </div>
    </>
  );
}

function ActionMenu(props: { ctx: Ctx; taskId: string }) {
  const { ctx, taskId } = props;
  const t = taskById(ctx.s, taskId);
  const open = openPlacement(ctx.s, taskId);
  const item = (label: string, onClick: () => void, cls = '') => (
    <button class={`menu-item ${cls}`} onClick={onClick}>
      {label}
    </button>
  );
  return (
    <Sheet title="Actions" onClose={ctx.close}>
      <p class="muted">{t.title}</p>
      <div class="menu">
        {item('✎  Edit…', () => ctx.open({ kind: 'edit', taskId }))}
        {open && item('→  Forward to another day…', () => ctx.open({ kind: 'forward', taskId }))}
        {item('G✓  Delegate…', () => ctx.open({ kind: 'delegate', taskId }))}
        {open && item(open.inProgress ? '●  Clear in progress' : '●  Mark in progress', () => ctx.act(intents.inProgress(taskId, !open.inProgress)))}
        {open && item('↩  Back to Dump (keeps its letter)', () => ctx.act(intents.backToDump(taskId), 'Back in the Task Dump'))}
        {item('A/B/C  Change priority…', () => ctx.open({ kind: 'priority', taskId }))}
        {!open && item('📅  Plan it on a day…', () => ctx.open({ kind: 'plan', taskId }))}
        {item('✗  Delete', () => ctx.act(intents.delete(taskId), 'Deleted (undo, or restore from Recently deleted)', { undo: intents.restore(taskId) }), 'danger')}
      </div>
    </Sheet>
  );
}

function RankPicker(props: { ctx: Ctx; placementId: string }) {
  const { ctx } = props;
  const pl = ctx.s.placements.find((p) => p.id === props.placementId);
  const [letter, setLetter] = useState<Letter | null>(pl?.letter ?? null);
  if (!pl) {
    return (
      <Sheet title="Priority and order" onClose={ctx.close}>
        <p class="muted">That entry is no longer on this day.</p>
      </Sheet>
    );
  }
  const t = taskById(ctx.s, pl.taskId);
  const reserved = letter ? reservedRanks(ctx.s, pl.day, letter) : new Set<number>();
  const applyLetter = (l: Letter | null) => {
    setLetter(l);
    if (l !== pl.letter) ctx.act(intents.changePriority(t.id, l), l ? `Now ${l}; pick its number` : 'Letter removed', { keepOpen: true });
  };
  return (
    <Sheet title="Priority and order" onClose={ctx.close}>
      <p class="muted">{t.title}</p>
      <LetterChoice value={letter} onChange={applyLetter} allowNone />
      {letter && letter === pl.letter && (
        <>
          <h3 class="sub">Number within {letter}</h3>
          <div class="rank-grid">
            {Array.from({ length: 9 }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                class={`rank-btn ${pl.rank === n ? 'on' : ''} ${reserved.has(n) ? 'reserved' : ''}`}
                aria-disabled={reserved.has(n)}
                title={reserved.has(n) ? `${letter}${n} is held today by a closed entry` : `${letter}${n}`}
                onClick={() => {
                  const refusal = rankRefusal(ctx.s, pl.id, n);
                  if (refusal) ctx.notify(refusal);
                  else ctx.act(intents.setRank(pl.id, n), `Now ${letter}${n}`);
                }}
              >
                {letter}
                {n}
              </button>
            ))}
          </div>
          <p class="hint">
            Struck-through numbers are held today by completed or otherwise closed entries, so no number is ever used twice in a
            day.
          </p>
        </>
      )}
    </Sheet>
  );
}

function EditSheet(props: { ctx: Ctx; taskId: string }) {
  const { ctx, taskId } = props;
  // The baseline is fixed when the dialog opens. A refresh while it is open changes neither
  // the starting values nor the revisions the edit builds on, and only fields the user
  // actually changed are sent.
  const [base] = useState(() => ctx.editBaseline(taskId, ['title', 'notes', 'deadline', 'effort']));
  const v = (f: string) => String(base.values[f] ?? '');
  const [title, setTitle] = useState(v('title'));
  const [notes, setNotes] = useState(v('notes'));
  const [deadline, setDeadline] = useState<string>(v('deadline'));
  const [effort, setEffort] = useState<string>(v('effort'));
  const current = { title: title.trim(), notes, deadline, effort };
  const dirty = Object.entries(current).some(([f, x]) => x !== v(f));
  return (
    <Sheet title="Edit task" onClose={ctx.close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) void ctx.act(intents.editFrom(base, current), 'Saved');
        }}
      >
        <label class="field">
          Title
          <input name="title" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          Notes
          <textarea name="notes" rows={4} value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} />
        </label>
        <div class="row-fields">
          <label class="field">
            Deadline
            <input type="date" value={deadline} onInput={(e) => setDeadline((e.target as HTMLInputElement).value)} />
          </label>
          <label class="field">
            Effort
            <select value={effort} onChange={(e) => setEffort((e.target as HTMLSelectElement).value)}>
              <option value="">—</option>
              <option value="S">Small</option>
              <option value="M">Medium</option>
              <option value="L">Large</option>
            </select>
          </label>
        </div>
        <div class="sheet-actions">
          <button class="btn primary" type="submit" disabled={!dirty || !title.trim()}>
            Save
          </button>
        </div>
      </form>
    </Sheet>
  );
}

function DelegateSheet(props: { ctx: Ctx; taskId: string }) {
  const { ctx, taskId } = props;
  const t = taskById(ctx.s, taskId);
  const [who, setWho] = useState('');
  const [day, setDay] = useState<Day | null>(addDays(ctx.s.today, 2));
  const tomorrow = addDays(ctx.s.today, 1);
  return (
    <Sheet title="Delegate" onClose={ctx.close}>
      <p class="muted">{t.title}</p>
      <label class="field">
        Who is doing it?
        <input value={who} placeholder="A name" onInput={(e) => setWho((e.target as HTMLInputElement).value)} />
      </label>
      <h3 class="sub">Check on it</h3>
      <DayChoice today={ctx.s.today} value={day} onChange={setDay} />
      <p class="hint">It leaves your list and comes back on the check-on day. It does not carry over in between.</p>
      <div class="sheet-actions">
        <button
          class="btn primary"
          disabled={!who.trim() || !day || day < tomorrow}
          onClick={() => day && ctx.act(intents.delegate(taskId, who.trim(), day), `Delegated to ${who.trim()}`)}
        >
          Delegate
        </button>
      </div>
    </Sheet>
  );
}

function AssignSheet(props: { ctx: Ctx; taskId: string }) {
  const { ctx, taskId } = props;
  const t = taskById(ctx.s, taskId);
  const [base] = useState(() => ctx.editBaseline(taskId, ['priority', 'deadline', 'effort']));
  const [letter, setLetter] = useState<Letter | null>((String(base.values.priority ?? '') || null) as Letter | null);
  const [day, setDay] = useState<Day | null>(null);
  const [deadline, setDeadline] = useState<Day | ''>(String(base.values.deadline ?? ''));
  const [effort, setEffort] = useState<Effort | undefined>((String(base.values.effort ?? '') || undefined) as Effort | undefined);
  return (
    <Sheet title="Assign" onClose={ctx.close}>
      <p class="muted">{t.title}</p>
      <h3 class="sub">Priority</h3>
      <LetterChoice value={letter} onChange={setLetter} allowNone />
      <h3 class="sub">Planned day (optional)</h3>
      <DayChoice today={ctx.s.today} value={day} onChange={setDay} allowNone />
      <div class="row-fields">
        <label class="field">
          Deadline (optional)
          <input type="date" value={deadline} onInput={(e) => setDeadline((e.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          Effort (optional)
          <select value={effort ?? ''} onChange={(e) => setEffort(((e.target as HTMLSelectElement).value || undefined) as Effort | undefined)}>
            <option value="">—</option>
            <option value="S">Small</option>
            <option value="M">Medium</option>
            <option value="L">Large</option>
          </select>
        </label>
      </div>
      <div class="sheet-actions">
        <button
          class="btn primary"
          onClick={() =>
            ctx.act(
              intents.assign(taskId, letter, day, deadline, effort, base),
              day ? `On ${relativeLabel(day, ctx.s.today)} as ${letter ?? 'unlettered'}` : `Triaged as ${letter ?? 'unlettered'}, no day yet`,
            )
          }
        >
          Save
        </button>
      </div>
    </Sheet>
  );
}
