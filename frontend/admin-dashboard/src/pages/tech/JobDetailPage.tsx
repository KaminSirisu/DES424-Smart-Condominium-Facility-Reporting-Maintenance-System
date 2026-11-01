import { useParams } from 'react-router';
import TechHeader from '../../components/TechHeader';

export default function JobDetailPage() {
  const { ticketId } = useParams();
  return (
    <div>
      <TechHeader
        title={`#${ticketId}`}
        subtitle="Building equipment"
        backTo="/tech"
      />
      id: {ticketId}
    </div>
  );
}
