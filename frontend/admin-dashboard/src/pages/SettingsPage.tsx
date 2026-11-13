import { PriorityBadge } from '../components/Badges';
import { PRIORITIES, SLA_POLICY, TEAMS } from '../lib/constants';

const th = 'px-3 py-3 text-left font-normal text-slate-500';

function minutesText(minutes: number): string {
  return minutes < 60 ? `${minutes} min` : `${minutes / 60} h`;
}

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <section className="rounded-2xl border border-slate-200 p-5">
          <h2 className="font-bold">Resolution deadline by priority</h2>
          <p className="mb-3 text-xs text-slate-500">
            Fixed by the system and the same for every team. The clock starts
            when the report is created; a reopen starts a new clock. Read-only.
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200">
                <th className={th}>Priority</th>
                <th className={th}>Start work within</th>
                <th className={th}>Fix within</th>
              </tr>
            </thead>
            <tbody>
              {PRIORITIES.map((p) => (
                <tr key={p} className="border-b border-slate-100">
                  <td className="px-3 py-3">
                    <PriorityBadge priority={p} />
                  </td>
                  <td className="px-3 py-3">
                    {minutesText(SLA_POLICY[p].respondMinutes)}
                  </td>
                  <td className="px-3 py-3 font-medium">
                    {SLA_POLICY[p].fixHours} h
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="rounded-2xl border border-slate-200 p-5">
          <h2 className="mb-3 font-bold">Assignment</h2>
          <p className="rounded-lg border border-slate-200 p-3 text-sm text-slate-700">
            AWS Bedrock classifies every report and assigns it to a maintenance
            team. Tickets stay with that team until done; the team coordinates
            who goes. Reports the AI cannot classify wait on the Needs triage
            page.
          </p>
          <p className="mt-2 text-xs text-slate-500">
            SLA warnings and breaches alert the supervisor by email.
          </p>
        </section>
      </div>

      <section className="rounded-2xl border border-slate-200 p-5">
        <h2 className="mb-3 font-bold">Maintenance teams</h2>
        <ul className="flex flex-wrap gap-2">
          {TEAMS.map((t) => (
            <li
              key={t.id}
              className="rounded-full border border-slate-200 px-3 py-1 text-sm"
            >
              {t.label}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
