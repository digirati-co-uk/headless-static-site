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
      return manifest;
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
      {data?.resource && <CanvasPanel manifest={data?.resource?.id} />}
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </div>
  );
}
