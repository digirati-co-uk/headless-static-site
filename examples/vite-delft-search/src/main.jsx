import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  InstantSearch,
  Configure,
  SearchBox,
  Hits,
  Highlight,
  Pagination,
  useRefinementList,
  useCurrentRefinements,
  useClearRefinements,
  useInstantSearch,
  useStats,
} from "react-instantsearch";
import TypesenseInstantSearchAdapter from "typesense-instantsearch-adapter";
import "./style.css";

const label = (value) => value?.nl?.[0] || value?.en?.[0] || Object.values(value || {}).flat()[0] || "Collectie";
const apiKey = import.meta.env.VITE_TYPESENSE_SEARCH_KEY;
const adapter =
  apiKey &&
  new TypesenseInstantSearchAdapter({
    server: {
      apiKey,
      nodes: [{ host: "localhost", port: 18108, protocol: "http" }],
      cacheSearchResultsForSeconds: 2,
    },
    additionalSearchParameters: { query_by: "label,plaintext", query_by_weights: "3,1" },
  });

function Facet({ attribute, title }) {
  const { items, refine } = useRefinementList({ attribute, limit: 100, sortBy: ["name:asc"] });
  return (
    <details className="facet" open>
      <summary>{title}</summary>
      <div className="facet-options">
        {items.length ? (
          items.map((item) => (
            <label className="check-row" key={item.value}>
              <span>
                {item.label} <small>({item.count})</small>
              </span>
              <input type="checkbox" checked={item.isRefined} onChange={() => refine(item.value)} />
            </label>
          ))
        ) : (
          <p className="muted">Geen opties voor deze zoekopdracht.</p>
        )}
      </div>
    </details>
  );
}

function Section({ section, items, refine, term }) {
  const [expanded, setExpanded] = useState(false);
  const children = (section.items || []).filter((item) => item.type === "Collection");
  const matchingChildren = children.filter((child) => label(child.label).toLowerCase().includes(term));
  if (term && !label(section.label).toLowerCase().includes(term) && !matchingChildren.length) return null;
  const row = (resource) => {
    const slug = resource["hss:slug"];
    const item = items.find((item) => item.value === slug);
    return (
      <label className="check-row">
        <span>
          {label(resource.label)} <small>({item?.count || 0})</small>
        </span>
        <input type="checkbox" checked={item?.isRefined || false} onChange={() => refine(slug)} />
      </label>
    );
  };
  return (
    <div className="collection-group" style={{ "--section-color": section.background || "#ddd" }}>
      <div className="collection-heading">
        <button
          className="expand"
          aria-label={`${expanded ? "Sluit" : "Open"} ${label(section.label)}`}
          aria-expanded={expanded || Boolean(term)}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded || term ? "−" : "+"}
        </button>
        {row(section)}
      </div>
      {(expanded || term) && (
        <div className="collection-children">
          {(term ? matchingChildren : children).map((child) => (
            <div key={child.id}>{row(child)}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function CollectionFacet({ sections }) {
  const { items, refine } = useRefinementList({ attribute: "collectionSlugs", limit: 100, sortBy: ["name:asc"] });
  const [term, setTerm] = useState("");
  return (
    <details className="facet collections" open>
      <summary>Collecties</summary>
      <label className="collection-search">
        <span className="sr-only">Zoek een collectie</span>
        <input
          type="search"
          placeholder="Zoek in collecties"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
        />
        <span aria-hidden="true">⌕</span>
      </label>
      {sections.map((section) => (
        <Section key={section.id} section={section} items={items} refine={refine} term={term.toLowerCase()} />
      ))}
    </details>
  );
}

function SelectedFilters({ collectionLookup }) {
  const { items, refine } = useCurrentRefinements();
  const { canRefine, refine: clear } = useClearRefinements();
  return (
    <div className="selected" aria-label="Actieve filters">
      {items.flatMap((item) =>
        item.refinements.map((filter) => {
          const collection = item.attribute === "collectionSlugs" && collectionLookup[filter.value];
          return (
            <button
              key={`${item.attribute}:${filter.value}`}
              style={{ background: collection?.color }}
              onClick={() => refine(filter)}
              aria-label={`Verwijder filter ${collection?.label || filter.label}`}
            >
              {collection?.label || filter.label}
              <span aria-hidden="true">×</span>
            </button>
          );
        })
      )}
      {canRefine ? (
        <button className="clear" onClick={clear}>
          Wis filters
        </button>
      ) : (
        <span className="muted">Ontdek de collectie, of verfijn je zoekopdracht.</span>
      )}
    </div>
  );
}

function Result({ hit }) {
  const [failed, setFailed] = useState(false);
  const parent = hit.partOf?.at(-1);
  return (
    <article className="result">
      <div className="thumbnail">
        {hit.thumbnail && !failed ? (
          <img src={hit.thumbnail} alt="" loading="lazy" onError={() => setFailed(true)} />
        ) : (
          <span>Geen afbeelding</span>
        )}
      </div>
      <div className="result-body">
        <span className="eyebrow">Object</span>
        <h2>
          <a href={`/iiif/${hit.slug}/manifest.json`} target="_blank" rel="noreferrer">
            <Highlight attribute="label" hit={hit} />
          </a>
        </h2>
        <p>{hit.topic_objectType?.join(" · ")}</p>
        {parent && (
          <div className="membership">
            <span>Deel van collectie</span>
            <span className="badge" style={{ background: hit.background || "#ddd" }}>
              {label(parent.label)}
            </span>
          </div>
        )}
      </div>
    </article>
  );
}

function ResultsHeader() {
  const { nbHits } = useStats();
  const { status, error } = useInstantSearch();
  return (
    <div className="results-header" aria-live="polite">
      <span>
        <strong>{nbHits}</strong> {nbHits === 1 ? "object" : "objecten"}
      </span>
      <span>
        {error
          ? "Zoeken niet beschikbaar. Controleer of Typesense draait en de index is geladen."
          : status === "loading" || status === "stalled"
            ? "Zoeken…"
            : "TU Delft · kleine selectie"}
      </span>
    </div>
  );
}

function EmptyResults() {
  const { results, status, error } = useInstantSearch();
  return !error && status === "idle" && results.nbHits === 0 ? (
    <p className="empty">Geen objecten gevonden. Probeer een andere zoekterm of verwijder een filter.</p>
  ) : null;
}

function App({ featured }) {
  const sections = featured.items || [];
  const collectionLookup = Object.fromEntries(
    sections.flatMap((section) =>
      [section, ...(section.items || []).filter((item) => item.type === "Collection")].map((item) => [
        item["hss:slug"],
        { label: label(item.label), color: section.background },
      ])
    )
  );
  return (
    <InstantSearch
      searchClient={adapter.searchClient}
      indexName="delft-demo"
      routing
      future={{ preserveSharedStateOnUnmount: true }}
      catchError
    >
      <Configure hitsPerPage={6} filters="type:=Manifest" />
      <header className="masthead">
        <a href="/" className="brand">
          TU<span>Delft</span>
          <small>ACADEMISCH ERFGOED</small>
        </a>
        <span className="edition">
          Collecties ontdekken <span>↗</span>
        </span>
      </header>
      <main>
        <section className="results" aria-label="Zoekresultaten">
          <SelectedFilters collectionLookup={collectionLookup} />
          <ResultsHeader />
          <Hits hitComponent={Result} />
          <EmptyResults />
          <Pagination />
        </section>
        <aside aria-label="Verfijn resultaten">
          <CollectionFacet sections={sections} />
          <Facet attribute="topic_objectType" title="Objectnaam / type" />
          <Facet attribute="topic_material" title="Materiaal" />
          <p className="sample-note">
            16 objecten uit de Delft-dataset.
            <br />
            Collectiegroeperingen zijn voor deze demo samengesteld.
          </p>
        </aside>
      </main>
      <footer className="search-bar">
        <SearchBox
          placeholder="Zoek in het erfgoed, bijvoorbeeld afstandsmeter"
          translations={{ submitButtonTitle: "Zoeken", resetButtonTitle: "Wis zoekopdracht" }}
        />
        <span className="search-scope">
          Alle collecties <span aria-hidden="true">⌕</span>
        </span>
      </footer>
    </InstantSearch>
  );
}

const root = createRoot(document.getElementById("root"));
if (!apiKey) {
  root.render(
    <div className="setup">
      <h1>Delft collecties</h1>
      <p>
        Voer <code>pnpm run setup</code> uit in dit voorbeeld en start daarna Vite opnieuw. Dit maakt een alleen-lezen
        zoeksleutel aan.
      </p>
    </div>
  );
} else {
  fetch("/iiif/featured/collection.json")
    .then((response) => {
      if (!response.ok) throw new Error("Collection output unavailable");
      return response.json();
    })
    .then((featured) => root.render(<App featured={featured} />))
    .catch(() =>
      root.render(
        <div className="setup">
          <h1>Collecties niet beschikbaar</h1>
          <p>
            Bouw de IIIF-data met <code>pnpm build</code> en probeer opnieuw.
          </p>
        </div>
      )
    );
}
