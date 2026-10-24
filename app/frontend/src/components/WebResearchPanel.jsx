import React from "react";
import { Globe2 } from "lucide-react";

// Shows the sources, the date range used, the claims and their provenance, and the citation check for one answer.
// Older messages saved before structured research have only a source list, and still render.

const TIER_LABELS = {
  primary: "Primary record",
  "advisory-page": "Advisory page (publisher not verified)",
  secondary: "Secondary source",
  web: "Web page",
};

const FETCH_LABELS = {
  fetched: "Read",
  "search-only": "Search result only (not read)",
  failed: "Not read: fetch failed",
  blocked: "Not read: blocked (private or local address)",
  skipped: "Not read: limit reached",
  "not-found": "Not found in this record source",
};

const STATUS_STYLE = {
  verified: { label: "Verified", color: "#1b7f3b" },
  conflict: { label: "Conflict", color: "#b3261e" },
  "primary-unavailable": { label: "Not verified", color: "#9a6700" },
  "primary-not-found": { label: "Not verified", color: "#9a6700" },
  reported: { label: "Reported", color: "#5f6368" },
  "mentioned-unlinked": { label: "Mentioned", color: "#5f6368" },
  "search-only": { label: "Search result", color: "#5f6368" },
};

const muted = { color: "var(--md-sys-color-on-surface-variant, #5f6368)" };

function formatWindow(timeWindow) {
  if (!timeWindow) return null;
  if (timeWindow.applied) {
    const origin = timeWindow.source === "explicit" ? "your choice" : "inferred from the question";
    return `Date range: ${timeWindow.label}, ${timeWindow.from} to ${timeWindow.to} (${origin})`;
  }
  if (timeWindow.source === "explicit-any") return "Date range: any time (your choice)";
  return "Date range: no date filter";
}

function Badge({ text, color }) {
  return (
    <span style={{
      display: "inline-block",
      marginLeft: "6px",
      padding: "1px 6px",
      borderRadius: "999px",
      border: `1px solid ${color}`,
      color,
      fontSize: "0.7rem",
      fontWeight: 700,
      verticalAlign: "middle",
    }}>
      {text}
    </span>
  );
}

function SourceRef({ index }) {
  if (!index) return null;
  return <a href={`#web-source-${index}`} style={{ color: "var(--md-sys-color-primary)" }}>[{index}]</a>;
}

function FindingRow({ finding }) {
  const style = STATUS_STYLE[finding.status] || STATUS_STYLE["search-only"];
  return (
    <div style={{ padding: "6px 0", borderTop: "1px solid var(--border-color)" }}>
      <div style={{ fontWeight: 700, overflowWrap: "anywhere" }}>
        {finding.identifier}
        <Badge text={style.label} color={style.color} />
      </div>
      <div style={{ ...muted, fontSize: "0.76rem" }}>{finding.statusLabel}</div>
      {finding.product && (
        <div>Product: {finding.product.value || "stated in the record text"} <SourceRef index={finding.product.source} /></div>
      )}
      {!finding.product && finding.productCheck === "matched" && <div>Product: named in the record text</div>}
      {finding.affectedVersions && (
        <div>Affected versions: {finding.affectedVersions.value} <SourceRef index={finding.affectedVersions.source} /></div>
      )}
      {finding.published && <div>Published: {finding.published.value} <SourceRef index={finding.published.source} /></div>}
      {finding.updated && <div>Last updated: {finding.updated.value} <SourceRef index={finding.updated.source} /></div>}
      {finding.cvss && <div>Severity (in primary record): {finding.cvss.value} <SourceRef index={finding.cvss.source} /></div>}
      {finding.reportedSeverity && (
        <div style={muted}>Severity (read source, not verified): {finding.reportedSeverity.value} <SourceRef index={finding.reportedSeverity.source} /></div>
      )}
      <div>
        Exploitation: {finding.exploitation?.label}
        {finding.exploitation?.confirmedActive && <Badge text="Confirmed" color="#b3261e" />}
        {finding.exploitation?.basis && <span style={muted}> ({finding.exploitation.basis})</span>}
        {" "}<SourceRef index={finding.exploitation?.source} />
      </div>
      {finding.primarySource && <div style={muted}>Primary source: <SourceRef index={finding.primarySource} /></div>}
      {finding.readSources?.length > 0 && (
        <div style={muted}>Read sources linking it to the subject: {finding.readSources.map((n) => <SourceRef key={n} index={n} />)}</div>
      )}
      {finding.searchSources?.length > 0 && (
        <div style={muted}>Search results mentioning it (not read): {finding.searchSources.map((n) => <SourceRef key={n} index={n} />)}</div>
      )}
      {(finding.notes || []).map((note) => (
        <div key={note} style={{ ...muted, fontSize: "0.76rem" }}>Note: {note}</div>
      ))}
    </div>
  );
}

// The audit is a deterministic consistency check. The label and note say that it is not a guarantee of truth.
function AuditLine({ audit }) {
  if (!audit) return null;
  const label = audit.note ? (
    <div style={{ ...muted, fontSize: "0.72rem" }}>
      Deterministic consistency check, not a guarantee of truth. {audit.note}
    </div>
  ) : null;
  if (audit.ok && audit.issues.length === 0) {
    return (
      <div style={{ marginTop: "8px" }}>
        <div style={{ ...muted, fontSize: "0.76rem" }}>
          Citation check: no problems found ({audit.checked.citations} citations, {audit.checked.identifiers} identifiers).
        </div>
        {label}
      </div>
    );
  }
  return (
    <div style={{ marginTop: "8px", fontSize: "0.78rem" }}>
      <div style={{ fontWeight: 700, color: audit.ok ? "#9a6700" : "#b3261e" }}>
        {audit.ok ? "Citation check: warnings" : "Citation check: problems found. Check these before relying on the answer."}
      </div>
      {label}
      {audit.issues.map((issue, index) => (
        <div key={`${issue.type}-${index}`} style={{ color: issue.severity === "error" ? "#b3261e" : "inherit" }}>
          • {issue.detail}
        </div>
      ))}
    </div>
  );
}

export default function WebResearchPanel({ sources = [], webResearch = null, audit = null }) {
  const research = webResearch?.research || null;
  const findings = webResearch?.findings || [];
  const windowLine = formatWindow(research?.timeWindow);

  return (
    <div style={{
      marginTop: "8px",
      padding: "10px 12px",
      border: "1px solid var(--border-color)",
      borderRadius: "8px",
      background: "var(--md-sys-color-surface-container)",
      fontSize: "0.8rem",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "6px", fontWeight: 700, marginBottom: "6px" }}>
        <Globe2 size={13} />
        <span>Sources</span>
      </div>

      {research && (
        <div style={{ ...muted, fontSize: "0.76rem", marginBottom: "6px" }}>
          <div>{windowLine}</div>
          <div>
            Checked on {research.currentDate} ({research.timezone}). Searches {research.budget.searchesUsed} of {research.budget.maxSearches};
            pages read {research.budget.pagesRead}; record lookups {research.budget.lookups}.
            {research.budget.timedOut ? " Time limit reached." : ""}
          </div>
          {research.subject?.value && <div>Subject term: {research.subject.value}</div>}
          {research.error && <div style={{ color: "#b3261e" }}>Web search failed: {research.error}. The answer had no web evidence.</div>}
          {research.limitations?.length > 0 && (
            <details style={{ marginTop: "4px" }}>
              <summary style={{ cursor: "pointer" }}>Limits of this check</summary>
              {research.limitations.map((item) => <div key={item}>• {item}</div>)}
            </details>
          )}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {sources.map((source, sourceIndex) => {
          const number = source.index || sourceIndex + 1;
          const tier = TIER_LABELS[source.tier];
          const fetch = FETCH_LABELS[source.fetchStatus] || (source.fetched ? FETCH_LABELS.fetched : null);
          return (
            <div key={`${source.url}-${sourceIndex}`} id={`web-source-${number}`}>
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--md-sys-color-primary)", textDecoration: "none", overflowWrap: "anywhere" }}
              >
                [{number}] {source.title || source.url}
              </a>
              <div style={{ ...muted, fontSize: "0.72rem" }}>
                {tier && <span>{tier}. </span>}
                {fetch ? <span>{fetch}. </span> : null}
                {source.published && <span>Published {source.published}. </span>}
                {source.updated && <span>Updated {source.updated}. </span>}
                {!source.published && source.fetched && <span>Publication date not stated on the page. </span>}
                {!source.fetched && source.snippet && <span>Snippet only. </span>}
              </div>
            </div>
          );
        })}
      </div>

      {findings.length > 0 && (
        <div style={{ marginTop: "10px" }}>
          <div style={{ fontWeight: 700 }}>Claims and provenance</div>
          {findings.map((finding) => <FindingRow key={finding.id || finding.identifier} finding={finding} />)}
        </div>
      )}

      <AuditLine audit={audit} />
    </div>
  );
}
