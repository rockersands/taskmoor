import { useEffect, useRef, useState } from 'react';
import type { Candidate, CrossTrackClient } from './crossTrackClient';

/** Whether a word of the filter is in this release's track or name. */
export const candidateMatches = (candidate: Candidate, filter: string) =>
  `${candidate.track.key} ${candidate.track.name} ${candidate.name}`
    .toLowerCase()
    .includes(filter.trim().toLowerCase());

/** How long typing rests before a word goes to the server. */
const WAIT_MS = 250;

/**
 * The releases a person may link (PLN-007). The first answer stops at a limit, and says so. Only then
 * does what is typed go to the server, as well as filter what is here: those it finds join those
 * known, so what was ticked stays, and what lies past the limit can be found at all.
 */
export function useCandidates(client: CrossTrackClient) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [stopsShort, setStopsShort] = useState(false);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState('');
  const latest = useRef(0);
  const wanted = filter.trim();

  useEffect(() => {
    const asked = ++latest.current;
    client.candidates().then(
      (answer) => {
        if (asked !== latest.current) return;
        setCandidates(answer.releases);
        setTruncated(answer.truncated);
        setStopsShort(answer.truncated);
      },
      () => {
        if (asked === latest.current) setFailed(true);
      },
    );
  }, [client]);

  const typed = useRef(wanted);
  useEffect(() => {
    if (!stopsShort || typed.current === wanted) return;
    typed.current = wanted;
    const timer = setTimeout(() => {
      const asked = ++latest.current;
      setFailed(false);
      client.candidates(wanted || undefined).then(
        (answer) => {
          if (asked !== latest.current) return;
          setCandidates((known) => {
            const seen = new Set((known ?? []).map((c) => c.id));
            return [...(known ?? []), ...answer.releases.filter((c) => !seen.has(c.id))];
          });
          setTruncated(answer.truncated);
        },
        () => {
          if (asked === latest.current) setFailed(true);
        },
      );
    }, WAIT_MS);
    return () => clearTimeout(timer);
  }, [client, stopsShort, wanted]);

  return { candidates, truncated, stopsShort, failed, filter, setFilter };
}
