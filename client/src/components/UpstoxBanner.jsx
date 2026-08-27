import { useEffect, useState } from "react";

function formatExpiry(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function UpstoxBanner() {
  const [status, setStatus] = useState(null);
  const [callbackNote, setCallbackNote] = useState(null);

  useEffect(() => {
    // pick up ?upstox=connected / ?upstox=error&reason=... from the OAuth
    // callback redirect, then strip it from the URL
    const params = new URLSearchParams(window.location.search);
    const upstox = params.get("upstox");
    if (upstox === "connected") {
      setCallbackNote({ type: "success", text: "Upstox connected." });
    } else if (upstox === "error") {
      setCallbackNote({ type: "error", text: `Upstox connection failed: ${params.get("reason") || "unknown error"}` });
    }
    if (upstox) {
      const url = new URL(window.location.href);
      url.searchParams.delete("upstox");
      url.searchParams.delete("reason");
      window.history.replaceState({}, "", url.toString());
    }

    fetch("/api/upstox/status")
      .then((res) => res.json())
      .then(setStatus)
      .catch(() => setStatus({ configured: false, connected: false }));
  }, []);

  if (!status) return null;

  if (!status.configured) {
    return (
      <div className="upstox-banner upstox-banner-neutral">
        Upstox isn't set up yet — add <code>UPSTOX_API_KEY</code> and <code>UPSTOX_API_SECRET</code> to{" "}
        <code>server/.env</code>, then reload.
      </div>
    );
  }

  return (
    <div className={`upstox-banner ${status.connected ? "upstox-banner-connected" : "upstox-banner-disconnected"}`}>
      {callbackNote && <div className={`upstox-callback-note ${callbackNote.type}`}>{callbackNote.text}</div>}
      {status.connected ? (
        <span>
          🟢 Upstox connected{status.userName ? ` as ${status.userName}` : ""} — live prices from Upstox until{" "}
          {formatExpiry(status.expiresAt)}, then falls back to Yahoo automatically
        </span>
      ) : (
        <span>
          🔴 Upstox not connected — running on the Yahoo fallback feed today.{" "}
          <a href="/api/upstox/login">Connect Upstox</a> for the official, more reliable feed.
        </span>
      )}
    </div>
  );
}
