import { Link } from 'react-router';
import TechHeader from '../../components/TechHeader';

export default function JobsPage() {
  return (
    <div>
      <TechHeader title="Team jobs" subtitle="Building equipment" initial="S" />
      Jobs page
      <Link to="/tech/jobs/1">Job 1</Link>
    </div>
  );
}
