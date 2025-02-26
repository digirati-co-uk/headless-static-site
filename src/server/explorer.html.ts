import { html } from "hono/html";

export function explorerHtml() {
  return html`<!doctype html>
    <html>
      <head>
        <meta charset="UTF-8" />
        <meta
          name="viewport"
          content="width=device-width, user-scalable=no, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0"
        />
        <meta http-equiv="X-UA-Compatible" content="ie=edge" />
        <script src="https://pkg.csb.dev/digirati-co-uk/iiif-manifest-editor/commit/ee133163/@manifest-editor/iiif-browser/dist-umd/index.umd.js"></script>
        <script src="https://pkg.csb.dev/digirati-co-uk/iiif-manifest-editor/commit/066a3383/@manifest-editor/preview-vault/dist-umd/index.umd.js"></script>
        <link
          rel="stylesheet"
          href="https://pkg.csb.dev/digirati-co-uk/iiif-manifest-editor/commit/ee133163/@manifest-editor/iiif-browser/dist-umd/style.css"
        />
        <title>Headless static site</title>
      </head>
      <body>
        <div id="explorer"></div>
        <script type="module">
          import { create } from "/client.js";
          const helper = create("" + window.location.origin);

          IIIFBrowser.create(document.getElementById("explorer"), {
            entry: {
              id: helper.endpoints.top,
              type: "Collection",
            },
            window: false,
            hideHeader: true,
            outputTypes: ["Manifest", "Canvas", "CanvasRegion"],
            output: { type: "url", resolvable: false },
            outputTargets: [
              {
                type: "open-new-window",
                urlPattern: "https://theseusviewer.org/?iiif-content={MANIFEST}",
                label: "Open in Theseus",
              },
              {
                type: "open-new-window",
                label: "Open Manifest link",
                urlPattern: "{RESULT}",
              },
              {
                type: "open-new-window",
                urlPattern: "https://uv-v4.netlify.app/#?iiifManifestId={MANIFEST}&cv={CANVAS_INDEX}&xywh={XYWH}",
                label: "Open in UV",
              },
              {
                type: "open-new-window",
                label: "Open in Clover",
                urlPattern: "https://samvera-labs.github.io/clover-iiif/?iiif-content={MANIFEST}",
              },
              {
                type: "open-new-window",
                label: "Open in Mirador",
                urlPattern: "https://tomcrane.github.io/scratch/mirador3/index.html?iiif-content={MANIFEST}",
              },
              {
                type: "open-new-window",
                label: "Edit manifest",
                urlPattern: "https://deploy-preview-239--manifest-editor-testing.netlify.app/#manifest={MANIFEST}",
              },
            ],
          });
        </script>
      </body>
    </html> `;
}
