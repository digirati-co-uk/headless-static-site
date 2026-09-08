import "./style.css";
const main = document.querySelector("main");
const text = (value) =>
  typeof value === "string" ? value : (value?.en || value?.none || Object.values(value || {})[0] || []).join(" ");
const el = (tag, className = "", content) => {
  const node = document.createElement(tag);
  node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
};
const route = (item) => (item["hss:slug"] ? `/collections?slug=${encodeURIComponent(item["hss:slug"])}` : item.id);
const link = (label, href, className = "") => {
  const node = el("a", className, label);
  const url = new URL(href, location.origin);
  if (["http:", "https:"].includes(url.protocol)) node.href = url.href;
  return node;
};
function image(resource, className = "") {
  const src = resource.thumbnail?.[0]?.id;
  if (!src) return el("div", `placeholder ${className}`, "Image forthcoming");
  const img = el("img", className);
  img.src = src;
  img.alt = "";
  img.loading = "lazy";
  img.addEventListener("error", () => img.replaceWith(el("div", `placeholder ${className}`, "Image unavailable")), {
    once: true,
  });
  return img;
}
function card(item) {
  const article = el("article", "card");
  const anchor = link("", route(item));
  anchor.append(image(item));
  const body = el("div", "card-body");
  body.append(
    el("span", "eyebrow", item.type === "Collection" ? "Collection" : "From the archive"),
    el("h3", "", text(item.label))
  );
  if (item.summary) body.append(el("p", "", text(item.summary)));
  const meta = el("dl");
  for (const field of item.metadata || [])
    meta.append(el("dt", "", text(field.label)), el("dd", "", text(field.value)));
  if (typeof item["hss:totalItems"] === "number")
    meta.append(el("dt", "", "Items online"), el("dd", "", String(item["hss:totalItems"])));
  body.append(meta, el("span", "card-arrow", "↗"));
  anchor.append(body);
  article.append(anchor);
  return article;
}
function section(resource, index) {
  const node = el("section", "collection-section");
  const behaviors = resource.behavior || [];
  const color = ["yellow", "blue", "orange"].find((name) =>
    behaviors.includes(`https://example.org/behaviors/theme-${name}`)
  );
  if (color) node.classList.add(color);
  const heading = el("div", "section-heading");
  const description = el("div");
  description.append(
    el("span", "eyebrow", `EXPLORE / ${String(index + 1).padStart(2, "0")}`),
    el("h2", "", text(resource.label))
  );
  if (resource.summary) description.append(el("p", "", text(resource.summary)));
  heading.append(description, link("Explore collection ↗", route(resource), "text-link"));
  const cards = el("div", "cards");
  cards.id = `cards-${index}`;
  const carousel = behaviors.includes("https://example.org/behaviors/carousel");
  if (carousel) cards.classList.add("carousel");
  for (const item of resource.items || []) cards.append(card(item));
  const controls = el("div", "section-controls");
  controls.append(el("span", "", `${resource.items?.length || 0} selections`));
  if (carousel) {
    const buttons = el("div", "carousel-buttons");
    const previous = el("button", "", "←"),
      next = el("button", "", "→");
    for (const [button, label, direction] of [
      [previous, "Previous cards", -1],
      [next, "Next cards", 1],
    ]) {
      button.type = "button";
      button.setAttribute("aria-label", `${label}: ${text(resource.label)}`);
      button.setAttribute("aria-controls", cards.id);
      button.addEventListener("click", () =>
        cards.scrollBy({
          left: cards.clientWidth * direction,
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
        })
      );
      buttons.append(button);
    }
    const update = () => {
      previous.disabled = cards.scrollLeft < 1;
      next.disabled = cards.scrollLeft + cards.clientWidth >= cards.scrollWidth - 2;
    };
    cards.addEventListener("scroll", update, { passive: true });
    new ResizeObserver(update).observe(cards);
    controls.append(buttons);
  }
  node.append(heading, cards, controls);
  return node;
}
async function load() {
  const slug = new URLSearchParams(location.search).get("slug");
  if (slug && slug.split("/").some((part) => !part || part === ".." || part === "."))
    throw new Error("Invalid collection address.");
  const path = slug ? `/iiif/${slug.split("/").map(encodeURIComponent).join("/")}` : "/iiif/featured";
  let response = await fetch(`${path}/collection.json`);
  if (!response.ok && slug) response = await fetch(`${path}/manifest.json`);
  if (!response.ok) throw new Error("This collection could not be loaded. Please try again.");
  const resource = await response.json();
  main.replaceChildren();
  document.title = `${text(resource.label)} · Heritage & Discovery`;
  const hero = el("section", "hero"),
    heroImage = image(resource, "hero-image"),
    content = el("div", "hero-content");
  heroImage.loading = "eager";
  content.append(el("span", "eyebrow", "THE ARCHIVE IS OPEN"), el("h1", "", text(resource.label)));
  if (resource.summary) content.append(el("p", "", text(resource.summary)));
  hero.append(heroImage, content);
  main.append(hero);
  if (slug) {
    main.append(link("← All collections", "/collections", "back-link"));
    if (resource.type === "Collection") main.append(section(resource, 0));
    else {
      const details = el("section", "manifest-detail");
      details.append(image(resource), link("View IIIF manifest ↗", `${path}/manifest.json`, "text-link"));
      main.append(details);
    }
    return;
  }
  const sections = (resource.items || []).map(section),
    toolbar = el("div", "toolbar"),
    label = el("label", "", "Find your next discovery"),
    search = el("input"),
    status = el("span", "search-status");
  search.type = "search";
  search.placeholder = "Search collections, objects, ideas…";
  label.append(search);
  status.setAttribute("role", "status");
  toolbar.append(label, status);
  const empty = el("p", "empty", "No matching collections. Try another search.");
  empty.hidden = true;
  main.append(toolbar, ...sections, empty);
  const filter = () => {
    const query = search.value.toLocaleLowerCase().trim();
    let visible = 0;
    for (const node of sections) {
      node.hidden = !node.textContent.toLocaleLowerCase().includes(query);
      if (!node.hidden) visible++;
    }
    status.textContent = `${visible} ${visible === 1 ? "collection" : "collections"} to explore`;
    empty.hidden = visible !== 0;
  };
  search.addEventListener("input", filter);
  filter();
}
load().catch((error) => {
  const message = el("p", "loading", error.message);
  message.setAttribute("role", "alert");
  main.replaceChildren(message, link("Reload collections", "/collections", "back-link"));
});
