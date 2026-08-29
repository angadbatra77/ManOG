import { useEffect, useState } from "react";

export default function CapitalSettings() {
  const [availableCash, setAvailableCash] = useState("");
  const [saved, setSaved] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/capital")
      .then((res) => res.json())
      .then((data) => {
        setAvailableCash(String(data.availableCash ?? 0));
        setLoading(false);
      });
  }, []);

  async function handleSave(e) {
    e.preventDefault();
    const res = await fetch("/api/capital", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ availableCash }),
    });
    if (res.ok) setSaved(true);
  }

  if (loading) return null;

  return (
    <form className="capital-settings" onSubmit={handleSave}>
      <label htmlFor="available-cash">
        Available cash
        <span
          className="info-icon"
          title="Manually tracked — there's no live broker balance connection. This is only used to size the 'suggested position' shown on the Screener; it never places an order or moves money."
        >
          {" "}ⓘ
        </span>
      </label>
      <input
        id="available-cash"
        type="number"
        min="0"
        value={availableCash}
        onChange={(e) => { setAvailableCash(e.target.value); setSaved(false); }}
      />
      <button type="submit" disabled={saved}>
        {saved ? "Saved" : "Save"}
      </button>
    </form>
  );
}
