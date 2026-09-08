import { useQuery } from "@tanstack/react-query";
import { CanvasPanel, useVault } from "react-iiif-vault";
import { iiif } from "./lib/iiif";

export function Manifest(props) {
  const vault = useVault();
  const { data } = useQuery({
    queryKey: ["manifest", props.slug],
    queryFn: async () => {
      const manifest = await iiif.loadManifest(props.slug);
      if (manifest.resource) {
        vault.loadManifestSync(manifest.resource.id, JSON.parse(JSON.stringify(manifest.resource)));
      }
      return {
        ...manifest,
        canvasOutput: (await iiif.getCanvasIndex(props.slug)) || [],
      };
    },
  });

  return (
    <div>
      <button onClick={props.onDeselect}>back</button>
      {data && (
        <p>
          Source: {data.links.localJson ? "local generated JSON" : "remote JSON"} —{" "}
          <a href={data.links.json}>{data.links.json}</a>
        </p>
      )}
      {data?.canvasOutput?.some((canvas) => canvas.meta || canvas.files?.length) && (
        <section>
          <h2>Canvas output</h2>
          <ul>
            {data.canvasOutput.map((canvas) => (
              <li key={canvas.id}>
                Canvas {canvas.position + 1}:{" "}
                {[canvas.meta, ...canvas.files].filter(Boolean).map((path) => (
                  <a key={path} href={`/iiif/${props.slug}/${path}`}>
                    {path.split("/").at(-1)}{" "}
                  </a>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}
      {data?.resource && <CanvasPanel manifest={data?.resource?.id} />}
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </div>
  );
}
