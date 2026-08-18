import { useEffect, useState } from "react";
import ResultsTable from "./ResultsTable.jsx";

function formatDateLabel(dateStr) {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function HistoryTab() {
  const [dates, setDates] = useState([]);
  const [selectedDate, setSelectedDate] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/history/dates")
      .then((res) => res.json())
      .then((data) => {
        const list = data.dates ?? [];
        setDates(list);
        if (list.length > 0) setSelectedDate(list[0]);
        else setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!selectedDate) return;
    setLoading(true);
    fetch(`/api/history?date=${selectedDate}`)
      .then((res) => res.json())
      .then((data) => {
        setResults(data.results ?? []);
        setLoading(false);
      });
  }, [selectedDate]);

  if (dates.length === 0 && !loading) {
    return (
      <p className="empty-state">
        No history yet — history is recorded automatically the next time you
        run a full Refresh on the Screener tab.
      </p>
    );
  }

  return (
    <div className="history">
      <div className="controls">
        <select
          className="date-select"
          value={selectedDate}
          onChange={(e) => setSelectedDate(e.target.value)}
        >
          {dates.map((d) => (
            <option key={d} value={d}>
              {formatDateLabel(d)}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="empty-state">Loading…</p>
      ) : (
        <ResultsTable results={results} updatedAt={selectedDate} />
      )}
    </div>
  );
}
