import { Link } from 'react-router';
import TechHeader from '../../components/TechHeader';
import { useCurrentStaff } from '../../services/session';

export default function JobsPage() {
  const staff = useCurrentStaff();

  return (
    <div>
      <TechHeader
        title="Team jobs"
        subtitle={staff.teamName}
        initial={staff.name.charAt(0)}
      />
      Jobs page
      <Link to="/tech/jobs/1">Job 1</Link>
    </div>
  );
}
