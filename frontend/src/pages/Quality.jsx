import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Printer, Save } from 'lucide-react';
import { api } from '../services/api';
import { Banner, Empty, Spinner } from '../components/ui';
import { useToasts } from '../state/Toasts';
import './Quality.css';

/**
 * Quality: how well VeriBook is doing its job, in one report layout (lib/evals/report.ts) for three sources:
 *  - real invoices over a period, read from the record (computed when the page opens);
 *  - the latest lab run: labelled cases whose right answers come from the written policy;
 *  - saved snapshots of either, so a report can say what changed since the last one.
 * Plus the log of bugs that testing found and the fix for each. Printable, and downloadable as data.
 */

const DAY = 864e5;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const TABS = [
  { key: 'field', label: 'Real invoices' },
  { key: 'lab', label: 'Lab run' },
  { key: 'saved', label: 'Saved reports' },
  { key: 'found', label: 'Found by testing' },
];
const VERDICT = {
  pass: { chip: 'vb-chip-approved', word: 'Meets every target' },
  fail: { chip: 'vb-chip-rejected', word: 'Misses a target' },
  not_enough_data: { chip: 'vb-chip-neutral', word: 'Not enough data yet' },
};
const KIND_WORDS = {
  wrongly_paid: 'Paid, should not have been', wrongly_held: 'Held, should have been paid', wrong_reason: 'Right outcome, wrong reason',
  wrong_level: 'Wrong level', money_rule: 'Money rule broken', crash: 'A step failed', stuck: 'Left mid-way',
};
const OUTCOME_WORDS = { approved: 'approved', held: 'held for a person', rejected: 'rejected', refused: 'refused at entry' };
const STAGE_WORDS = { intake: 'Entering', extract: 'Taking in the invoice', validate: 'Checks', match: 'Matching', investigate: 'AI review', verify: 'AI second opinion', decide: 'Deciding', policy: 'Deciding', post_pay: 'Posting and paying', audit: 'Posting and paying', pipeline: 'Whole pipeline (with AI)' };

export default function Quality() {
  const toast = useToasts();
  const [tab, setTab] = useState('field');
  const [from, setFrom] = useState(isoDay(Date.now() - 29 * DAY));
  const [to, setTo] = useState(isoDay(Date.now()));
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [opened, setOpened] = useState(null); // a saved report opened from the list
  const [saving, setSaving] = useState(false);

  const load = () => {
    let cancelled = false;
    setData(null);
    setError(null);
    api.getQuality({ from, to }).then((d) => !cancelled && setData(d)).catch((e) => !cancelled && setError(e));
    return () => { cancelled = true; };
  };
  useEffect(load, [from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveSnapshot = async () => {
    setSaving(true);
    try {
      const r = await api.saveQualitySnapshot({ from, to });
      toast.success(`Snapshot saved. ${r.summary}`);
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const openSaved = async (id) => {
    setOpened({ id, loading: true });
    try {
      setOpened({ id, ...(await api.getQualityReport(id)) });
    } catch (e) {
      setOpened(null);
      toast.error(e.message);
    }
  };

  const shown = tab === 'field' ? data?.field : tab === 'lab' ? data?.latestLab?.report : tab === 'saved' && opened?.report ? opened.report : null;

  return (
    <div className="vb-page vb-quality">
      <div className="vb-tabs vb-noprint" role="tablist">
        {TABS.map((t) => <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className="vb-tab" onClick={() => setTab(t.key)}>{t.label}</button>)}
      </div>

      <div className="vb-inline vb-noprint vb-quality-bar">
        {tab === 'field' && (
          <>
            <label className="vb-field"><span>From</span><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="vb-field"><span>To</span><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
            <button type="button" className="vb-btn vb-btn-sm" disabled={!data || saving} onClick={saveSnapshot} title="Keep this report, so the next one can say what changed"><Save size={14} /> {saving ? 'Saving…' : 'Save snapshot'}</button>
          </>
        )}
        {shown && (
          <>
            <button type="button" className="vb-btn vb-btn-sm" onClick={() => window.print()}><Printer size={14} /> Print or save as PDF</button>
            <button type="button" className="vb-btn vb-btn-sm" onClick={() => downloadJson(shown)}><Download size={14} /> Download data</button>
          </>
        )}
      </div>

      {error && <Banner kind="error">{error.message}</Banner>}
      {!data && !error && <Spinner label="Working out the report…" />}

      {data && tab === 'field' && <ReportView report={data.field} titles={data.reasonTitles} linkInvoices />}
      {data && tab === 'lab' && (data.latestLab
        ? <ReportView report={data.latestLab.report} titles={data.reasonTitles} />
        : <Empty title="No lab run saved yet">The lab run puts about 40 labelled cases through the real checks and scores them against the written policy. It is saved here each time it runs on the server.</Empty>)}
      {data && tab === 'saved' && (opened?.report
        ? <><button type="button" className="vb-link-btn vb-noprint" onClick={() => setOpened(null)}>← All saved reports</button><ReportView report={opened.report} titles={data.reasonTitles} linkInvoices={opened.report.kind === 'field'} /></>
        : opened?.loading ? <Spinner label="Opening…" /> : <SavedList rows={data.saved} onOpen={openSaved} />)}
      {data && tab === 'found' && <FoundList rows={data.foundByEvals} />}
    </div>
  );
}

function downloadJson(report) {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: `veribook-${report.kind}-report-${report.generatedAt.slice(0, 10)}.json` });
  a.click();
  URL.revokeObjectURL(url);
}

const fmt = (x, unit = '') => (x === null || x === undefined ? '—' : `${x}${unit}`);
const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function ReportView({ report: r, titles = {}, linkInvoices = false }) {
  const v = VERDICT[r.verdict];
  const lab = r.kind === 'lab';
  const inv = (id, text) => (linkInvoices && id ? <Link to={`/app/invoice/${id}`}>{text}</Link> : text);
  return (
    <article className="vb-quality-report">
      <section className="vb-card vb-pad">
        <div className="vb-inline" style={{ gap: 10, flexWrap: 'wrap' }}>
          <span className={`vb-chip ${v.chip}`}>{v.word}</span>
          <h2 style={{ margin: 0, fontSize: 18 }}>{lab ? 'Lab run' : 'Real invoices'}{r.period ? `, ${r.period.from} to ${r.period.to}` : ''}</h2>
        </div>
        <p style={{ margin: '8px 0 4px', fontSize: 15 }}>{r.summary}</p>
        <p className="vb-dim vb-small" style={{ margin: 0 }}>
          Made {when(r.generatedAt)}{lab ? ` · ${r.mode === 'rules' ? 'rules only (no AI)' : 'rules and AI review'}` : ''}{r.codeVersion ? ` · code ${r.codeVersion}` : ''}
        </p>
      </section>

      <Section title="Targets" hint="What good looks like. Missing one tells you what to do next.">
        <table className="vb-table">
          <thead><tr><th>Measure</th><th>Target</th><th>Result</th><th /></tr></thead>
          <tbody>{r.targets.map((t) => (
            <tr key={t.key}>
              <td>{t.label}{t.met === false && <div className="vb-dim vb-small" style={{ maxWidth: 520 }}>{t.ifMissed}</div>}</td>
              <td className="num">{t.target}</td>
              <td className="num"><b>{t.actual}</b></td>
              <td>{t.met === null ? <span className="vb-chip vb-chip-neutral">no data</span> : t.met ? <span className="vb-chip vb-chip-approved">met</span> : <span className="vb-chip vb-chip-rejected">missed</span>}</td>
            </tr>
          ))}</tbody>
        </table>
      </Section>

      {r.change && <Change change={r.change} />}

      <Section title="Money" hint="Rules money must always obey, checked in the database itself, not by re-running the code that should obey them.">
        <div className="vb-kpis">
          <Kpi label={lab ? 'Cases checked' : 'Invoices checked'} value={r.money.checked} />
          <Kpi label="Paid that should not have been" value={r.money.wronglyPaid} bad={r.money.wronglyPaid > 0} />
          <Kpi label={lab ? 'Held that should have been paid' : 'Held, then approved by a person'} value={r.money.wronglyHeld} />
          <Kpi label="Mistakes with no warning" value={r.money.silentErrors} bad={r.money.silentErrors > 0} />
        </div>
        <ul className="vb-quality-rules">{r.money.rules.map((rule) => (
          <li key={rule.key} className={rule.broken ? 'broken' : ''}>
            <span aria-hidden="true">{rule.broken ? '✗' : '✓'}</span> {rule.rule}{rule.broken > 0 && <b> — broken {rule.broken}×</b>}
            {rule.examples.length > 0 && <ul>{rule.examples.map((e, i) => <li key={i} className="vb-small">{inv(e.invoiceId, e.invoiceNumber || 'record')}: {e.detail}</li>)}</ul>}
          </li>
        ))}</ul>
      </Section>

      <Section title="Each step" hint={lab ? 'Did each step do what the policy expects of it, and how long it took.' : 'What each step did with real invoices. Real invoices carry no right answers, so steps are described, not scored.'}>
        <div className="vb-scroll-x"><table className="vb-table">
          <thead><tr><th>Step</th><th className="num">Runs</th>{lab && <th className="num">Right</th>}<th className="num">Typical</th><th className="num">Slowest 5%</th></tr></thead>
          <tbody>{r.operations.map((o) => (
            <tr key={o.key}>
              <td><b>{o.label}</b><div className="vb-dim vb-small">{o.does}</div>{o.notes.map((n, i) => <div key={i} className="vb-small" style={{ marginTop: 2 }}>{n}</div>)}</td>
              <td className="num">{o.runs}</td>
              {lab && <td className="num">{o.correct === null ? '—' : <span className={o.correct < o.judged ? 'vb-quality-bad' : ''}>{o.correct}/{o.judged}</span>}</td>}
              <td className="num">{fmt(o.p50Ms, ' ms')}</td>
              <td className="num">{fmt(o.p95Ms, ' ms')}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </Section>

      <Section title="Journeys" hint="Each kind of invoice followed from entry to its end.">
        <div className="vb-quality-journeys">{r.journeys.map((j) => (
          <div key={j.key} className="vb-quality-journey">
            <div className="vb-inline" style={{ justifyContent: 'space-between' }}>
              <b>{j.label}</b>
              <span className="vb-dim vb-small">{j.entered} {lab ? 'case' : 'invoice'}{j.entered === 1 ? '' : 's'}{j.correct !== undefined ? ` · ${j.correct} right` : ''}</span>
            </div>
            {j.steps.map((s) => (
              <div key={s.label} className="vb-quality-step">
                <span className="vb-small">{s.label}</span>
                <span className="vb-quality-track"><span style={{ width: `${j.entered ? (s.count / j.entered) * 100 : 0}%` }} /></span>
                <span className="vb-small num">{s.count}</span>
              </div>
            ))}
            <div className="vb-small vb-dim" style={{ marginTop: 6 }}>
              Ended: {j.ended.approved} approved · {j.ended.held} held · {j.ended.rejected} rejected{j.ended.refused ? ` · ${j.ended.refused} refused` : ''}{j.ended.inProgress ? ` · ${j.ended.inProgress} ${lab ? 'could not run' : 'in progress'}` : ''}
            </div>
          </div>
        ))}{r.journeys.length === 0 && <p className="vb-muted">No invoices in this period.</p>}</div>
      </Section>

      <Section title="Time and effort" hint="Machine time is the automatic steps only; waiting for a person is shown separately.">
        <div className="vb-kpis">
          <Kpi label="Machine time, typical" value={fmt(r.logistics.machineSeconds.p50, ' s')} />
          <Kpi label="Machine time, slowest 5%" value={fmt(r.logistics.machineSeconds.p95, ' s')} />
          {!lab && <Kpi label="Wait for a person, typical" value={fmt(r.logistics.personWaitHours.p50, ' h')} sub={`${r.logistics.personWaitHours.decided} decided, ${r.logistics.personWaitHours.stillWaiting} waiting`} />}
          <Kpi label="AI calls" value={r.logistics.aiCalls} />
        </div>
        {r.logistics.stageMs.length > 0 && (
          <table className="vb-table">
            <thead><tr><th>Step</th><th className="num">Runs</th><th className="num">Typical</th><th className="num">Slowest 5%</th></tr></thead>
            <tbody>{r.logistics.stageMs.map((s) => <tr key={s.stage}><td>{STAGE_WORDS[s.stage] ?? s.stage}</td><td className="num">{s.runs}</td><td className="num">{fmt(s.p50, ' ms')}</td><td className="num">{fmt(s.p95, ' ms')}</td></tr>)}</tbody>
          </table>
        )}
      </Section>

      <Section title="What the AI added" hint="The AI can only make a decision stricter. This shows what it changed and whether it stayed honest.">
        <ul className="vb-quality-ai">
          {r.ai.changedOutcome !== null && <li>Changed the rules' outcome on <b>{r.ai.changedOutcome}</b> case(s): {r.ai.changedRight} for the better, <b className={r.ai.changedWrong ? 'vb-quality-bad' : ''}>{r.ai.changedWrong}</b> for the worse.</li>}
          <li>Held <b>{r.ai.aiHolds}</b> invoice(s) the rules would have approved{r.ai.aiHolds ? `; a person then rejected ${r.ai.aiHoldsPersonRejected} and approved ${r.ai.aiHoldsPersonApproved}` : ''}.</li>
          <li>Second opinion disagreed <b>{r.ai.verifierDisagreed}</b> time(s) (each sent the invoice to a person).</li>
          <li><b>{r.ai.uncheckedFigureNotes}</b> of {r.ai.aiExplanations} AI explanation(s) contained a figure not found in its records (marked unchecked on the invoice).</li>
          <li>Questions from people: <b>{r.ai.challengesAnswered}</b> answered, <b className={r.ai.challengesUnanswered ? 'vb-quality-bad' : ''}>{r.ai.challengesUnanswered}</b> not answered.</li>
          {r.ai.aiFailed > 0 && <li><b>{r.ai.aiFailed}</b> AI step(s) failed (for example, the free AI quota ran out); each invoice was held for a person.</li>}
          {r.ai.notes.map((n, i) => <li key={i} className="vb-dim">{n}</li>)}
        </ul>
      </Section>

      <Section title={`What went wrong (${r.failures.length})`} hint="Each one to open and look at.">
        {r.failures.length === 0 ? <p className="vb-muted">Nothing.</p> : (
          <table className="vb-table">
            <thead><tr><th>What</th><th>Kind</th><th>Expected</th><th>Got</th></tr></thead>
            <tbody>{r.failures.map((f, i) => <tr key={`${f.id}-${i}`}><td>{inv(f.invoiceId, f.title)}</td><td>{KIND_WORDS[f.kind] ?? f.kind}</td><td className="vb-small">{f.expected}</td><td className="vb-small">{f.got}</td></tr>)}</tbody>
          </table>
        )}
      </Section>

      {r.cases && <Cases cases={r.cases} titles={titles} />}

      <Section title="Read with care">
        <ul className="vb-small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>{r.caveats.map((c, i) => <li key={i}>{c}</li>)}</ul>
      </Section>
    </article>
  );
}

function Section({ title, hint, children }) {
  return (
    <section className="vb-card vb-pad vb-quality-section">
      <h3 style={{ margin: 0 }}>{title}</h3>
      {hint && <p className="vb-dim vb-small" style={{ margin: '2px 0 10px' }}>{hint}</p>}
      {children}
    </section>
  );
}

function Kpi({ label, value, sub, bad }) {
  return (
    <div className={`vb-card vb-kpi${bad ? ' vb-kpi-attention' : ''}`}>
      <span className="vb-kpi-label">{label}</span>
      <span className="vb-kpi-value">{value}</span>
      {sub && <span className="vb-kpi-sub">{sub}</span>}
    </div>
  );
}

function Change({ change }) {
  const nothing = change.targets.length === 0 && change.newlyFailing.length === 0 && change.newlyPassing.length === 0;
  return (
    <Section title="Since the last saved report" hint={`Compared with the report saved ${when(change.previousAt)}.`}>
      {nothing && <p className="vb-muted" style={{ margin: 0 }}>No change in any target.</p>}
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {change.targets.map((t) => <li key={t.key}>{t.key.replace(/_/g, ' ')}: {t.before} → <b>{t.now}</b></li>)}
        {change.newlyFailing.length > 0 && <li className="vb-quality-bad">Now failing: {change.newlyFailing.join(', ')}</li>}
        {change.newlyPassing.length > 0 && <li>Now passing: {change.newlyPassing.join(', ')}</li>}
      </ul>
    </Section>
  );
}

function Cases({ cases, titles }) {
  const words = (code) => titles[code] ?? code;
  const [all, setAll] = useState(false);
  const wrong = cases.filter((c) => !(c.outcomeOk && c.reasonOk) || c.error);
  const rows = all ? cases : wrong;
  return (
    <Section title={`Lab cases (${cases.length - wrong.length} of ${cases.length} right)`} hint="Each case's right answer comes from the section of the written policy named next to it.">
      <button type="button" className="vb-link-btn vb-noprint" onClick={() => setAll(!all)}>{all ? 'Show only the wrong ones' : `Show all ${cases.length}`}</button>
      {rows.length === 0 ? <p className="vb-muted">Every case was decided as the policy says.</p> : (
        <div className="vb-scroll-x"><table className="vb-table">
          <thead><tr><th>Case</th><th>Policy says</th><th>VeriBook did</th><th className="num">Time</th></tr></thead>
          <tbody>{rows.map((c) => {
            const right = c.outcomeOk && c.reasonOk && !c.error;
            return (
              <tr key={c.id}>
                <td>{c.trick && <span className="vb-chip vb-chip-needs_attention" style={{ marginRight: 6 }}>trick</span>}{c.title}<div className="vb-dim vb-small">{c.rule}</div></td>
                <td>{OUTCOME_WORDS[c.expected.outcome]}{c.expected.reason ? <div className="vb-dim vb-small">{words(c.expected.reason)}</div> : null}</td>
                <td className={right ? '' : 'vb-quality-bad'}>{c.error ?? OUTCOME_WORDS[c.got.outcome]}{c.got.reason ? <div className="vb-dim vb-small">{words(c.got.reason)}</div> : null}</td>
                <td className="num">{c.ms} ms</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
    </Section>
  );
}

function SavedList({ rows, onOpen }) {
  if (rows.length === 0) return <Empty title="No saved reports yet">Save a snapshot of the real-invoice report, or let the lab run save one, and it is listed here.</Empty>;
  return (
    <section className="vb-card vb-pad">
      <table className="vb-table">
        <thead><tr><th>Saved</th><th>Kind</th><th>Result</th><th>By</th><th /></tr></thead>
        <tbody>{rows.map((s) => (
          <tr key={s.id}>
            <td>{when(s.createdAt)}</td>
            <td>{s.kind === 'lab' ? `Lab run (${s.mode === 'rules' ? 'rules only' : 'with AI'})` : `Real invoices, ${s.periodFrom} to ${s.periodTo}`}</td>
            <td><span className={`vb-chip ${VERDICT[s.verdict].chip}`}>{VERDICT[s.verdict].word}</span><div className="vb-small">{s.summary}</div></td>
            <td className="vb-small">{s.createdBy ?? '—'}</td>
            <td><button type="button" className="vb-btn vb-btn-sm" onClick={() => onOpen(s.id)}>Open</button></td>
          </tr>
        ))}</tbody>
      </table>
    </section>
  );
}

const RISK_WORDS = { money: 'could cost money', trust: 'misleading record', time: 'wasted a person’s time' };

function FoundList({ rows }) {
  return (
    <section className="vb-card vb-pad">
      <p className="vb-muted" style={{ marginTop: 0, maxWidth: 760, lineHeight: 1.5 }}>
        Bugs found by testing VeriBook against realistic invoices, what each would have cost, and the fix. Each one now has a test or a lab case that would catch it again.
      </p>
      <div className="vb-scroll-x"><table className="vb-table vb-quality-found">
        <colgroup><col style={{ width: 150 }} /><col style={{ width: '38%' }} /><col style={{ width: '34%' }} /><col /></colgroup>
        <thead><tr><th>Found</th><th>What went wrong</th><th>Fix</th><th>Guarded by</th></tr></thead>
        <tbody>{rows.map((f, i) => (
          <tr key={i}>
            <td className="vb-small">{f.date}<div className="vb-dim">{f.how}</div><span className={`vb-chip ${f.risk === 'money' ? 'vb-chip-rejected' : 'vb-chip-needs_attention'}`}>{RISK_WORDS[f.risk]}</span></td>
            <td>{f.found}</td>
            <td className="vb-small">{f.fix}</td>
            <td className="vb-small vb-dim">{f.guard}</td>
          </tr>
        ))}</tbody>
      </table></div>
    </section>
  );
}
