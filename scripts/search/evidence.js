// Turns fetched sources into verified or uncertain findings about vulnerability identifiers.
//
// Rules this module enforces:
//  - A search snippet or search title is never evidence. It can only produce a "search-only" finding.
//  - An identifier is "verified" only when a primary record for that exact identifier was read and it names
//    the subject of the question. Secondary pages can corroborate, but they never verify on their own.
//  - A secondary sentence links an identifier to the subject only when the sentence names the subject and
//    exactly one identifier of that family. Incident articles that list several identifiers are not linked.
//  - Exploitation is "confirmed" only from a CISA KEV listing or CISA's SSVC "active" decision. Public PoC and
//    search hits are reported as what they are. Negated statements are reported as "no exploitation stated".
//  - When a primary lookup fails or finds nothing, the finding says so. No value is filled in from elsewhere.

const { extractIdentifiers } = require("./identifiers");
const { exploitationStatement, severityStatement, splitSentences } = require("./records");
const { todayIso } = require("./planner");

const STATUS_LABELS = {
  verified: "Verified against a primary record",
  conflict: "Primary record conflicts with the subject or is rejected; not verified",
  "primary-unavailable": "Primary record could not be retrieved; not verified",
  "primary-not-found": "No primary record found for this identifier; not verified",
  reported: "Reported by a read source; primary record not verified",
  "mentioned-unlinked": "Mentioned in a read source but not linked to the subject; not verified",
  "search-only": "Search result only; the page was not read; not verified",
};

const EXPLOITATION_LABELS = {
  "kev-listed": "Listed in CISA KEV (known exploited)",
  "cisa-ssvc-active": "CISA SSVC decision: exploitation active",
  "public-poc-per-cisa-ssvc": "CISA SSVC decision: public proof of concept exists (not exploitation)",
  "no-exploitation-stated": "No exploitation stated",
  "publisher-states-exploited": "Exploitation stated by the record or advisory publisher (not CISA KEV)",
  "reported-exploited-by-secondary": "A read secondary source reports exploitation (not verified)",
  "public-poc-reported": "A read source reports a public proof of concept (not exploitation)",
  "conflicting-statements": "Sources disagree about exploitation",
  "not-established": "Not established by any read source",
};

function normalizeForMatch(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// True when the text names the subject as whole words. Null when there is no subject to test.
function mentionsSubject(text, subject) {
  const key = normalizeForMatch(subject);
  if (!key) return null;
  return ` ${normalizeForMatch(text)} `.includes(` ${key} `);
}

function sentenceHas(sentence, id) {
  return extractIdentifiers(sentence).some((item) => item.id === id);
}

function subjectIdOf(source) {
  let decoded = source.url || "";
  try { decoded = decodeURIComponent(decoded); } catch (_) {}
  const fromUrl = extractIdentifiers(decoded);
  if (fromUrl.length) return fromUrl[0].id;
  const fromTitle = extractIdentifiers(source.page?.title || source.title || "");
  return fromTitle.length ? fromTitle[0].id : null;
}

// The primary evidence a fetched source gives for one identifier, or null.
function primaryEvidence(source, id) {
  if (!source || source.fetchStatus !== "fetched" || source.tier !== "primary") return null;
  if (source.record) {
    const record = source.record;
    if (record.id !== id) return null;
    return {
      sourceIndex: source.index,
      type: source.sourceType,
      rejected: /REJECTED/i.test(String(record.state || "")),
      text: [record.title, record.description, ...(record.productNames || [])].filter(Boolean).join(" \n "),
      productNames: record.productNames || [],
      products: record.products || [],
      published: record.published || null,
      publishedMalformed: Boolean(record.publishedMalformed),
      updated: record.updated || null,
      cvss: record.cvss || null,
      ssvc: record.ssvcExploitation || null,
      exploitationSentences: splitSentences(record.description || ""),
      aliases: [],
    };
  }
  if (source.page && subjectIdOf(source) === id) {
    // The identifier must appear in the page's own title or text. An identifier that appears only in the URL is not
    // enough, so a source's classification never verifies a fact by itself.
    const pageNamesId = [source.page.title, ...source.page.sentences]
      .some((text) => extractIdentifiers(String(text || "")).some((item) => item.id === id));
    if (!pageNamesId) return null;
    // A record page is about one identifier. If it names no other identifier (aliases excepted), the whole
    // page is its text. Otherwise only the sentences that name this identifier count.
    const otherIds = source.page.sentences
      .filter((sentence) => !/\balias|also known as/i.test(sentence))
      .flatMap((sentence) => extractIdentifiers(sentence))
      .filter((item) => item.id !== id);
    const related = otherIds.length ? source.page.sentences.filter((sentence) => sentenceHas(sentence, id)) : source.page.sentences;
    return {
      sourceIndex: source.index,
      type: source.sourceType,
      rejected: false,
      text: [source.page.title, ...related].filter(Boolean).join(" \n "),
      productNames: [],
      products: [],
      published: source.page.published || null,
      publishedMalformed: Boolean(source.page.publishedMalformed),
      updated: source.page.updated || null,
      cvss: null,
      ssvc: null,
      exploitationSentences: related,
      aliases: aliasesIn(source.page.sentences, id),
    };
  }
  return null;
}

// Identifiers an EUVD-style record lists as aliases. These are reported as the record's statement only.
function aliasesIn(sentences, id) {
  const out = [];
  for (const sentence of sentences) {
    if (!/\balias|\bCVE\b|also known as/i.test(sentence)) continue;
    for (const item of extractIdentifiers(sentence)) {
      if (item.type === "cve" && item.id !== id && !out.includes(item.id)) out.push(item.id);
    }
  }
  return out;
}

function versionsText(products) {
  const parts = [];
  for (const item of products || []) {
    const versions = (item.versions || []).filter(Boolean);
    if (!versions.length) continue;
    const name = [item.vendor, item.product].filter(Boolean).join(" ");
    parts.push(name ? `${name}: ${versions.join("; ")}` : versions.join("; "));
  }
  return parts.length ? parts.join(" | ") : null;
}

function productText(primary) {
  const names = primary.products.map((item) => [item.vendor, item.product].filter(Boolean).join(" ")).filter(Boolean);
  if (names.length) return [...new Set(names)].join("; ");
  return primary.productNames.length ? [...new Set(primary.productNames)].join("; ") : null;
}

function cvssText(cvss) {
  if (!cvss || !Number.isFinite(cvss.score)) return null;
  return `${cvss.version} ${cvss.score}${cvss.severity ? ` ${String(cvss.severity).toUpperCase()}` : ""}`;
}

function exploitationFor({ id, primary, kevEntry, kevIndex, readSentences }) {
  if (kevEntry) {
    return {
      status: "kev-listed",
      basis: kevEntry.dateAdded ? `CISA KEV dateAdded ${kevEntry.dateAdded}` : "CISA KEV",
      source: kevIndex,
      // The catalogue is authoritative for "known exploited". A conflicting SSVC value is reported, not used.
      disagreement: primary?.ssvc && primary.ssvc !== "active" ? `The CVE record's SSVC exploitation field is "${primary.ssvc}", which differs from the KEV listing.` : null,
    };
  }

  const readStatements = readSentences.map((item) => ({ ...item, statement: exploitationStatement(item.sentence) })).filter((item) => item.statement);
  const readExploited = readStatements.find((item) => item.statement === "reported-exploited");
  const ssvc = primary?.ssvc || null;

  if (ssvc === "active") {
    return { status: "cisa-ssvc-active", basis: "CISA SSVC Exploitation: active in the CVE record", source: primary.sourceIndex };
  }
  if (ssvc === "poc" || ssvc === "none") {
    const ssvcStatus = ssvc === "poc" ? "public-poc-per-cisa-ssvc" : "no-exploitation-stated";
    const basis = `CISA SSVC Exploitation: ${ssvc} in the CVE record`;
    if (readExploited) {
      return { status: "conflicting-statements", basis: `${basis}, but a read source reports exploitation`, source: readExploited.source };
    }
    return { status: ssvcStatus, basis, source: primary.sourceIndex };
  }

  const found = [
    ...(primary ? primary.exploitationSentences.map((sentence) => ({ sentence, primary: true, source: primary.sourceIndex, statement: exploitationStatement(sentence) })) : []),
    ...readStatements.map((item) => ({ ...item, primary: false })),
  ].filter((entry) => entry.statement);
  if (!found.length) return { status: "not-established", basis: null, source: null, disagreement: null };

  const statements = new Set(found.map((item) => item.statement));
  if (statements.has("no-exploitation-stated") && statements.has("reported-exploited")) {
    return { status: "conflicting-statements", basis: "the primary record and read sources disagree", source: found[0].source };
  }
  const exploited = found.find((item) => item.statement === "reported-exploited");
  if (exploited) {
    if (exploited.primary) return { status: "publisher-states-exploited", basis: "stated in the primary record", source: exploited.source };
    return { status: "reported-exploited-by-secondary", basis: "stated in a read secondary source", source: exploited.source };
  }
  const poc = found.find((item) => item.statement === "public-poc-reported");
  if (poc) return { status: "public-poc-reported", basis: "stated in a read source", source: poc.source };
  const none = found.find((item) => item.statement === "no-exploitation-stated");
  return { status: "no-exploitation-stated", basis: "stated in a read source", source: none.source };
}

// Where one date falls against the selected range. Both ends are enforced. "future" is after today and is never
// treated as recent. "after" is after the end of the range. "none" means no range was applied. Null means no date.
function dateRelation(iso, window, today) {
  if (!iso) return null;
  if (today && iso > today) return "future";
  if (!window || !window.from) return "none";
  if (window.to && iso > window.to) return "after";
  if (iso < window.from) return "before";
  return "in";
}

// Where a finding falls against the selected date range. Dates come only from primary records (the identifier's own
// publication date) and from read pages (the date of the article that mentions it). A search engine's date filter
// is never used as a date. A malformed date is labelled, not used.
function recencyFor({ window, today, published, publishedMalformed = false, articleDate, articleMalformed = false }) {
  const pub = published ? published.value : null;
  const art = articleDate ? articleDate.value : null;
  const range = window && window.from ? `${window.from} to ${window.to}` : null;
  const pubRel = dateRelation(pub, window, today);
  const artRel = dateRelation(art, window, today);

  if (publishedMalformed && !pub) {
    return { label: "date-malformed", detail: "the publication date in the primary record is not a valid calendar date; it is not used" };
  }
  if (pub) {
    if (pubRel === "future") {
      return { label: "date-in-future", detail: `published ${pub}, which is after today (${today}); not treated as recent` };
    }
    if (pubRel === "none") {
      return { label: "no-date-range", detail: `published ${pub} (primary record); no date range applied` };
    }
    if (pubRel === "after") {
      return { label: "published-after-range", detail: `published ${pub}, after the date range (${range}); not inside the range` };
    }
    if (pubRel === "in") {
      return { label: "published-in-range", detail: `published ${pub}, inside the date range (${range})` };
    }
    // The identifier was published before the range.
    if (artRel === "in") {
      return { label: "older-mentioned-in-range", detail: `published ${pub}, before the date range (${range}); a read article dated ${art}, inside the range, mentions it` };
    }
    const note = artRel === "future" || artRel === "after" ? ` A read article dated ${art} is outside the range, so it does not date this identifier.` : "";
    return { label: "published-before-range", detail: `published ${pub}, before the date range (${range}).${note}` };
  }

  // No valid publication date from a primary record.
  if (!range) {
    return { label: "no-date-range", detail: "publication date not established by a primary record; no date range applied" };
  }
  if (articleMalformed && !art) {
    return { label: "date-malformed", detail: "a read article gives a date that is not a valid calendar date; the publication date is not established" };
  }
  if (artRel === "in") {
    return { label: "reported-in-range", detail: `publication date not established; a read article dated ${art}, inside the date range (${range}), mentions it` };
  }
  if (artRel === "after" || artRel === "future") {
    return { label: "reported-after-range", detail: `publication date not established; a read article dated ${art} is outside the date range (${range}), so it is not recent coverage` };
  }
  return { label: "date-unknown", detail: `publication date not established by a primary record (date range ${range})` };
}

const RECENCY_NOTES = {
  "published-before-range": "Published before the selected date range. Do not describe it as a recent discovery.",
  "published-after-range": "Published after the selected date range. Do not describe it as inside the range.",
  "date-in-future": "The record's publication date is after today, so it is not a valid recent date. Do not describe it as recent.",
  "date-malformed": "A date in the source is not a valid calendar date, so it is not used. Do not describe it as recent.",
  "older-mentioned-in-range": "Published before the selected date range, but recent coverage mentions it. Describe it as an older vulnerability mentioned in recent coverage, not as a new discovery.",
  "reported-in-range": "A read article is inside the date range, but the identifier's own publication date is not established. Do not describe it as a recent discovery.",
  "reported-after-range": "A read article is outside the date range, and the publication date is not established. Do not describe it as recent.",
  "date-unknown": "No publication date could be established, so this cannot be placed in the date range. Do not describe it as recent.",
};

// Ordering. Status comes first, so a recent mention never outranks a conflict or an unverified identifier as though
// it were verified. For latest/current questions, findings within a status are ordered newest first. Unknown dates
// go last. The identifier only breaks ties.
function compareDatesNewestFirst(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return b.localeCompare(a);
}

function buildFindings({ subject = null, sources = [], lookups = new Map(), kev = null, maxFindings = 8, window = null, recencyFocus = false, today = null } = {}) {
  const asOf = today || todayIso(new Date());
  const candidates = new Map();
  const addCandidate = (id, type) => {
    if (!candidates.has(id)) candidates.set(id, { id, type, searchHit: false, read: false });
    return candidates.get(id);
  };

  for (const source of sources) {
    const searchText = [source.title, source.snippet].filter(Boolean).join(" \n ");
    for (const item of extractIdentifiers(`${searchText}\n${source.url || ""}`)) {
      const candidate = addCandidate(item.id, item.type);
      if (subject === null || mentionsSubject(searchText, subject)) candidate.searchHit = true;
    }
    if (source.fetchStatus === "fetched") {
      const readText = [source.page?.title, ...(source.page?.sentences || []), source.record?.description, source.record?.id].filter(Boolean).join("\n");
      for (const item of extractIdentifiers(readText)) addCandidate(item.id, item.type).read = true;
    }
  }
  for (const id of lookups.keys()) {
    const type = id.startsWith("EUVD-") ? "euvd" : id.startsWith("GHSA-") ? "ghsa" : "cve";
    addCandidate(id, type);
  }

  const findings = [];
  for (const candidate of candidates.values()) {
    const id = candidate.id;
    const readSources = sources.filter((source) => source.fetchStatus === "fetched" && source.tier !== "primary");
    const primaries = sources.map((source) => primaryEvidence(source, id)).filter(Boolean);
    const primary = primaries.find((item) => mentionsSubject(item.text, subject) === true) || primaries[0] || null;
    const readSentences = [];
    for (const source of readSources) {
      for (const sentence of source.page?.sentences || []) {
        if (sentenceHas(sentence, id)) readSentences.push({ sentence, source: source.index });
      }
    }
    // A sentence links the identifier when it names exactly one identifier of that family. With a subject, it must
    // also name the subject. With no subject (a broad question), the identifier alone is the anchor, and the note
    // below says that no product was checked.
    const linked = readSentences.filter((item) => {
      if (subject !== null && !mentionsSubject(item.sentence, subject)) return false;
      const sameFamily = extractIdentifiers(item.sentence).filter((x) => x.type === candidate.type);
      return sameFamily.length === 1;
    });
    const ambiguous = subject === null
      ? []
      : readSentences.filter((item) => mentionsSubject(item.sentence, subject) && !linked.includes(item));

    const sourceByIndex = new Map(sources.map((item) => [item.index, item]));
    const articleDates = linked
      .map((item) => ({ value: sourceByIndex.get(item.source)?.published || sourceByIndex.get(item.source)?.page?.published || null, source: item.source }))
      .filter((item) => item.value)
      .sort((a, b) => b.value.localeCompare(a.value));
    const articleDate = articleDates[0] || null;
    // A read article whose date is malformed is reported, and is not used for any date.
    const articleMalformed = !articleDate && linked.some((item) => {
      const source = sourceByIndex.get(item.source);
      return Boolean(source?.publishedMalformed || source?.page?.publishedMalformed);
    });

    // Keep only identifiers that relate to the question: a primary record, a lookup made for it, a read
    // sentence that links it to the subject, an ambiguous read mention, or a search hit that names the subject.
    const related = Boolean(primary) || lookups.has(id) || linked.length > 0 || ambiguous.length > 0 || candidate.searchHit;
    if (!related) continue;

    const lookup = lookups.get(id) || null;
    const attempts = lookup?.attempts || [];
    // A real error (timeout, HTTP error, budget) is "unavailable". A "no such record" answer is "not found".
    const failed = !primary && attempts.some((attempt) => !attempt.ok && !attempt.notFound);
    const notFound = !primary && attempts.length > 0 && attempts.every((attempt) => !attempt.ok && attempt.notFound);

    let status;
    let productCheck = "not-checked";
    if (primary) {
      const match = mentionsSubject(primary.text, subject);
      if (primary.rejected) {
        status = "conflict";
        productCheck = "rejected";
      } else if (match === false) {
        status = "conflict";
        productCheck = "mismatch";
      } else {
        status = "verified";
        productCheck = match === null ? "not-checked" : "matched";
      }
    } else if (failed) {
      status = "primary-unavailable";
    } else if (notFound) {
      status = "primary-not-found";
    } else if (linked.length) {
      status = "reported";
    } else if (candidate.read && readSentences.length) {
      status = "mentioned-unlinked";
    } else {
      status = "search-only";
    }

    const kevEntry = kev && kev.status === "ok" && candidate.type === "cve" ? kev.map.get(id) || null : null;
    const exploitation = exploitationFor({
      id,
      primary,
      kevEntry,
      kevIndex: kev?.sourceIndex ?? null,
      readSentences: linked,
    });
    const verified = status === "verified";
    const severityFromRead = !verified && linked.length
      ? linked.map((item) => ({ item, severity: severityStatement(item.sentence) })).find((x) => x.severity)
      : null;

    const notes = [];
    const published = verified && primary.published ? { value: primary.published, source: primary.sourceIndex } : null;
    const publishedMalformed = verified && Boolean(primary.publishedMalformed);
    const recency = recencyFor({ window, today: asOf, published, publishedMalformed, articleDate, articleMalformed });
    if (RECENCY_NOTES[recency.label]) notes.push(RECENCY_NOTES[recency.label]);
    if (recency.label === "no-date-range" && recencyFocus && !published) {
      notes.push("No date range was applied, and no primary publication date is known. Do not describe it as recent.");
    }
    if (subject === null) {
      notes.push("No product was named in the question, so no product check was made against the question.");
      if (linked.length) notes.push("A read sentence names this identifier only. It does not establish the product.");
    }
    if (primary?.rejected) notes.push("The CVE record is marked REJECTED. It is not treated as a valid identifier.");
    if (primary?.aliases?.length) notes.push(`The EUVD record lists ${primary.aliases.join(", ")} as alias(es). These are not verified until their own CVE records are read.`);
    if (productCheck === "mismatch") notes.push("The primary record for this identifier does not name the subject of the question. It is not linked to that subject.");
    if (ambiguous.length && !verified) notes.push("A read source mentions the subject and this identifier in a sentence with several identifiers, so the link is not used.");
    if (kev && kev.status !== "ok" && candidate.type === "cve") notes.push("CISA KEV catalogue unavailable; KEV status not checked.");
    for (const attempt of attempts) {
      if (!attempt.ok && attempt.error && !attempt.notFound) notes.push(`Primary lookup did not complete: ${attempt.error}.`);
    }
    if (status === "primary-unavailable" && linked.length) notes.push("A read source links this identifier to the subject, but that is not a primary verification.");
    if (status === "reported") notes.push("Primary record not checked; the claim comes only from the read source(s) listed.");
    if (status === "search-only") notes.push("Seen only in search results; no page was read.");
    if (status === "mentioned-unlinked") notes.push("A read source mentions this identifier, but not in a sentence that also names the subject.");
    if (exploitation.disagreement) notes.push(exploitation.disagreement);
    if (exploitation.status === "conflicting-statements") notes.push("Sources disagree about exploitation. State the disagreement; do not pick one side.");
    if (exploitation.status === "not-established") notes.push("No read source states exploitation. Do not describe it as exploited.");

    const sourceIndexes = (list) => [...new Set(list)].sort((a, b) => a - b);
    findings.push({
      id: "",
      identifier: id,
      identifierType: candidate.type,
      subject,
      status,
      statusLabel: STATUS_LABELS[status],
      productCheck,
      product: primary && (verified || productCheck === "mismatch") ? {
        value: productText(primary),
        source: primary.sourceIndex,
        mismatch: productCheck === "mismatch",
      } : null,
      affectedVersions: verified ? (() => {
        const value = versionsText(primary.products);
        return value ? { value, source: primary.sourceIndex } : null;
      })() : null,
      published,
      articleDate,
      recency,
      updated: verified && primary.updated ? { value: primary.updated, source: primary.sourceIndex } : null,
      cvss: verified && primary.cvss ? { value: cvssText(primary.cvss), source: primary.sourceIndex, basis: "stated in the primary record" } : null,
      reportedSeverity: severityFromRead ? { value: severityFromRead.severity.value, source: severityFromRead.item.source, basis: "stated in a read source; not verified" } : null,
      primarySource: primary ? primary.sourceIndex : null,
      primaryType: primary ? primary.type : null,
      readSources: sourceIndexes(linked.map((item) => item.source)),
      searchSources: sourceIndexes(sources
        .filter((source) => source.fetchStatus !== "fetched" && extractIdentifiers(`${source.title || ""} ${source.snippet || ""}`).some((item) => item.id === id))
        .map((source) => source.index)),
      exploitation: {
        status: exploitation.status,
        label: EXPLOITATION_LABELS[exploitation.status],
        basis: exploitation.basis,
        source: exploitation.source,
        confirmedActive: exploitation.status === "kev-listed" || exploitation.status === "cisa-ssvc-active",
      },
      aliases: primary?.aliases || [],
      notes,
    });
  }

  const rank = { verified: 0, conflict: 1, "primary-unavailable": 2, "primary-not-found": 3, reported: 4, "mentioned-unlinked": 5, "search-only": 6 };
  // Newest first within a status group for latest/current questions. A verified finding is dated by its primary
  // record only. Other findings use the date of the article that mentions them, if one is known. A date that is
  // future, malformed or after the range is not a sort key, so those findings go last with the unknown dates.
  const sortableDate = (value) => {
    const relation = dateRelation(value, window, asOf);
    return relation === "none" || relation === "in" || relation === "before" ? value : null;
  };
  const dateKey = (finding) => sortableDate(finding.status === "verified"
    ? finding.published?.value
    : finding.published?.value || finding.articleDate?.value) || null;
  findings.sort((a, b) => (rank[a.status] - rank[b.status])
    || (recencyFocus ? compareDatesNewestFirst(dateKey(a), dateKey(b)) : 0)
    || a.identifier.localeCompare(b.identifier));
  return findings.slice(0, Math.max(1, maxFindings)).map((finding, index) => ({ ...finding, id: `F${index + 1}` }));
}

module.exports = {
  buildFindings,
  dateRelation,
  recencyFor,
  mentionsSubject,
  STATUS_LABELS,
  EXPLOITATION_LABELS,
};
