import "./style.css";
import config from "../.iiifrc.yml?raw";
const main = document.querySelector("main");
const text = (value) =>
  typeof value === "string"
    ? value
    : Object.values(value || {})
        .flat()
        .join(" ");
const el = (tag, content) => {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  return node;
};
const link = (label, href) => {
  const node = el("a", label);
  if (["http:", "https:"].includes(new URL(href, location.origin).protocol)) node.href = href;
  return node;
};
const route = (item) => (item["hss:slug"] ? `?slug=${encodeURIComponent(item["hss:slug"])}` : item.id);
function card(item) {
  const node = el("article");
  node.append(el("small", item.type), link(text(item.label), route(item)), el("p", text(item.summary)));
  if (item["hss:slug"]) node.append(el("code", item["hss:slug"]));
  if (item["hss:totalItems"] !== undefined) node.append(el("p", `${item["hss:totalItems"]} direct items`));
  return node;
}
function featuredSection(collection, index) {
  const section = el("section");
  section.className = "featured-section";
  section.id = `recipe-${index + 1}`;
  const heading = el("h2", text(collection.label));
  heading.id = `${section.id}-title`;
  section.setAttribute("aria-labelledby", heading.id);
  const introduction = el("div");
  introduction.className = "section-heading";
  const description = el("div");
  description.append(
    el(
      "small",
      `Recipe ${String(index + 1).padStart(2, "0")} · ${collection["hss:totalItems"] ?? collection.items?.length ?? 0} direct items`
    ),
    heading,
    el("p", text(collection.summary))
  );
  introduction.append(description, link("Explore collection →", route(collection)));
  const cards = el("div");
  cards.className = "grid";
  for (const item of collection.items || []) cards.append(card(item));
  section.append(introduction, cards);
  if (!collection.items?.length) section.append(el("p", "This collection is intentionally empty."));
  return section;
}
async function load() {
  const slug = new URLSearchParams(location.search).get("slug");
  if (slug && slug.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("Invalid resource path.");
  const path = `/iiif/${slug ? slug.split("/").map(encodeURIComponent).join("/") : "featured"}`;
  let response = await fetch(`${path}/collection.json`);
  if (!response.ok && slug) response = await fetch(`${path}/manifest.json`);
  if (!response.ok) throw new Error("Unable to load this resource.");
  const resource = await response.json();
  document.title = `${text(resource.label)} · Collection recipes`;
  main.replaceChildren();
  if (slug) main.append(link("← All recipes", "/"));
  main.append(el("h1", text(resource.label)), el("p", text(resource.summary)));
  main.append(
    link("Open generated IIIF JSON ↗", `${path}/${resource.type === "Collection" ? "collection" : "manifest"}.json`)
  );
  if (!slug || slug === "featured") {
    const navigation = el("nav");
    navigation.className = "recipe-navigation";
    navigation.setAttribute("aria-label", "Jump to a featured recipe");
    for (const [index, collection] of (resource.items || []).entries()) {
      navigation.append(link(text(collection.label), `#recipe-${index + 1}`));
    }
    main.append(navigation, ...(resource.items || []).map(featuredSection));
  } else {
    const grid = el("section");
    grid.className = "grid";
    grid.setAttribute("aria-label", "Collection members");
    for (const item of resource.items || []) grid.append(card(item));
    main.append(grid);
    if (!resource.items?.length)
      main.append(
        el(
          "p",
          resource.type === "Collection"
            ? "This collection is intentionally empty."
            : "This sample manifest illustrates membership; it has no canvases."
        )
      );
  }
  const details = el("details");
  details.append(el("summary", "Explore the store configuration"), el("pre", config));
  main.append(details);
}
load().catch((error) => {
  const message = el("p", error.message);
  message.setAttribute("role", "alert");
  main.replaceChildren(message, link("Return to recipes", "/"));
});
